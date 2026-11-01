package daemon

import (
	"context"
	"errors"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Freebuff model discovery (M-165).
//
// A Freebuff runtime's model catalog is the picker of the account signed in
// on a running orchestrator; there is no CLI to enumerate. The daemon
// launches one orchestrator per account profile on disk — short-lived, the
// same launch the account status refresh uses — and merges what they
// advertise. A model offered by several accounts is one row that lists every
// account serving it (AccountIDs/AccountLabels), so the picker can tell
// which accounts can run it. A failing account is skipped unless every
// account fails. An account signed out or unreachable shows up as a failed
// account, never as a model it cannot run.
//
// Each account allows a single run and its profile is the orchestrator's
// state directory, so discovery launches accounts one at a time.
const freebuffCatalogTimeout = 45 * time.Second

// errAccountSignedOut names why discovery skipped an account: it has no
// signed-in orchestrator to enumerate a catalog from.
var errAccountSignedOut = errors.New("freebuff account is not signed in")

// discoverFreebuffModelList is handleModelList for a Freebuff runtime: it
// enumerates the runtime's accounts on disk, launches one orchestrator per
// account to read that account's picker catalog, and reports the merge. With
// no account on disk it reports an empty catalog — still supported, so the
// UI keeps manual entry — rather than an error naming a missing CLI.
func (d *Daemon) discoverFreebuffModelList(ctx context.Context, rt Runtime, requestID string) {
	supported := agent.ModelSelectionSupported(rt.Provider)
	ids, err := agent.ListFreebuffAccounts(agent.Config{RuntimeID: rt.ID})
	if err != nil {
		d.reportModelListResult(ctx, rt, requestID, map[string]any{
			"status":    "failed",
			"supported": supported,
			"error":     err.Error(),
		})
		return
	}
	merged, err := discoverFreebuffCatalogs(ctx, rt.ID, ids, startFreebuffAccount)
	if err != nil {
		d.reportModelListResult(ctx, rt, requestID, map[string]any{
			"status":    "failed",
			"supported": supported,
			"error":     err.Error(),
		})
		return
	}
	for id, ferr := range merged.Failed {
		d.logger.Warn("freebuff model discovery failed for account",
			"runtime_id", rt.ID, "account", id, "error", ferr)
	}
	type modelWire struct {
		ID            string   `json:"id"`
		Label         string   `json:"label"`
		Provider      string   `json:"provider,omitempty"`
		AccountID     string   `json:"account_id,omitempty"`
		AccountLabel  string   `json:"account_label,omitempty"`
		AccountIDs    []string `json:"account_ids,omitempty"`
		AccountLabels []string `json:"account_labels,omitempty"`
		Default       bool     `json:"default,omitempty"`
	}
	wire := make([]modelWire, 0, len(merged.Models))
	for _, m := range merged.Models {
		wire = append(wire, modelWire{
			ID:            m.ID,
			Label:         m.Label,
			Provider:      m.Provider,
			AccountID:     m.AccountID,
			AccountLabel:  m.AccountLabel,
			AccountIDs:    m.AccountIDs,
			AccountLabels: m.AccountLabels,
			Default:       m.Default,
		})
	}
	d.reportModelListResult(ctx, rt, requestID, map[string]any{
		"status":    "completed",
		"models":    wire,
		"supported": supported,
	})
}

// prepareManagedFreebuffDesktopAccounts resolves launch credentials from the
// daemon-owned instances. Credentials stay in memory and are added only to the
// local discovery command environment; they never travel through server
// account records or heartbeat payloads.
func (d *Daemon) prepareManagedFreebuffDesktopAccounts(ctx context.Context, rt Runtime, accounts []protocol.DaemonModelAccount) []protocol.DaemonModelAccount {
	if len(accounts) == 0 {
		return accounts
	}
	prepared := append([]protocol.DaemonModelAccount(nil), accounts...)
	for i := range prepared {
		if prepared[i].DaemonAccountID == "" {
			continue
		}
		startCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		client, err := d.ensureFreebuffDesktopInstance(startCtx, rt, prepared[i].DaemonAccountID)
		cancel()
		if err != nil {
			d.logger.Warn("managed Freebuff Desktop model discovery instance unavailable", "runtime_id", rt.ID, "account_id", prepared[i].DaemonAccountID, "error", err)
			prepared[i].LaunchError = "managed Freebuff Desktop instance unavailable"
			continue
		}
		dir, err := freebuffDesktopAccountDir(rt, prepared[i].DaemonAccountID)
		if err != nil {
			prepared[i].LaunchError = "managed Freebuff Desktop account state unavailable"
			continue
		}
		prepared[i].Endpoint = client.BaseURL()
		prepared[i].CredentialRef = dir
		prepared[i].LaunchID = client.LaunchID()
		if prepared[i].LaunchID == "" {
			prepared[i].LaunchError = "managed Freebuff Desktop launch credential unavailable"
		}
	}
	return prepared
}

// discoverFreebuffCatalogs runs model discovery once per account and merges
// the results. The launcher is injected for tests; production uses
// startFreebuffAccount.
func discoverFreebuffCatalogs(
	ctx context.Context,
	runtimeID string,
	accounts []string,
	launch func(ctx context.Context, runtimeID, accountID string) (freebuffAccount, func(), error),
) (accountCatalog, error) {
	out := accountCatalog{Failed: map[string]error{}}
	index := map[string]int{}
	defaultTaken := false
	for _, accountID := range accounts {
		startCtx, cancel := context.WithTimeout(ctx, freebuffCatalogTimeout)
		client, stop, err := launch(startCtx, runtimeID, accountID)
		if err != nil {
			cancel()
			out.Failed[accountID] = err
			continue
		}
		st, err := client.AuthStatus(startCtx)
		if err != nil {
			stop()
			cancel()
			out.Failed[accountID] = err
			continue
		}
		if !st.Authed {
			stop()
			cancel()
			out.Failed[accountID] = errAccountSignedOut
			continue
		}
		cat, err := client.ModelCatalog(startCtx)
		stop()
		cancel()
		if err != nil {
			out.Failed[accountID] = err
			continue
		}
		for _, m := range cat.Models {
			row := agent.Model{
				ID:         m.ID,
				Provider:   freebuffProvider,
				AccountID:  accountID,
				AccountIDs: []string{accountID},
			}
			if i, ok := index[m.ID]; ok {
				out.Models[i].AccountIDs = appendUniqueStr(out.Models[i].AccountIDs, accountID)
				out.Models[i].AccountLabels = appendUniqueStr(out.Models[i].AccountLabels, accountID)
				if !defaultTaken && cat.Default == m.ID {
					out.Models[i].Default = true
					defaultTaken = true
				}
				continue
			}
			row.Label = m.ID
			if m.DisplayName != "" && m.DisplayName != m.ID {
				row.Label = m.DisplayName
			}
			row.AccountLabel = accountID
			row.AccountLabels = []string{accountID}
			if !defaultTaken && cat.Default == m.ID {
				row.Default = true
				defaultTaken = true
			}
			index[m.ID] = len(out.Models)
			out.Models = append(out.Models, row)
		}
	}
	if len(out.Models) == 0 && len(out.Failed) > 0 {
		// Every account failed; surface the first reason.
		for _, err := range out.Failed {
			return out, err
		}
	}
	return out, nil
}
