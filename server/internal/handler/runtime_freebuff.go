package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	obsmetrics "github.com/multica-ai/multica/server/internal/metrics"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/freebuffrt"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Freebuff accounts.
//
// A Freebuff runtime holds any number of Freebuff accounts. Each account's
// login lives on the daemon's machine: the token is stored there, and the
// daemon is what turns "add an account" into a one-time login URL. The server
// keeps the list in the runtime's metadata (`metadata.freebuff`) so the web UI
// can show it without a second round trip.
//
// Two actors write the list and they do not share a clock:
//
//   - the user asks for changes — add an account, remove one, pick the default
//     — and the server records the request as an account state ("requested",
//     "removing") or a field (`default_account_id`);
//   - the daemon does the work and reports what it found: the account's login
//     state, who is signed in, and what the account is worth.
//
// Every write is a read-modify-write of the whole block under a row lock, so a
// report that lands between two clicks cannot erase the second click.

// FreebuffProvider is the provider (protocol family) that makes a runtime a
// Freebuff runtime. The daemon recognises the same value.
const FreebuffProvider = "freebuff"

// Freebuff account states.
const (
	// FreebuffAccountRequested: the user added the account; the daemon has not
	// started its login yet.
	FreebuffAccountRequested = "requested"
	// FreebuffAccountAwaitingLogin: the daemon produced a login URL and is
	// waiting for the browser to confirm it.
	FreebuffAccountAwaitingLogin = "awaiting_login"
	// FreebuffAccountConnected: the account is signed in.
	FreebuffAccountConnected = "connected"
	// FreebuffAccountSignedOut: the account exists on the daemon but is not
	// signed in (the token expired or was revoked).
	FreebuffAccountSignedOut = "signed_out"
	// FreebuffAccountFailed: the last login attempt failed; Error says why.
	FreebuffAccountFailed = "failed"
	// FreebuffAccountRemoving: the user removed the account; the daemon has not
	// deleted its login yet.
	FreebuffAccountRemoving = "removing"
)

// maxFreebuffAccounts bounds the list a runtime can hold.
const maxFreebuffAccounts = 8

// FreebuffAccount is one account in a Freebuff runtime's list.
type FreebuffAccount struct {
	ID string `json:"id"`
	// Label names the signed-in account for display (its email or name).
	Label string `json:"label,omitempty"`
	State string `json:"state"`
	// LoginURL is the one-time URL the user opens, in any browser, to sign in.
	// Present while State is "awaiting_login".
	LoginURL string `json:"login_url,omitempty"`
	// ExpiresAt is when that URL stops working.
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	// Error explains a "failed" state.
	Error string `json:"error,omitempty"`
	// Status is what the account is worth right now. It stays raw JSON: the
	// daemon owns that shape, and re-declaring it here would let the two drift.
	Status      json.RawMessage `json:"status,omitempty"`
	RequestedAt *time.Time      `json:"requested_at,omitempty"`
	UpdatedAt   *time.Time      `json:"updated_at,omitempty"`
}

// FreebuffVersion is one orchestrator bundle installed on the daemon's
// machine, as the runtime page shows it.
type FreebuffVersion struct {
	Version string `json:"version"`
	// Commit is the build the bundle was made from, when known.
	Commit string `json:"commit,omitempty"`
}

// FreebuffBlock is the stored shape of the runtime's `metadata.freebuff` key.
type FreebuffBlock struct {
	Accounts []FreebuffAccount `json:"accounts"`
	// DefaultAccountID is the account tasks run on.
	DefaultAccountID string `json:"default_account_id,omitempty"`
	// EngineVersion pins the orchestrator bundle version tasks run on. Empty
	// means the daemon's default bundle. The daemon applies the pin when it
	// next reads its pending state, so a change lands on the next run.
	EngineVersion string `json:"engine_version,omitempty"`
	// InstalledVersions is what the daemon last reported having under its
	// version store, oldest first. The daemon owns the list; the server only
	// mirrors it.
	InstalledVersions []FreebuffVersion `json:"installed_versions"`
	// UpdatedAt is when the daemon last reported.
	UpdatedAt *time.Time `json:"updated_at,omitempty"`
}

