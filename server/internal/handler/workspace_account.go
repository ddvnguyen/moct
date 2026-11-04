package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/pkg/agent"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/freebuffrt"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Workspace accounts (M-153).
//
// An account is a workspace-level identity a freebuff-desktop agent can run
// against: a label, the Freebuff Desktop endpoint to talk to, and a
// credential_ref the DAEMON resolves on its own machine (a token file or home
// directory name). The reference is never a secret and no secret is stored; it
// is still returned to workspace admins only, because it names a path on a
// member's machine.
//
// Reads are open to every member (the agent pickers need the list). Writes are
// owner/admin only; the router gates them and each handler re-checks.

// WorkspaceAccountResponse is the wire shape of an account.
type WorkspaceAccountResponse struct {
	ID              string          `json:"id"`
	WorkspaceID     string          `json:"workspace_id"`
	Provider        string          `json:"provider"`
	Label           string          `json:"label"`
	Endpoint        string          `json:"endpoint,omitempty"`
	Enabled         bool            `json:"enabled"`
	CredentialRef   string          `json:"credential_ref,omitempty"`
	State           string          `json:"state,omitempty"`
	LoginURL        string          `json:"login_url,omitempty"`
	ExpiresAt       string          `json:"expires_at,omitempty"`
	Error           string          `json:"error,omitempty"`
	Status          json.RawMessage `json:"status,omitempty"`
	DaemonAccountID string          `json:"daemon_account_id,omitempty"`
	RuntimeID       string          `json:"runtime_id,omitempty"`
	EngineVersion   string          `json:"engine_version"`
	CreatedAt       string          `json:"created_at"`
	UpdatedAt       string          `json:"updated_at"`
}

func workspaceAccountToResponse(a db.WorkspaceAccount, includeAdminDetails bool) WorkspaceAccountResponse {
	resp := WorkspaceAccountResponse{
		ID:            uuidToString(a.ID),
		WorkspaceID:   uuidToString(a.WorkspaceID),
		Provider:      a.Provider,
		Label:         a.Label,
		Enabled:       a.Enabled,
		EngineVersion: a.EngineVersion,
		State:         a.State,
		CreatedAt:     timestampToString(a.CreatedAt),
		UpdatedAt:     timestampToString(a.UpdatedAt),
	}
	if a.Endpoint.Valid {
		resp.Endpoint = a.Endpoint.String
	}
	if includeAdminDetails && a.CredentialRef.Valid {
		resp.CredentialRef = a.CredentialRef.String
	}
	if includeAdminDetails && a.LoginUrl.Valid {
		resp.LoginURL = a.LoginUrl.String
	}
	if includeAdminDetails && a.ExpiresAt.Valid {
		resp.ExpiresAt = a.ExpiresAt.Time.UTC().Format(time.RFC3339)
	}
	if includeAdminDetails && a.Error.Valid {
		resp.Error = a.Error.String
	}
	if includeAdminDetails && len(a.Status) > 0 {
		resp.Status = json.RawMessage(a.Status)
	}
	if includeAdminDetails && a.DaemonAccountID.Valid {
		resp.DaemonAccountID = a.DaemonAccountID.String
	}
	if a.RuntimeID.Valid {
		resp.RuntimeID = uuidToString(a.RuntimeID)
	}
	return resp
}

// validateAccountEndpoint accepts an empty endpoint (the bridge default) or an
// absolute http(s) URL.
func validateAccountEndpoint(endpoint string) error {
	if endpoint == "" {
		return nil
	}
	u, err := url.Parse(endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("endpoint must be an http(s) URL")
	}
	return nil
}

func optionalText(s string) pgtype.Text {
	s = strings.TrimSpace(s)
	return pgtype.Text{String: s, Valid: s != ""}
}

