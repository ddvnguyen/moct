package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Account selection for freebuff-desktop agents (M-153).
//
// An agent runs against one of three account settings:
//
//	default   no account: the runtime's own configuration applies.
//	specific  one named workspace account.
//	any       any enabled workspace account; the server picks the least busy
//	          one when a task is claimed.

const (
	// accountProviderFreebuffDesktop is the workspace_account.provider these
	// accounts belong to.
	accountProviderFreebuffDesktop = "freebuff-desktop"

	accountModeDefault  = "default"
	accountModeSpecific = "specific"
	accountModeAny      = "any"
)

// accountRuntimeProvider is the protocol family a freebuff-desktop runtime
// runs as (a custom runtime profile whose command is the bridge).
const accountRuntimeProvider = "codebuddy"

// agentAccountSelection is a validated account setting, ready to persist.
type agentAccountSelection struct {
	Mode string
	ID   pgtype.UUID
}

// normalizeAccountSelection merges a request's account fields with the agent's
// current setting and checks that they are consistent. modeSet/idSet say
// whether the request carried the field at all, so an update that touches
// neither leaves the setting alone.
//
// Rules: mode is one of default|specific|any; specific requires an account id;
// any other mode must not carry one. Moving off specific without naming an id
// clears the id.
func normalizeAccountSelection(
	modeSet bool, mode string,
	idSet bool, id string,
	curMode string, curID pgtype.UUID,
) (agentAccountSelection, error) {
	if curMode == "" {
		curMode = accountModeDefault
	}
	sel := agentAccountSelection{Mode: curMode, ID: curID}

	if modeSet {
		mode = strings.TrimSpace(mode)
		if mode == "" {
			mode = accountModeDefault
		}
		switch mode {
		case accountModeDefault, accountModeSpecific, accountModeAny:
		default:
			return sel, errors.New("invalid account_mode")
		}
		sel.Mode = mode
		if mode != accountModeSpecific {
			sel.ID = pgtype.UUID{}
		}
	}
	if idSet {
		id = strings.TrimSpace(id)
		if id == "" {
			sel.ID = pgtype.UUID{}
		} else {
			u, err := util.ParseUUID(id)
			if err != nil {
				return sel, errors.New("invalid account_id")
			}
			sel.ID = u
		}
	}
	switch {
	case sel.Mode == accountModeSpecific && !sel.ID.Valid:
		return sel, errors.New("account_id is required when account_mode is specific")
	case sel.Mode != accountModeSpecific && sel.ID.Valid:
		return sel, errors.New("account_id is only valid when account_mode is specific")
	}
	return sel, nil
}

// validateAgentAccount checks a selection against the database: a specific
// account must exist in the agent's workspace, be enabled and belong to the
// freebuff-desktop provider, and any non-default selection needs a runtime
// that can run it. It returns an HTTP status and message, or 0 when valid.
func (h *Handler) validateAgentAccount(ctx context.Context, workspaceID pgtype.UUID, runtime db.AgentRuntime, sel agentAccountSelection) (int, string) {
	if sel.Mode == accountModeDefault {
		return 0, ""
	}
	if runtime.Provider != accountRuntimeProvider {
		return http.StatusBadRequest, "accounts are only supported on freebuff-desktop runtimes"
	}
	if sel.Mode != accountModeSpecific {
		return 0, ""
	}
	acc, err := h.Queries.GetWorkspaceAccountInWorkspace(ctx, db.GetWorkspaceAccountInWorkspaceParams{
		ID: sel.ID, WorkspaceID: workspaceID,
	})
	if err != nil {
		return http.StatusBadRequest, "account not found in workspace"
	}
	if acc.Provider != accountProviderFreebuffDesktop {
		return http.StatusBadRequest, "account provider mismatch"
	}
	if acc.DaemonAccountID.Valid && (!acc.RuntimeID.Valid || acc.RuntimeID != runtime.ID) {
		return http.StatusBadRequest, "managed account belongs to another runtime"
	}
	if !acc.Enabled {
		return http.StatusBadRequest, "account is disabled"
	}
	if acc.DaemonAccountID.Valid && acc.State != "connected" {
		return http.StatusBadRequest, "managed account is not connected"
	}
	return 0, ""
}

// claimAccount is the account a claimed task runs against.
type claimAccount struct {
	ID              pgtype.UUID
	Endpoint        string
	CredentialRef   string
	DaemonAccountID string
}

// errAccountUnavailable means the agent's account setting cannot be honoured
// right now: the named account is gone or disabled. The task must fail rather
// than silently run on whatever account the runtime defaults to.
var errAccountUnavailable = errors.New("agent account is unavailable")

