package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/freebuffrt"
)

// Freebuff accounts.
//
// A Freebuff runtime is a runtime whose provider is "freebuff". It holds any
// number of accounts; each is a directory of orchestrator state on this
// machine (see agent.FreebuffAccountDir), and the login lives there.
//
// The daemon's job is small. It does what the user asked for in the web UI and
// reports what it finds:
//
//   - add an account — start the headless orchestrator on a fresh account
//     directory and ask it for a sign-in URL. The URL is the account host's own
//     page, so it opens in a browser on any machine; the daemon forwards it and
//     waits for the sign-in to land, then reports the account as connected;
//   - remove an account — stop its login if one is running and delete its
//     directory, login included;
//   - pick the default — remember which account tasks run on;
//   - refresh — on a timer, ask each account's orchestrator who is signed in.
//
// The server stores what the daemon reports and the web UI reads it back.

// freebuffProvider is the provider value that makes a runtime a Freebuff
// runtime.
const freebuffProvider = "freebuff"

// freebuffStatusInterval is how often the account snapshot is refreshed. Each
// refresh starts an orchestrator, so this is slower than a plain HTTP poll.
var freebuffStatusInterval = 5 * time.Minute

// freebuffConnectPollInterval is how often the daemon asks the server whether
// the user asked for a browser login. The click is a rare event, so the poll
// is cheap; the server also nudges the daemon over the websocket, and this
// poll is the backstop for a lost nudge.
var freebuffConnectPollInterval = 5 * time.Second

// freebuffStatusTimeout bounds one status refresh, orchestrator start included.
var freebuffStatusTimeout = 45 * time.Second

// freebuffLoginTimeout bounds one browser login.
var freebuffLoginTimeout = 6 * time.Minute

// freebuffLoginPollInterval is how often a pending login is checked.
var freebuffLoginPollInterval = 2 * time.Second

// freebuffLogins tracks the sign-ins this daemon has in flight, keyed by
// runtime and account, so a second poll does not start a second login for the
// same account. The value is the cancel function of the login.
var freebuffLogins sync.Map // "runtimeID/accountID" -> context.CancelFunc

// freebuffPins remembers each runtime's engine version pin (the orchestrator
// bundle version tasks run on), keyed by runtime id. The pending poll refresh
// it; every orchestrator launch for that runtime — account flow and task
// backend alike — reads it.
var freebuffPins sync.Map // runtimeID -> string ("" = no pin)

// freebuffEngineVersion returns the pin the server last reported for a
// runtime, or "" when there is none.
func freebuffEngineVersion(runtimeID string) string {
	v, _ := freebuffPins.Load(runtimeID)
	pin, _ := v.(string)
	return pin
}

var freebuffAccountPins sync.Map // runtimeID/accountID -> string

func freebuffAccountEngineVersion(runtimeID, accountID string) string {
	if v, ok := freebuffAccountPins.Load(freebuffLoginKey(runtimeID, accountID)); ok {
		if pin, ok := v.(string); ok && pin != "" {
			return pin
		}
	}
	return freebuffEngineVersion(runtimeID)
}

func freebuffLoginKey(runtimeID, accountID string) string { return runtimeID + "/" + accountID }

// freebuffAccount is the slice of the orchestrator the account flow uses. It
// is satisfied by *freebuffrt.Client and replaced in tests.
type freebuffAccount interface {
	AuthStatus(ctx context.Context) (freebuffrt.AuthStatus, error)
	ModelCatalog(ctx context.Context) (freebuffrt.ModelCatalog, error)
	StartLogin(ctx context.Context) (freebuffrt.LoginStart, error)
	CancelLogin(ctx context.Context) error
	BaseURL() string
	LaunchID() string
	PID() int
}