func isAccountLabelConflict(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// ListWorkspaceAccounts lists the workspace's accounts.
func (h *Handler) ListWorkspaceAccounts(w http.ResponseWriter, r *http.Request) {
	wsID := strings.TrimSpace(chi.URLParam(r, "id"))
	member, ok := h.requireWorkspaceMember(w, r, wsID, "workspace not found")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, wsID, "workspace id")
	if !ok {
		return
	}
	accounts, err := h.Queries.ListWorkspaceAccounts(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list accounts")
		return
	}
	admin := roleAllowed(member.Role, "owner", "admin")
	out := make([]WorkspaceAccountResponse, 0, len(accounts))
	for _, a := range accounts {
		out = append(out, workspaceAccountToResponse(a, admin))
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": out})
}

// CreateWorkspaceAccount adds an account (owner/admin).
func (h *Handler) CreateWorkspaceAccount(w http.ResponseWriter, r *http.Request) {
	wsID := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, ok := h.requireWorkspaceRole(w, r, wsID, "workspace not found", "owner", "admin"); !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, wsID, "workspace id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req struct {
		Provider      string `json:"provider"`
		Label         string `json:"label"`
		Endpoint      string `json:"endpoint"`
		CredentialRef string `json:"credential_ref"`
		Enabled       *bool  `json:"enabled"`
		Managed       bool   `json:"managed"`
		RuntimeID     string `json:"runtime_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	provider := strings.TrimSpace(req.Provider)
	if provider == "" {
		provider = accountProviderFreebuffDesktop
	}
	if provider != accountProviderFreebuffDesktop {
		writeError(w, http.StatusBadRequest, "unsupported account provider")
		return
	}

	if req.Managed {
		rid := strings.TrimSpace(req.RuntimeID)
		if rid == "" {
			writeError(w, http.StatusBadRequest, "runtime_id is required for managed accounts")
			return
		}
		rtUUID, ok := parseUUIDOrBadRequest(w, rid, "runtime id")
		if !ok {
			return
		}
		// validate runtime belongs to workspace and is a freebuff-desktop (codebuddy) runtime
		var rtProvider, rtStatus, rtCommand string
		var rtWorkspace pgtype.UUID
		err := h.DB.QueryRow(r.Context(), `SELECT rt.workspace_id, rt.provider, rt.status, p.command_name
			FROM agent_runtime rt JOIN runtime_profile p ON p.id=rt.profile_id AND p.workspace_id=rt.workspace_id
			WHERE rt.id=$1`, rtUUID).Scan(&rtWorkspace, &rtProvider, &rtStatus, &rtCommand)
		if err != nil || uuidToString(rtWorkspace) != wsID || rtProvider != accountRuntimeProvider || rtStatus != "online" || !strings.HasPrefix(strings.ToLower(rtCommand), "freebuff-desktop") {
			writeError(w, http.StatusBadRequest, "runtime is not an online freebuff-desktop runtime in this workspace")
			return
		}
		daemonAccountID := newFreebuffAccountID()
		label := strings.TrimSpace(req.Label)
		if label == "" {
			label = "Pending sign-in (" + daemonAccountID + ")"
		}
		created, err := h.insertManagedWorkspaceAccount(r, wsUUID, label, daemonAccountID, userID, rid)
		if err != nil {
			if isAccountLabelConflict(err) {
				writeError(w, http.StatusConflict, "an account with this label already exists")
				return
			}
			slog.Warn("managed account create failed", "workspace_id", wsID, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to create account")
			return
		}
		if rid := strings.TrimSpace(req.RuntimeID); rid != "" {
			h.requestDaemonPendingWork(rid, protocol.PendingWorkKindFreebuffDesktop)
		}
		writeJSON(w, http.StatusAccepted, workspaceAccountToResponse(created, true))
		return
	}

	label := strings.TrimSpace(req.Label)
	if label == "" {
		writeError(w, http.StatusBadRequest, "label is required")
		return
	}
	endpoint := strings.TrimSpace(req.Endpoint)
	if err := validateAccountEndpoint(endpoint); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Auto-generate a credential_ref when the user does not supply one, so
	// account creation needs only a label (M-199 UX improvement). The daemon
	// resolves this name on its own machine; nothing secret travels here.
	credentialRef := strings.TrimSpace(req.CredentialRef)
	if credentialRef == "" {
		credentialRef = "freebuff-desktop-" + uuidToString(wsUUID) + "-" + strings.ToLower(strings.ReplaceAll(label, " ", "-"))
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	created, err := h.Queries.CreateWorkspaceAccount(r.Context(), db.CreateWorkspaceAccountParams{
		WorkspaceID:   wsUUID,
		Provider:      provider,
		Label:         label,
		Endpoint:      optionalText(endpoint),
		CredentialRef: optionalText(credentialRef),
		Enabled:       enabled,
		CreatedBy:     parseUUID(userID),
	})
	if err != nil {
		if isAccountLabelConflict(err) {
			writeError(w, http.StatusConflict, "an account with this label already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to create account")
		return
	}
	writeJSON(w, http.StatusCreated, workspaceAccountToResponse(created, true))
}

// UpdateWorkspaceAccount edits an account (owner/admin). Omitted fields keep
// their value.
func (h *Handler) UpdateWorkspaceAccount(w http.ResponseWriter, r *http.Request) {
	wsID := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, ok := h.requireWorkspaceRole(w, r, wsID, "workspace not found", "owner", "admin"); !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, wsID, "workspace id")
	if !ok {
		return
	}
	accUUID, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(chi.URLParam(r, "accountId")), "account id")
	if !ok {
		return
	}
	existing, err := h.Queries.GetWorkspaceAccountInWorkspace(r.Context(), db.GetWorkspaceAccountInWorkspaceParams{
		ID: accUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "account not found")
		return
	}
	var req struct {
		Label         *string `json:"label"`
		Endpoint      *string `json:"endpoint"`
		CredentialRef *string `json:"credential_ref"`
		Enabled       *bool   `json:"enabled"`
		Retry         bool    `json:"retry"`
		EngineVersion *string `json:"engine_version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Retry && req.EngineVersion != nil {
		writeError(w, http.StatusBadRequest, "retry and engine_version cannot be combined")
		return
	}
	if req.Retry {
		if !existing.DaemonAccountID.Valid || !existing.RuntimeID.Valid || (existing.State != "failed" && existing.State != "signed_out") {
			writeError(w, http.StatusBadRequest, "account cannot be retried in its current state")
			return
		}
		retried, err := h.Queries.RetryManagedWorkspaceAccount(r.Context(), db.RetryManagedWorkspaceAccountParams{
			ID: existing.ID, RuntimeID: existing.RuntimeID,
		})
		if err != nil {
			writeError(w, http.StatusConflict, "account cannot be retried in its current state")
			return
		}
		h.requestDaemonPendingWork(uuidToString(existing.RuntimeID), protocol.PendingWorkKindFreebuffDesktop)
		writeJSON(w, http.StatusAccepted, workspaceAccountToResponse(retried, true))
		return
	}
	params := db.UpdateWorkspaceAccountParams{
		ID:            existing.ID,
		Label:         existing.Label,
		Endpoint:      existing.Endpoint,
		CredentialRef: existing.CredentialRef,
		Enabled:       existing.Enabled,
	}
	if req.Label != nil {
		label := strings.TrimSpace(*req.Label)
		if label == "" {
			writeError(w, http.StatusBadRequest, "label must not be empty")
			return
		}
		params.Label = label
	}
	if req.Endpoint != nil {
		endpoint := strings.TrimSpace(*req.Endpoint)
		if err := validateAccountEndpoint(endpoint); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		params.Endpoint = optionalText(endpoint)
	}
	if req.CredentialRef != nil {
		params.CredentialRef = optionalText(*req.CredentialRef)
	}
	if req.Enabled != nil {
		params.Enabled = *req.Enabled
	}
	if req.EngineVersion != nil {
		if !existing.DaemonAccountID.Valid || existing.DaemonAccountID.String == "" || !existing.RuntimeID.Valid {
			writeError(w, http.StatusBadRequest, "engine version requires a daemon-managed account")
			return
		}
		version := *req.EngineVersion
		if version != "" {
			if err := freebuffrt.ValidateVersion(version); err != nil {
				writeError(w, http.StatusBadRequest, "invalid engine version")
				return
			}
			var metadata []byte
			if err := h.DB.QueryRow(r.Context(), `SELECT metadata FROM agent_runtime WHERE id=$1 AND workspace_id=$2`, existing.RuntimeID, wsUUID).Scan(&metadata); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to load runtime versions")
				return
			}
			versions := freebuffBlockFromMetadata(metadata).InstalledVersions
			if versions != nil {
				found := false
				for _, installed := range versions {
					if installed.Version == version {
						found = true
						break
					}
				}
				if !found {
					writeError(w, http.StatusConflict, "that engine version is not installed on the runtime")
					return
				}
			}
		}
		params.EngineVersion = pgtype.Text{String: version, Valid: true}
	}
	updated, err := h.Queries.UpdateWorkspaceAccount(r.Context(), params)
	if err != nil {
		if isAccountLabelConflict(err) {
			writeError(w, http.StatusConflict, "an account with this label already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update account")
		return
	}
	if req.EngineVersion != nil {
		h.requestDaemonPendingWork(uuidToString(existing.RuntimeID), protocol.PendingWorkKindFreebuffDesktop)
	}
	writeJSON(w, http.StatusOK, workspaceAccountToResponse(updated, true))
}

