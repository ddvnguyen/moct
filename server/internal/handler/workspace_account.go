package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
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
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Provider    string `json:"provider"`
	Label       string `json:"label"`
	Endpoint    string `json:"endpoint,omitempty"`
	Enabled     bool   `json:"enabled"`
	// CredentialRef is present for owner/admin readers only.
	CredentialRef string `json:"credential_ref,omitempty"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

func workspaceAccountToResponse(a db.WorkspaceAccount, includeCredentialRef bool) WorkspaceAccountResponse {
	resp := WorkspaceAccountResponse{
		ID:          uuidToString(a.ID),
		WorkspaceID: uuidToString(a.WorkspaceID),
		Provider:    a.Provider,
		Label:       a.Label,
		Enabled:     a.Enabled,
		CreatedAt:   timestampToString(a.CreatedAt),
		UpdatedAt:   timestampToString(a.UpdatedAt),
	}
	if a.Endpoint.Valid {
		resp.Endpoint = a.Endpoint.String
	}
	if includeCredentialRef && a.CredentialRef.Valid {
		resp.CredentialRef = a.CredentialRef.String
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
	var req struct {
		Provider      string `json:"provider"`
		Label         string `json:"label"`
		Endpoint      string `json:"endpoint"`
		CredentialRef string `json:"credential_ref"`
		Enabled       *bool  `json:"enabled"`
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
	userID, ok := requireUserID(w, r)
	if !ok {
		return
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
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
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
	updated, err := h.Queries.UpdateWorkspaceAccount(r.Context(), params)
	if err != nil {
		if isAccountLabelConflict(err) {
			writeError(w, http.StatusConflict, "an account with this label already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update account")
		return
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
	if _, err := h.Queries.GetWorkspaceAccountInWorkspace(r.Context(), db.GetWorkspaceAccountInWorkspaceParams{
		ID: accUUID, WorkspaceID: wsUUID,
	}); err != nil {
		writeError(w, http.StatusNotFound, "account not found")
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