// freebuffBlockFromRuntime extracts the Freebuff block from a runtime row's
// metadata. A runtime that never reported one yields an empty block, not an
// error: "no accounts yet" is a state the UI renders, not a failure.
func freebuffBlockFromRuntime(rt db.AgentRuntime) *FreebuffBlock {
	return freebuffBlockFromMetadata(rt.Metadata)
}

func freebuffBlockFromMetadata(raw []byte) *FreebuffBlock {
	block := &FreebuffBlock{Accounts: []FreebuffAccount{}}
	if len(raw) == 0 {
		return block
	}
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(raw, &metadata); err != nil {
		return block
	}
	stored, ok := metadata["freebuff"]
	if !ok || len(stored) == 0 {
		return block
	}
	if err := json.Unmarshal(stored, block); err != nil {
		return &FreebuffBlock{Accounts: []FreebuffAccount{}}
	}
	if block.Accounts == nil {
		block.Accounts = []FreebuffAccount{}
	}
	return block
}

func (b *FreebuffBlock) find(id string) int {
	for i := range b.Accounts {
		if b.Accounts[i].ID == id {
			return i
		}
	}
	return -1
}

// fixDefault keeps DefaultAccountID pointing at a usable account: the current
// one if it still is, else the first connected account, else none.
func (b *FreebuffBlock) fixDefault() {
	if i := b.find(b.DefaultAccountID); i >= 0 && b.Accounts[i].State == FreebuffAccountConnected {
		return
	}
	b.DefaultAccountID = ""
	for _, a := range b.Accounts {
		if a.State == FreebuffAccountConnected {
			b.DefaultAccountID = a.ID
			return
		}
	}
}

// freebuffReportedAccount is one account as the daemon reports it. An empty
// State means the account exists but the daemon could not ask it.
type freebuffReportedAccount struct {
	ID        string          `json:"id"`
	Label     string          `json:"label"`
	State     string          `json:"state"`
	LoginURL  string          `json:"login_url"`
	ExpiresAt json.RawMessage `json:"expires_at"`
	Error     string          `json:"error"`
	Status    json.RawMessage `json:"status"`
}

// freebuffReport is the daemon's report.
type freebuffReport struct {
	Accounts []freebuffReportedAccount `json:"accounts"`
	// Complete says the report lists every account the daemon has, so an
	// account missing from it is gone from the daemon's machine.
	Complete bool `json:"complete"`
	// Versions is the full list of orchestrator bundles in the daemon's
	// version store. Always replaced wholesale: the daemon owns the list.
	Versions []FreebuffVersion `json:"versions,omitempty"`
}

func validFreebuffReportedState(state string) bool {
	switch state {
	case FreebuffAccountAwaitingLogin, FreebuffAccountConnected,
		FreebuffAccountSignedOut, FreebuffAccountFailed:
		return true
	}
	return false
}

// applyFreebuffReport merges the daemon's report into the block.
//
// The daemon never reports "requested" or "removing": those are the user's
// requests, and the daemon answers them by moving the account to another state
// (or by deleting it). So a request the daemon has not seen yet survives a
// report that does not mention it.
func applyFreebuffReport(block *FreebuffBlock, report freebuffReport, now time.Time) {
	seen := make(map[string]bool, len(report.Accounts))
	for _, in := range report.Accounts {
		// A state-less entry says "this account exists" and nothing more: the
		// daemon could not ask it right now.
		if in.ID == "" || (in.State != "" && !validFreebuffReportedState(in.State)) {
			continue
		}
		seen[in.ID] = true
		i := block.find(in.ID)
		if i < 0 {
			block.Accounts = append(block.Accounts, FreebuffAccount{ID: in.ID, State: FreebuffAccountSignedOut})
			i = len(block.Accounts) - 1
		}
		acc := &block.Accounts[i]
		if acc.State == FreebuffAccountRemoving || in.State == "" {
			// Removing: the user already removed it and the daemon has not
			// caught up. Stateless: nothing to merge.
			continue
		}
		acc.State = in.State
		if in.Label != "" {
			acc.Label = in.Label
		}
		acc.Error = ""
		acc.LoginURL = ""
		acc.ExpiresAt = nil
		switch in.State {
		case FreebuffAccountAwaitingLogin:
			acc.LoginURL = in.LoginURL
			if expires, ok := parseFreebuffExpiresAt(in.ExpiresAt); ok {
				acc.ExpiresAt = &expires
			}
		case FreebuffAccountFailed:
			acc.Error = in.Error
		}
		if len(in.Status) > 0 && string(in.Status) != "null" {
			acc.Status = in.Status
		}
		t := now
		acc.UpdatedAt = &t
	}

	if report.Complete {
		kept := block.Accounts[:0]
		for _, acc := range block.Accounts {
			if seen[acc.ID] || acc.State == FreebuffAccountRequested {
				kept = append(kept, acc)
			}
		}
		block.Accounts = kept
	}
	t := now
	block.UpdatedAt = &t
	block.InstalledVersions = report.Versions
	if block.EngineVersion != "" {
		// The pin must point at a bundle the daemon still has; a report that
		// no longer lists it would otherwise leave tasks failing to resolve.
		installed := false
		for _, v := range report.Versions {
			if v.Version == block.EngineVersion {
				installed = true
				break
			}
		}
		if !installed {
			block.EngineVersion = ""
		}
	}
	block.fixDefault()
}