// startFreebuffAccount launches the orchestrator for one account of a runtime
// and returns its client and a stop function. It is a variable so tests can run
// the account flow without a real orchestrator.
var startFreebuffAccount = func(ctx context.Context, runtimeID, accountID string) (freebuffAccount, func(), error) {
	cfg := agent.Config{RuntimeID: runtimeID, Logger: slog.Default().With("account_id", accountID)}
	if pin := freebuffAccountEngineVersion(runtimeID, accountID); pin != "" {
		cfg.Env = map[string]string{agent.FreebuffEnvAppVersion: pin}
	}
	dir, err := agent.EnsureFreebuffAccountDir(cfg, accountID)
	if err != nil {
		return nil, nil, err
	}
	orch, err := agent.StartFreebuffOrchestrator(ctx, cfg, dir)
	if err != nil {
		return nil, nil, err
	}
	return orch.Client, orch.Stop, nil
}

// freebuffRuntimes returns the Freebuff runtimes this daemon owns.
func (d *Daemon) freebuffRuntimes() []Runtime {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []Runtime
	for _, rt := range d.runtimeIndex {
		if rt.Provider == freebuffProvider {
			out = append(out, rt)
		}
	}
	return out
}

// freebuffLoop keeps the Freebuff accounts in step with what the user asked
// for and refreshes who is signed in.
func (d *Daemon) freebuffLoop(ctx context.Context) {
	pollTicker := time.NewTicker(freebuffConnectPollInterval)
	defer pollTicker.Stop()
	statusTicker := time.NewTicker(freebuffStatusInterval)
	defer statusTicker.Stop()

	// One snapshot at startup so the UI has something to show before the
	// first tick.
	for _, rt := range d.freebuffRuntimes() {
		go d.reportFreebuffAccounts(ctx, rt)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-pollTicker.C:
			for _, rt := range d.freebuffRuntimes() {
				d.syncFreebuffRuntime(ctx, rt)
			}
		case <-statusTicker.C:
			for _, rt := range d.freebuffRuntimes() {
				go d.reportFreebuffAccounts(ctx, rt)
			}
		}
	}
}

// syncFreebuffRuntime asks the server what the user wants done to this
// runtime's accounts and does it.
func (d *Daemon) syncFreebuffRuntime(ctx context.Context, rt Runtime) {
	pending, err := d.client.GetFreebuffPending(ctx, rt.ID)
	if err != nil {
		d.logger.Debug("freebuff pending poll failed", "runtime_id", rt.ID, "error", err)
		return
	}
	freebuffPins.Store(rt.ID, strings.TrimSpace(pending.EngineVersion))
	cfg := agent.Config{RuntimeID: rt.ID}

	removed := false
	for _, acc := range pending.Accounts {
		if !agent.ValidFreebuffAccountID(acc.ID) {
			continue
		}
		key := freebuffLoginKey(rt.ID, acc.ID)
		switch acc.State {
		case "requested", "awaiting_login":
			if _, running := freebuffLogins.Load(key); running {
				continue
			}
			loginCtx, cancel := context.WithCancel(ctx)
			freebuffLogins.Store(key, context.CancelFunc(cancel))
			go func(accountID string) {
				defer freebuffLogins.Delete(key)
				defer cancel()
				d.handleFreebuffLogin(loginCtx, rt, accountID)
			}(acc.ID)
		case "removing":
			stopFreebuffLogin(key)
			if err := agent.RemoveFreebuffAccount(cfg, acc.ID); err != nil {
				d.logger.Warn("freebuff account removal failed", "runtime_id", rt.ID, "account_id", acc.ID, "error", err)
				continue
			}
			removed = true
		}
	}

	if pending.DefaultAccountID != "" && agent.ValidFreebuffAccountID(pending.DefaultAccountID) {
		if ids, _ := agent.ListFreebuffAccounts(cfg); containsString(ids, pending.DefaultAccountID) {
			_ = agent.SetFreebuffDefaultAccount(cfg, pending.DefaultAccountID)
		}
	}
	if removed {
		// Tell the server the accounts are gone so it can drop them.
		d.reportFreebuffAccountsPresent(ctx, rt)
	}
}

