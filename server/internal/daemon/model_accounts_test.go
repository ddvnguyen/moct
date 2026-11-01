package daemon

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func stubListModels(t *testing.T, fn func(agent.Command) (agent.Catalog, error)) {
	t.Helper()
	orig := listModels
	listModels = func(_ context.Context, _ string, cmd agent.Command) (agent.Catalog, error) { return fn(cmd) }
	t.Cleanup(func() { listModels = orig })
}

func envOf(cmd agent.Command) string { return strings.Join(cmd.Env, ",") }

func TestDiscoverAccountCatalogsMergesAndTags(t *testing.T) {
	stubListModels(t, func(cmd agent.Command) (agent.Catalog, error) {
		switch {
		case strings.Contains(envOf(cmd), "http://a"):
			return agent.Catalog{Models: []agent.Model{{ID: "shared"}, {ID: "only-a"}}}, nil
		case strings.Contains(envOf(cmd), "http://b"):
			return agent.Catalog{
				Models:      []agent.Model{{ID: "shared"}, {ID: "only-b"}},
				Unavailable: []agent.UnavailableModel{{ID: "old", Reason: "update"}},
			}, nil
		}
		return agent.Catalog{}, errors.New("unexpected env " + envOf(cmd))
	})
	got, err := discoverAccountCatalogs(context.Background(), "codebuddy", agent.NewCommand("bridge", nil), []protocol.DaemonModelAccount{
		{ID: "A", Label: "Alpha", Endpoint: "http://a", CredentialRef: "ref-a"},
		{ID: "B", Label: "Beta", Endpoint: "http://b"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Models) != 3 {
		t.Fatalf("models = %+v", got.Models)
	}
	shared := got.Models[0]
	if shared.ID != "shared" || strings.Join(shared.AccountIDs, ",") != "A,B" || strings.Join(shared.AccountLabels, ",") != "Alpha,Beta" {
		t.Fatalf("shared model not merged across accounts: %+v", shared)
	}
	if shared.AccountID != "A" {
		t.Fatalf("AccountID should keep the first account, got %q", shared.AccountID)
	}
	if got.Models[2].ID != "only-b" || strings.Join(got.Models[2].AccountIDs, ",") != "B" {
		t.Fatalf("only-b = %+v", got.Models[2])
	}
	if len(got.Unavailable) != 1 || got.Unavailable[0].ID != "old" {
		t.Fatalf("unavailable = %+v", got.Unavailable)
	}
}

func TestDiscoverAccountCatalogsPassesAccountEnvOnTheCommand(t *testing.T) {
	var seen []string
	stubListModels(t, func(cmd agent.Command) (agent.Catalog, error) {
		seen = append(seen, envOf(cmd))
		return agent.Catalog{Models: []agent.Model{{ID: "m"}}}, nil
	})
	base := agent.NewCommand("bridge", nil)
	_, err := discoverAccountCatalogs(context.Background(), "codebuddy", base, []protocol.DaemonModelAccount{
		{ID: "A", Endpoint: "http://a", CredentialRef: "ref-a", LaunchID: "launch-a"},
		{ID: "B", Endpoint: " http://b "},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"FREEBUFF_DESKTOP_URL=http://a,FREEBUFF_DESKTOP_CREDENTIAL_REF=ref-a,FREEBUFF_DESKTOP_LAUNCH_ID=launch-a",
		"FREEBUFF_DESKTOP_URL=http://b",
	}
	if strings.Join(seen, "|") != strings.Join(want, "|") {
		t.Fatalf("env per call = %q, want %q", seen, want)
	}
	if len(base.Env) != 0 {
		t.Fatalf("base command was mutated: %v", base.Env)
	}
}

func TestDiscoverAccountCatalogsToleratesOneFailure(t *testing.T) {
	stubListModels(t, func(cmd agent.Command) (agent.Catalog, error) {
		if strings.Contains(envOf(cmd), "http://bad") {
			return agent.Catalog{}, errors.New("unreachable")
		}
		return agent.Catalog{Models: []agent.Model{{ID: "m"}}}, nil
	})
	got, err := discoverAccountCatalogs(context.Background(), "codebuddy", agent.NewCommand("bridge", nil), []protocol.DaemonModelAccount{
		{ID: "bad", Endpoint: "http://bad"},
		{ID: "ok", Endpoint: "http://ok"},
	})
	if err != nil {
		t.Fatalf("one failing account must not fail the request: %v", err)
	}
	if len(got.Models) != 1 || got.Failed["bad"] == nil {
		t.Fatalf("got = %+v", got)
	}
}

func TestDiscoverAccountCatalogsFailsWhenEveryAccountFails(t *testing.T) {
	stubListModels(t, func(agent.Command) (agent.Catalog, error) { return agent.Catalog{}, errors.New("down") })
	_, err := discoverAccountCatalogs(context.Background(), "codebuddy", agent.NewCommand("bridge", nil), []protocol.DaemonModelAccount{
		{ID: "A", Label: "Alpha", Endpoint: "http://a"},
		{ID: "B", Endpoint: "http://b"},
	})
	if err == nil || !strings.Contains(err.Error(), "Alpha") || !strings.Contains(err.Error(), "down") {
		t.Fatalf("err = %v, want the first account's error", err)
	}
}