// resolveClaimAccount picks the account for a task being claimed. It returns
// ok=false for a default agent, and also for `any` in a workspace with no
// enabled account (nothing to select). The caller records the id on the queue
// row so concurrent claims see the account as busy.
func (h *Handler) resolveClaimAccount(ctx context.Context, agent db.Agent) (acc claimAccount, ok bool, err error) {
	switch agent.AccountMode {
	case accountModeSpecific:
		a, gerr := h.Queries.GetWorkspaceAccountInWorkspace(ctx, db.GetWorkspaceAccountInWorkspaceParams{
			ID: agent.AccountID, WorkspaceID: agent.WorkspaceID,
		})
		if gerr != nil || !a.Enabled || a.Provider != accountProviderFreebuffDesktop {
			return claimAccount{}, false, errAccountUnavailable
		}
		if a.DaemonAccountID.Valid && (!a.RuntimeID.Valid || a.RuntimeID != agent.RuntimeID || a.State != "connected") {
			return claimAccount{}, false, errAccountUnavailable
		}
		return claimAccount{ID: a.ID, Endpoint: a.Endpoint.String, CredentialRef: a.CredentialRef.String, DaemonAccountID: a.DaemonAccountID.String}, true, nil
	case accountModeAny:
		rows, lerr := h.Queries.ListAccountsForDispatch(ctx, db.ListAccountsForDispatchParams{
			WorkspaceID: agent.WorkspaceID, Provider: accountProviderFreebuffDesktop, RuntimeID: agent.RuntimeID,
		})
		if lerr != nil {
			return claimAccount{}, false, lerr
		}
		if len(rows) == 0 {
			return claimAccount{}, false, nil
		}
		r := rows[0] // least busy first
		return claimAccount{ID: r.ID, Endpoint: r.Endpoint.String, CredentialRef: r.CredentialRef.String, DaemonAccountID: r.DaemonAccountID.String}, true, nil
	}
	return claimAccount{}, false, nil
}

// Account scopes a model-discovery request can ask for.
const (
	modelAccountDefault = "default"
	modelAccountAll     = "all"
)

// normalizeModelAccountParam validates the `account` query parameter of a
// model-list request: empty/"default" (the runtime's own catalog), "all", or an
// account id. It returns the canonical value used in the catalog cache key.
func normalizeModelAccountParam(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	switch raw {
	case "", modelAccountDefault:
		return modelAccountDefault, nil
	case modelAccountAll:
		return modelAccountAll, nil
	}
	u, err := util.ParseUUID(raw)
	if err != nil {
		return "", errors.New("invalid account")
	}
	return util.UUIDToString(u), nil
}

// resolveModelAccounts turns a model-list request's account scope into the
// accounts the daemon enumerates models for, one discovery per account. Only
// enabled accounts of the runtime's workspace are returned; an unknown,
// disabled or foreign account id yields nothing rather than leaking another
// workspace's endpoint.
func resolveModelAccounts(ctx context.Context, q *db.Queries, runtimeID, account string) []protocol.DaemonModelAccount {
	if account == "" || account == modelAccountDefault {
		return nil
	}
	rt, err := q.GetAgentRuntime(ctx, parseUUID(runtimeID))
	if err != nil {
		return nil
	}
	toWire := func(a db.WorkspaceAccount) protocol.DaemonModelAccount {
		return protocol.DaemonModelAccount{
			ID:              uuidToString(a.ID),
			Label:           a.Label,
			Endpoint:        a.Endpoint.String,
			CredentialRef:   a.CredentialRef.String,
			DaemonAccountID: a.DaemonAccountID.String,
		}
	}
	if account == modelAccountAll {
		accs, err := q.ListWorkspaceAccountsByProvider(ctx, db.ListWorkspaceAccountsByProviderParams{
			WorkspaceID: rt.WorkspaceID, Provider: accountProviderFreebuffDesktop,
		})
		if err != nil {
			return nil
		}
		out := make([]protocol.DaemonModelAccount, 0, len(accs))
		for _, a := range accs {
			if a.DaemonAccountID.Valid && (!a.RuntimeID.Valid || uuidToString(a.RuntimeID) != runtimeID || a.State != "connected") {
				continue
			}
			out = append(out, toWire(a)) // the query already filters enabled
		}
		return out
	}
	accUUID, err := util.ParseUUID(account)
	if err != nil {
		return nil
	}
	acc, err := q.GetWorkspaceAccountInWorkspace(ctx, db.GetWorkspaceAccountInWorkspaceParams{
		ID: accUUID, WorkspaceID: rt.WorkspaceID,
	})
	if err != nil || !acc.Enabled || acc.Provider != accountProviderFreebuffDesktop {
		return nil
	}
	if acc.DaemonAccountID.Valid && (!acc.RuntimeID.Valid || uuidToString(acc.RuntimeID) != runtimeID || acc.State != "connected") {
		return nil
	}
	return []protocol.DaemonModelAccount{toWire(acc)}
}