// stopFreebuffLogin cancels a running sign-in and waits briefly for its
// orchestrator to go, so the account directory can be deleted under it.
func stopFreebuffLogin(key string) {
	cancel, ok := freebuffLogins.Load(key)
	if !ok {
		return
	}
	cancel.(context.CancelFunc)()
	for i := 0; i < 30; i++ {
		if _, running := freebuffLogins.Load(key); !running {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// freebuffAccountLabel names the signed-in account for display: the email,
// else the name, from the orchestrator's user record.
func freebuffAccountLabel(user json.RawMessage) string {
	var u struct {
		Email string `json:"email"`
		Name  string `json:"name"`
		Login string `json:"login"`
	}
	if json.Unmarshal(user, &u) != nil {
		return ""
	}
	for _, v := range []string{u.Email, u.Name, u.Login} {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

// freebuffAccountReport is one account in a report to the server.
type freebuffAccountReport map[string]any

// freebuffSignedInReport is the report for an account that is signed in.
func freebuffSignedInReport(accountID string, st freebuffrt.AuthStatus) freebuffAccountReport {
	label := freebuffAccountLabel(st.User)
	message := "Signed in to Freebuff"
	if label != "" {
		message = "Signed in as " + label
	}
	return freebuffAccountReport{
		"id":     accountID,
		"state":  "connected",
		"label":  label,
		"status": map[string]any{"message": message},
	}
}

// handleFreebuffLogin signs one account in and reports the URL it produced
// and, later, the outcome. The orchestrator stays up for the whole wait: it is
// the orchestrator that notices the sign-in has happened.
func (d *Daemon) handleFreebuffLogin(ctx context.Context, rt Runtime, accountID string) {
	report := func(entry freebuffAccountReport) {
		d.reportFreebuffEntries(ctx, rt, []freebuffAccountReport{entry}, false)
	}
	fail := func(message string) {
		report(freebuffAccountReport{"id": accountID, "state": "failed", "error": message})
	}

	runCtx, cancel := context.WithTimeout(ctx, freebuffLoginTimeout)
	defer cancel()

	client, stop, err := startFreebuffAccount(runCtx, rt.ID, accountID)
	if err != nil {
		fail(err.Error())
		return
	}
	defer stop()

	// An account that is already signed in needs no login.
	if st, err := client.AuthStatus(runCtx); err == nil && st.Authed {
		report(freebuffSignedInReport(accountID, st))
		return
	}

	login, err := client.StartLogin(runCtx)
	if err != nil {
		fail(err.Error())
		return
	}
	// Prefer the account host's own page: it opens from any machine. The
	// loopback page works only in a browser on this one.
	url := login.RemoteURL
	if url == "" {
		url = login.URL
	}
	if url == "" {
		fail("the Freebuff orchestrator did not return a login URL")
		return
	}
	report(freebuffAccountReport{
		"id":         accountID,
		"state":      "awaiting_login",
		"login_url":  url,
		"expires_at": time.Now().Add(freebuffLoginTimeout).UTC().Format(time.RFC3339),
	})

	ticker := time.NewTicker(freebuffLoginPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-runCtx.Done():
			cancelCtx, c := context.WithTimeout(context.Background(), 5*time.Second)
			_ = client.CancelLogin(cancelCtx)
			c()
			// Removed by the user, or the daemon is shutting down: nobody is
			// waiting to hear about it. Only a timeout is the user's to read.
			if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
				fail("the sign-in was not completed in time; try again for a new link")
			}
			return
		case <-ticker.C:
			st, err := client.AuthStatus(runCtx)
			if err != nil {
				continue
			}
			if st.Authed {
				report(freebuffSignedInReport(accountID, st))
				// The first account becomes the default right away; the server
				// confirms it on the next poll.
				cfg := agent.Config{RuntimeID: rt.ID}
				if ids, _ := agent.ListFreebuffAccounts(cfg); len(ids) == 1 {
					_ = agent.SetFreebuffDefaultAccount(cfg, accountID)
				}
				return
			}
			if st.Login.Phase == "failed" || st.Login.Phase == "error" || st.Login.Phase == "cancelled" {
				fail("the sign-in " + st.Login.Phase)
				return
			}
		}
	}
}

// reportFreebuffAccounts refreshes the state of every account on disk: who is
// signed in. An account that cannot be asked right now (its orchestrator is
// busy running a task, or the bundle is missing) keeps the state the server
// has — it is reported as present, nothing more.
func (d *Daemon) reportFreebuffAccounts(ctx context.Context, rt Runtime) {
	cfg := agent.Config{RuntimeID: rt.ID}
	ids, err := agent.ListFreebuffAccounts(cfg)
	if err != nil {
		d.logger.Debug("freebuff accounts unavailable", "runtime_id", rt.ID, "error", err)
		return
	}
	entries := make([]freebuffAccountReport, 0, len(ids))
	for _, id := range ids {
		if _, signingIn := freebuffLogins.Load(freebuffLoginKey(rt.ID, id)); signingIn {
			entries = append(entries, freebuffAccountReport{"id": id})
			continue
		}
		entries = append(entries, d.freebuffAccountEntry(ctx, rt, id))
	}
	d.reportFreebuffEntries(ctx, rt, entries, true)
}

// freebuffAccountEntry asks one account's orchestrator who is signed in.
func (d *Daemon) freebuffAccountEntry(ctx context.Context, rt Runtime, accountID string) freebuffAccountReport {
	unchanged := freebuffAccountReport{"id": accountID}
	runCtx, cancel := context.WithTimeout(ctx, freebuffStatusTimeout)
	defer cancel()

	client, stop, err := startFreebuffAccount(runCtx, rt.ID, accountID)
	if err != nil {
		// A busy account (a task is using its orchestrator) or a missing
		// bundle is a normal answer, not a daemon failure.
		d.logger.Debug("freebuff account unavailable", "runtime_id", rt.ID, "account_id", accountID, "error", err)
		return unchanged
	}
	defer stop()

	st, err := client.AuthStatus(runCtx)
	if err != nil {
		d.logger.Debug("freebuff account status failed", "runtime_id", rt.ID, "account_id", accountID, "error", err)
		return unchanged
	}
	if !st.Authed {
		return freebuffAccountReport{
			"id":     accountID,
			"state":  "signed_out",
			"status": map[string]any{"message": "Not signed in to Freebuff"},
		}
	}
	return freebuffSignedInReport(accountID, st)
}

// reportFreebuffEntries delivers a report to the server. complete says the
// entries are every account on this machine, so any other the server lists is
// gone from it. Each report carries the version store's current contents so
// the runtime page lists what is installed; the server replaces its mirror
// with what it receives.
func (d *Daemon) reportFreebuffEntries(ctx context.Context, rt Runtime, entries []freebuffAccountReport, complete bool) {
	payload := map[string]any{"accounts": entries, "complete": complete}
	if installed := freebuffrt.InstalledVersions(agent.FreebuffBundleDir(agent.Config{RuntimeID: rt.ID})); installed != nil {
		versions := make([]map[string]string, 0, len(installed))
		for _, in := range installed {
			versions = append(versions, map[string]string{"version": in.Version, "commit": in.Commit})
		}
		payload["versions"] = versions
	}
	d.reportRuntimeResultWithRetry(ctx, "freebuff_account", rt.ID, "", func(ctx context.Context) error {
		return d.client.ReportFreebuffAccount(ctx, rt.ID, payload)
	})
}

// reportFreebuffAccountsPresent tells the server which accounts exist on this
// machine, without asking any of them anything. The server drops the rest.
func (d *Daemon) reportFreebuffAccountsPresent(ctx context.Context, rt Runtime) {
	ids, _ := agent.ListFreebuffAccounts(agent.Config{RuntimeID: rt.ID})
	entries := make([]freebuffAccountReport, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, freebuffAccountReport{"id": id})
	}
	d.reportFreebuffEntries(ctx, rt, entries, true)
}