// DeleteWorkspaceAccount removes an account (owner/admin). The account must
// belong to the URL's workspace; agents that selected it fall back to the
// default account setting in the same transaction.
func (h *Handler) DeleteWorkspaceAccount(w http.ResponseWriter, r *http.Request) {
	wsID := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, ok := h.requireWorkspaceRole(w, r, wsID, "workspace not found", "owner", "admin"); !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, wsID, "workspace id")
	if !ok {
		return
	}
	accUUID, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(chi.URLParam(r, "accountId")), "account id")
	if !ok {
		return
	}
	// Ownership first: nothing below may touch another workspace's rows.
	existing, err := h.Queries.GetWorkspaceAccountInWorkspace(r.Context(), db.GetWorkspaceAccountInWorkspaceParams{
		ID: accUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "account not found")
		return
	}
	if existing.DaemonAccountID.Valid && existing.RuntimeID.Valid {
		tag, err := h.DB.Exec(r.Context(), `UPDATE workspace_account
			SET state='removing', enabled=FALSE, login_url=NULL, error=NULL, updated_at=now()
			WHERE id=$1 AND workspace_id=$2 AND runtime_id=$3 AND daemon_account_id=$4`,
			existing.ID, wsUUID, existing.RuntimeID, existing.DaemonAccountID)
		if err != nil || tag.RowsAffected() != 1 {
			writeError(w, http.StatusInternalServerError, "failed to request account removal")
			return
		}
		h.requestDaemonPendingWork(uuidToString(existing.RuntimeID), protocol.PendingWorkKindFreebuffDesktop)
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "removing"})
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if err := qtx.DemoteAgentsOnAccountDelete(r.Context(), accUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update agents")
		return
	}
	if err := qtx.DeleteWorkspaceAccount(r.Context(), accUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete account")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// insertManagedWorkspaceAccount creates a daemon-managed account row in the
// "requested" state.
func (h *Handler) insertManagedWorkspaceAccount(r *http.Request, wsUUID pgtype.UUID, label, daemonAccountID, userID, runtimeID string) (db.WorkspaceAccount, error) {
	ctx := r.Context()
	rtUUID := parseUUID(runtimeID)
	var acc db.WorkspaceAccount
	err := h.DB.QueryRow(ctx, `
		INSERT INTO workspace_account (
			workspace_id, provider, label, enabled, created_by, state, daemon_account_id, runtime_id
		) VALUES ($1, $2, $3, TRUE, $4, 'requested', $5, $6)
		RETURNING id, workspace_id, provider, label, endpoint, credential_ref, enabled, created_by, created_at, updated_at, state, login_url, expires_at, error, status, daemon_account_id, runtime_id, engine_version`,
		wsUUID, accountProviderFreebuffDesktop, label, parseUUID(userID), daemonAccountID, rtUUID,
	).Scan(
		&acc.ID, &acc.WorkspaceID, &acc.Provider, &acc.Label, &acc.Endpoint, &acc.CredentialRef,
		&acc.Enabled, &acc.CreatedBy, &acc.CreatedAt, &acc.UpdatedAt, &acc.State, &acc.LoginUrl,
		&acc.ExpiresAt, &acc.Error, &acc.Status, &acc.DaemonAccountID, &acc.RuntimeID, &acc.EngineVersion,
	)
	return acc, err
}

// GetFreebuffDesktopPending answers the daemon's question for daemon-managed
// freebuff-desktop accounts. Daemon-authenticated.
func (h *Handler) GetFreebuffDesktopPending(w http.ResponseWriter, r *http.Request) {
	rt, ok := h.requireDaemonRuntimeAccess(w, r, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT daemon_account_id, state, engine_version,
			CASE WHEN state IN ('requested','awaiting_login','removing') THEN EXISTS (
				SELECT 1 FROM agent_task_queue q WHERE q.account_id=workspace_account.id AND q.status IN ('dispatched','running')
			) ELSE FALSE END AS active FROM workspace_account
		WHERE runtime_id = $1 AND provider = $2 AND daemon_account_id IS NOT NULL`,
		rt.ID, accountProviderFreebuffDesktop)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load pending accounts")
		return
	}
	defer rows.Close()
	pending := make([]map[string]any, 0)
	pins := make(map[string]string)
	for rows.Next() {
		var id pgtype.Text
		var state, version string
		var active bool
		if err := rows.Scan(&id, &state, &version, &active); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read pending accounts")
			return
		}
		if !id.Valid {
			continue
		}
		pins[id.String] = version
		if state == "requested" || state == "awaiting_login" || state == "removing" {
			pending = append(pending, map[string]any{"id": id.String, "state": state, "active": active})
		}
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read pending accounts")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": pending, "pins": pins})
}

// ReportFreebuffDesktopAccount is the daemon's report. Daemon-authenticated.
func (h *Handler) ReportFreebuffDesktopAccount(w http.ResponseWriter, r *http.Request) {
	rt, ok := h.requireDaemonRuntimeAccess(w, r, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	var report struct {
		Accounts []struct {
			ID            string          `json:"id"`
			State         string          `json:"state"`
			Label         string          `json:"label"`
			LoginURL      string          `json:"login_url"`
			ExpiresAt     json.RawMessage `json:"expires_at"`
			Error         string          `json:"error"`
			Status        json.RawMessage `json:"status"`
			Endpoint      string          `json:"endpoint"`
			CredentialRef string          `json:"credential_ref"`
		} `json:"accounts"`
		Complete bool               `json:"complete"`
		Snapshot bool               `json:"snapshot"`
		Removed  []string           `json:"removed"`
		Versions *[]FreebuffVersion `json:"versions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if report.Versions != nil {
		if _, err := h.updateFreebuffBlock(r, rt, func(b *FreebuffBlock) (bool, error) {
			b.InstalledVersions = *report.Versions
			return true, nil
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to store runtime versions")
			return
		}
	}
	hasErr := false
	for _, in := range report.Accounts {
		if !agent.ValidFreebuffAccountID(in.ID) {
			hasErr = true
			continue
		}
		switch in.State {
		case "", "requested", "awaiting_login", "connected", "signed_out", "failed", "removing":
		default:
			hasErr = true
			continue
		}
		if in.State == "" {
			// ID-only entries are presence snapshots, not lifecycle reports.
			continue
		}
		label := in.Label
		if label != "" {
			var conflict bool
			if err := h.DB.QueryRow(r.Context(), `SELECT EXISTS(
				SELECT 1 FROM workspace_account
				WHERE workspace_id=$1 AND provider=$2 AND label=$3
				  AND NOT COALESCE((runtime_id=$4 AND daemon_account_id=$5), FALSE)
			)`, rt.WorkspaceID, accountProviderFreebuffDesktop, label, rt.ID, in.ID).Scan(&conflict); err != nil {
				hasErr = true
				continue
			}
			if conflict {
				label += " (" + in.ID + ")"
			}
		}
		tag, err := h.DB.Exec(r.Context(), `
			UPDATE workspace_account SET
				label = CASE WHEN $3 <> '' THEN $3 ELSE label END,
				endpoint = CASE WHEN $4 <> '' THEN $4 ELSE endpoint END,
				credential_ref = CASE WHEN $5 <> '' THEN $5 ELSE credential_ref END,
				state = CASE WHEN $12 AND state IN ('requested','awaiting_login') THEN state ELSE $6 END,
				login_url = CASE WHEN $12 AND state IN ('requested','awaiting_login') THEN login_url ELSE $7 END,
				expires_at = CASE WHEN $12 AND state IN ('requested','awaiting_login') THEN expires_at ELSE $8 END,
				error = CASE WHEN $12 AND state IN ('requested','awaiting_login') THEN error ELSE $9 END,
				status = CASE WHEN $12 AND state IN ('requested','awaiting_login') THEN status ELSE $10 END,
				updated_at = now()
			WHERE runtime_id = $1 AND daemon_account_id = $2 AND provider = $11 AND state <> 'removing'`,
			rt.ID, in.ID, label, in.Endpoint, optionalText(in.CredentialRef), in.State,
			optionalText(in.LoginURL), parseExpiresAt(in.ExpiresAt), optionalText(in.Error), optionalJSON(in.Status), accountProviderFreebuffDesktop, report.Snapshot)
		if err == nil && tag.RowsAffected() == 0 {
			var removing bool
			if lookupErr := h.DB.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM workspace_account WHERE runtime_id=$1 AND daemon_account_id=$2 AND provider=$3 AND state='removing')`,
				rt.ID, in.ID, accountProviderFreebuffDesktop).Scan(&removing); lookupErr == nil && removing {
				continue
			}
		}
		if err != nil || tag.RowsAffected() == 0 {
			hasErr = true
			slog.Warn("managed account update failed", "runtime_id", uuidToString(rt.ID), "daemon_account_id", in.ID, "error", err)
		}
	}
	if report.Complete {
		ids := make([]string, 0, len(report.Accounts))
		for _, in := range report.Accounts {
			if in.ID != "" {
				ids = append(ids, in.ID)
			}
		}
		rows, err := h.DB.Query(r.Context(), `
			SELECT daemon_account_id FROM workspace_account
			WHERE runtime_id=$1 AND provider=$2 AND daemon_account_id IS NOT NULL
			  AND state NOT IN ('requested','awaiting_login','removing')
			  AND NOT (daemon_account_id = ANY($3))`, rt.ID, accountProviderFreebuffDesktop, ids)
		if err != nil {
			hasErr = true
		} else {
			var stale []string
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					hasErr = true
					break
				}
				stale = append(stale, id)
			}
			if err := rows.Err(); err != nil {
				hasErr = true
			}
			rows.Close()
			for _, id := range stale {
				if err := h.deleteManagedWorkspaceAccount(r.Context(), rt.ID, id); err != nil {
					hasErr = true
				}
			}
		}
	}
	for _, id := range report.Removed {
		if !agent.ValidFreebuffAccountID(id) || h.deleteManagedWorkspaceAccount(r.Context(), rt.ID, id) != nil {
			hasErr = true
		}
	}
	if hasErr {
		writeError(w, http.StatusInternalServerError, "failed to store some accounts")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) deleteManagedWorkspaceAccount(ctx context.Context, runtimeID pgtype.UUID, daemonAccountID string) error {
	var accountID pgtype.UUID
	if err := h.DB.QueryRow(ctx, `SELECT id FROM workspace_account WHERE runtime_id=$1 AND provider=$2 AND daemon_account_id=$3`,
		runtimeID, accountProviderFreebuffDesktop, daemonAccountID).Scan(&accountID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	if err := qtx.DemoteAgentsOnAccountDelete(ctx, accountID); err != nil {
		return err
	}
	if err := qtx.DeleteWorkspaceAccount(ctx, accountID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func optionalJSON(raw json.RawMessage) interface{} {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return raw
}

func parseExpiresAt(raw json.RawMessage) interface{} {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if t, err := time.Parse(time.RFC3339, text); err == nil {
			return t.UTC()
		}
	}
	var millis int64
	if err := json.Unmarshal(raw, &millis); err == nil && millis > 0 {
		return time.UnixMilli(millis).UTC()
	}
	return nil
}