// parseFreebuffExpiresAt reads the expiry of a one-time login URL. It
// accepts an RFC 3339 instant (what the API speaks) and epoch milliseconds
// (what the account host reports).
func parseFreebuffExpiresAt(raw json.RawMessage) (time.Time, bool) {
	if len(raw) == 0 {
		return time.Time{}, false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if parsed, err := time.Parse(time.RFC3339, text); err == nil {
			return parsed.UTC(), true
		}
		return time.Time{}, false
	}
	var millis int64
	if err := json.Unmarshal(raw, &millis); err == nil && millis > 0 {
		return time.UnixMilli(millis).UTC(), true
	}
	return time.Time{}, false
}

func newFreebuffAccountID() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return "a" + hex.EncodeToString(b[:])
}

// updateFreebuffBlock reads the runtime's block under a row lock, lets mutate
// change it, and stores the result. mutate returns false to leave the block
// untouched; its error is returned to the caller as is.
func (h *Handler) updateFreebuffBlock(r *http.Request, rt db.AgentRuntime, mutate func(*FreebuffBlock) (bool, error)) (*FreebuffBlock, error) {
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var metadata []byte
	if err := tx.QueryRow(ctx, `SELECT metadata FROM agent_runtime WHERE id = $1 FOR UPDATE`, rt.ID).Scan(&metadata); err != nil {
		return nil, err
	}
	block := freebuffBlockFromMetadata(metadata)
	changed, err := mutate(block)
	if err != nil || !changed {
		return block, err
	}
	payload, err := json.Marshal(block)
	if err != nil {
		return nil, err
	}
	if err := h.Queries.WithTx(tx).SetAgentRuntimeFreebuffMetadata(ctx, db.SetAgentRuntimeFreebuffMetadataParams{
		Payload: payload,
		ID:      rt.ID,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return block, nil
}

// GetFreebuffAccount returns the Freebuff accounts the runtime holds. The read
// is cheap (the block rides along in the runtime row) and is meant to be
// polled by the runtime page while a login is in flight.
func (h *Handler) GetFreebuffAccount(w http.ResponseWriter, r *http.Request) {
	rt, _, ok := h.requireRuntimeReadAccess(w, r, obsmetrics.RuntimeLookupSourceRuntimeAPI, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	if rt.Provider != FreebuffProvider {
		writeError(w, http.StatusNotFound, "runtime is not a Freebuff runtime")
		return
	}
	writeJSON(w, http.StatusOK, freebuffBlockFromRuntime(rt))
}

// AddFreebuffAccount adds an account to the runtime. The account starts as
// "requested"; the daemon starts its login and reports the URL to open.
func (h *Handler) AddFreebuffAccount(w http.ResponseWriter, r *http.Request) {
	rt, _, ok := h.requireRuntimeReadAccess(w, r, obsmetrics.RuntimeLookupSourceRuntimeAPI, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	if rt.Provider != FreebuffProvider {
		writeError(w, http.StatusNotFound, "runtime is not a Freebuff runtime")
		return
	}
	if rt.Status != "online" {
		writeError(w, http.StatusServiceUnavailable, "runtime is offline")
		return
	}

	now := time.Now()
	account := FreebuffAccount{
		ID:          newFreebuffAccountID(),
		State:       FreebuffAccountRequested,
		RequestedAt: &now,
		UpdatedAt:   &now,
	}
	tooMany := false
	if _, err := h.updateFreebuffBlock(r, rt, func(b *FreebuffBlock) (bool, error) {
		if len(b.Accounts) >= maxFreebuffAccounts {
			tooMany = true
			return false, nil
		}
		b.Accounts = append(b.Accounts, account)
		return true, nil
	}); err != nil {
		slog.Warn("freebuff add account failed", "runtime_id", uuidToString(rt.ID), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to add the account")
		return
	}
	if tooMany {
		writeError(w, http.StatusConflict, "this runtime already has the maximum number of Freebuff accounts")
		return
	}

	h.requestDaemonPendingWork(uuidToString(rt.ID), protocol.PendingWorkKindFreebuff)
	writeJSON(w, http.StatusAccepted, account)
}

// RemoveFreebuffAccount removes an account. An account the daemon never
// started is dropped at once; any other is marked "removing" and the daemon
// deletes its login from the machine.
func (h *Handler) RemoveFreebuffAccount(w http.ResponseWriter, r *http.Request) {
	rt, _, ok := h.requireRuntimeReadAccess(w, r, obsmetrics.RuntimeLookupSourceRuntimeAPI, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	accountID := chi.URLParam(r, "accountId")
	found := false
	if _, err := h.updateFreebuffBlock(r, rt, func(b *FreebuffBlock) (bool, error) {
		i := b.find(accountID)
		if i < 0 {
			return false, nil
		}
		found = true
		if b.Accounts[i].State == FreebuffAccountRequested {
			b.Accounts = append(b.Accounts[:i], b.Accounts[i+1:]...)
		} else {
			now := time.Now()
			b.Accounts[i].State = FreebuffAccountRemoving
			b.Accounts[i].LoginURL = ""
			b.Accounts[i].ExpiresAt = nil
			b.Accounts[i].UpdatedAt = &now
		}
		// A removing account cannot stay the default.
		if b.DefaultAccountID == accountID {
			b.DefaultAccountID = ""
			for _, a := range b.Accounts {
				if a.State == FreebuffAccountConnected && a.ID != accountID {
					b.DefaultAccountID = a.ID
					break
				}
			}
		}
		return true, nil
	}); err != nil {
		slog.Warn("freebuff remove account failed", "runtime_id", uuidToString(rt.ID), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to remove the account")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "account not found")
		return
	}

	h.requestDaemonPendingWork(uuidToString(rt.ID), protocol.PendingWorkKindFreebuff)
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "removing"})
}

// RetryFreebuffAccountLogin starts a new sign-in for an account that is signed
// out, failed, or whose link ran out.
func (h *Handler) RetryFreebuffAccountLogin(w http.ResponseWriter, r *http.Request) {
	rt, _, ok := h.requireRuntimeReadAccess(w, r, obsmetrics.RuntimeLookupSourceRuntimeAPI, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	accountID := chi.URLParam(r, "accountId")
	found := false
	if _, err := h.updateFreebuffBlock(r, rt, func(b *FreebuffBlock) (bool, error) {
		i := b.find(accountID)
		if i < 0 || b.Accounts[i].State == FreebuffAccountRemoving {
			return false, nil
		}
		found = true
		now := time.Now()
		acc := &b.Accounts[i]
		acc.State = FreebuffAccountRequested
		acc.LoginURL, acc.Error, acc.ExpiresAt = "", "", nil
		acc.RequestedAt, acc.UpdatedAt = &now, &now
		return true, nil
	}); err != nil {
		slog.Warn("freebuff retry login failed", "runtime_id", uuidToString(rt.ID), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to restart the sign-in")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "account not found")
		return
	}
	h.requestDaemonPendingWork(uuidToString(rt.ID), protocol.PendingWorkKindFreebuff)
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "requested"})
}

// SetFreebuffDefaultAccount picks the account tasks run on.
func (h *Handler) SetFreebuffDefaultAccount(w http.ResponseWriter, r *http.Request) {
	rt, _, ok := h.requireRuntimeReadAccess(w, r, obsmetrics.RuntimeLookupSourceRuntimeAPI, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	accountID := chi.URLParam(r, "accountId")
	notConnected := false
	block, err := h.updateFreebuffBlock(r, rt, func(b *FreebuffBlock) (bool, error) {
		i := b.find(accountID)
		if i < 0 || b.Accounts[i].State != FreebuffAccountConnected {
			notConnected = true
			return false, nil
		}
		b.DefaultAccountID = accountID
		return true, nil
	})
	if err != nil {
		slog.Warn("freebuff set default failed", "runtime_id", uuidToString(rt.ID), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to set the default account")
		return
	}
	if notConnected {
		writeError(w, http.StatusConflict, "only a signed-in account can be the default")
		return
	}

	h.requestDaemonPendingWork(uuidToString(rt.ID), protocol.PendingWorkKindFreebuff)
	writeJSON(w, http.StatusOK, block)
}

// ReportFreebuffAccount is the daemon's report of a runtime's Freebuff
// accounts. Daemon-authenticated.
func (h *Handler) ReportFreebuffAccount(w http.ResponseWriter, r *http.Request) {
	rt, ok := h.requireDaemonRuntimeAccess(w, r, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	var report freebuffReport
	if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if _, err := h.updateFreebuffBlock(r, rt, func(b *FreebuffBlock) (bool, error) {
		applyFreebuffReport(b, report, time.Now())
		return true, nil
	}); err != nil {
		slog.Warn("freebuff report failed", "runtime_id", uuidToString(rt.ID), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to store the freebuff report")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// SetFreebuffEngineVersion pins the orchestrator bundle version tasks run on.
// An empty version clears the pin, returning the runtime to the daemon's
// default bundle. The daemon picks the pin up through its pending poll, so a
// change applies on the next run, not the one in flight.
func (h *Handler) SetFreebuffEngineVersion(w http.ResponseWriter, r *http.Request) {
	rt, _, ok := h.requireRuntimeReadAccess(w, r, obsmetrics.RuntimeLookupSourceRuntimeAPI, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	if rt.Provider != FreebuffProvider {
		writeError(w, http.StatusNotFound, "runtime is not a Freebuff runtime")
		return
	}
	var body struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Version != "" {
		if err := freebuffrt.ValidateVersion(body.Version); err != nil {
			writeError(w, http.StatusBadRequest, "invalid engine version")
			return
		}
	}
	notInstalled := false
	block, err := h.updateFreebuffBlock(r, rt, func(b *FreebuffBlock) (bool, error) {
		if body.Version != "" && len(b.InstalledVersions) > 0 {
			installed := false
			for _, v := range b.InstalledVersions {
				if v.Version == body.Version {
					installed = true
					break
				}
			}
			if !installed {
				notInstalled = true
				return false, nil
			}
		}
		if b.EngineVersion == body.Version {
			return false, nil
		}
		b.EngineVersion = body.Version
		return true, nil
	})
	if err != nil {
		slog.Warn("freebuff set engine version failed", "runtime_id", uuidToString(rt.ID), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to set the engine version")
		return
	}
	if notInstalled {
		writeError(w, http.StatusConflict, "that engine version is not installed on the runtime")
		return
	}

	h.requestDaemonPendingWork(uuidToString(rt.ID), protocol.PendingWorkKindFreebuff)
	writeJSON(w, http.StatusOK, block)
}

// GetFreebuffPending answers the daemon's question "what did the user ask
// for?". It is daemon-authenticated and read-only.
//
// The daemon polls this rather than receiving the request in a heartbeat
// acknowledgement: the request lives in the runtime row's metadata, and the
// WebSocket heartbeat path never reads that row. A poll is also the shape that
// survives a lost wakeup hint — the server nudges the daemon over the
// websocket, and the daemon's own poll is the backstop.
func (h *Handler) GetFreebuffPending(w http.ResponseWriter, r *http.Request) {
	rt, ok := h.requireDaemonRuntimeAccess(w, r, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	block := freebuffBlockFromRuntime(rt)
	pending := make([]map[string]string, 0)
	for _, acc := range block.Accounts {
		switch acc.State {
		case FreebuffAccountRequested, FreebuffAccountAwaitingLogin, FreebuffAccountRemoving:
			pending = append(pending, map[string]string{"id": acc.ID, "state": acc.State})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accounts":           pending,
		"default_account_id": block.DefaultAccountID,
		"engine_version":     block.EngineVersion,
	})
}
