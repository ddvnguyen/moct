package daemon

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// accountEnv is the environment one account applies to the runtime command.
// It travels on the command (agent.Command.Env), never through os.Setenv:
// the daemon's process environment is shared by every concurrent task and
// discovery, so mutating it would leak one account's settings into another
// run.
func accountEnv(acc protocol.DaemonModelAccount) []string {
	var env []string
	if v := strings.TrimSpace(acc.Endpoint); v != "" {
		env = append(env, "FREEBUFF_DESKTOP_URL="+v)
	}
	if v := strings.TrimSpace(acc.CredentialRef); v != "" {
		env = append(env, "FREEBUFF_DESKTOP_CREDENTIAL_REF="+v)
	}
	if v := strings.TrimSpace(acc.LaunchID); v != "" {
		env = append(env, "FREEBUFF_DESKTOP_LAUNCH_ID="+v)
	}
	return env
}

// accountCatalog is the merged result of discovering models across accounts.
type accountCatalog struct {
	Models      []agent.Model
	Unavailable []agent.UnavailableModel
	// Fallback is true when any account's catalog was a static stand-in.
	Fallback bool
	// Failed maps an account id to its discovery error. A failing account never
	// fails the request unless every account fails.
	Failed map[string]error
}

// discoverAccountCatalogs runs model discovery once per account — one at a
// time, because each account allows a single run — and merges the results.
//
// A model offered by several accounts is one row that lists every account
// serving it (AccountIDs/AccountLabels), so the picker can tell which accounts
// can run it. AccountID/AccountLabel keep the first account for older clients.
// When every account fails the first error is returned.
func discoverAccountCatalogs(
	ctx context.Context,
	provider string,
	base agent.Command,
	accounts []protocol.DaemonModelAccount,
) (accountCatalog, error) {
	out := accountCatalog{Failed: map[string]error{}}
	index := map[string]int{}
	seenUnavailable := map[string]bool{}
	var firstErr error

	for _, acc := range accounts {
		if err := ctx.Err(); err != nil {
			return accountCatalog{}, err
		}
		if acc.LaunchError != "" {
			out.Failed[acc.ID] = errors.New(acc.LaunchError)
			if firstErr == nil {
				firstErr = fmt.Errorf("account %q: %s", accountDisplay(acc), acc.LaunchError)
			}
			continue
		}
		cat, err := listModels(ctx, provider, base.WithEnv(accountEnv(acc)...))
		if err != nil {
			out.Failed[acc.ID] = err
			if firstErr == nil {
				firstErr = fmt.Errorf("account %q: %w", accountDisplay(acc), err)
			}
			continue
		}
		if cat.Fallback {
			out.Fallback = true
		}
		for _, m := range cat.Models {
			if i, ok := index[m.ID]; ok {
				out.Models[i].AccountIDs = appendUniqueStr(out.Models[i].AccountIDs, acc.ID)
				out.Models[i].AccountLabels = appendUniqueStr(out.Models[i].AccountLabels, accountDisplay(acc))
				continue
			}
			m.AccountID = acc.ID
			m.AccountLabel = accountDisplay(acc)
			m.AccountIDs = []string{acc.ID}
			m.AccountLabels = []string{accountDisplay(acc)}
			index[m.ID] = len(out.Models)
			out.Models = append(out.Models, m)
		}
		for _, u := range cat.Unavailable {
			if seenUnavailable[u.ID] {
				continue
			}
			seenUnavailable[u.ID] = true
			out.Unavailable = append(out.Unavailable, u)
		}
	}
	if len(out.Failed) == len(accounts) && len(accounts) > 0 {
		if firstErr == nil {
			firstErr = errors.New("model discovery failed for every account")
		}
		return accountCatalog{}, firstErr
	}
	return out, nil
}

func accountDisplay(acc protocol.DaemonModelAccount) string {
	if l := strings.TrimSpace(acc.Label); l != "" {
		return l
	}
	return acc.ID
}
