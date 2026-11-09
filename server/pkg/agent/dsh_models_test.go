package agent

import (
	"testing"
)

// dshCatalog is the verbatim shape of the lane's dsh runtime `models` frames:
// the ID is `route/<model>` where the route is the dsh-llm adapter's registered
// provider identity ("dsh-opencode-go"), while the frame's Provider field is
// that identity's DISPLAY NAME ("DSH OpenCode Go"). An id persisted in the
// SDK shape (`opencode-go/beam-free`) therefore matches no row's Provider
// segment, which is exactly why the generic QualifyModelID cannot rewrite it.
func dshCatalog() Catalog {
	return Catalog{Models: []Model{
		{ID: "dsh-opencode-go/beam-free", Label: "Beam Free", Provider: "DSH OpenCode Go"},
		{ID: "dsh-opencode-go/mimo-v2.6-flash", Label: "Mimo v2.6 Flash", Provider: "DSH OpenCode Go"},
		{ID: "dsh-opencode-go/glm-5.3-flash", Label: "GLM-5.3-Flash", Provider: "DSH OpenCode Go"},
	}}
}

// TestQualifyModelIDForProviderDshNamespacesTheSDKProvider covers M-289: a
// persisted id in the SDK shape (`opencode-go/beam-free`) names a provider the
// dsh runtime never registered (its route is `dsh-opencode-go`), and dispatch
// died with `DSH_RUNTIME_ERROR: no adapter registered for provider
// "opencode-go"`. The catalog — not the "dsh-" convention — is what owns the
// rewrite: the runtime must advertise exactly one row whose route keeps the
// persisted provider as a namespaced suffix over the same model segment.
func TestQualifyModelIDForProviderDshNamespacesTheSDKProvider(t *testing.T) {
	t.Parallel()

	got, rewritten := QualifyModelIDForProvider("dsh", dshCatalog(), "opencode-go/beam-free")
	if got != "dsh-opencode-go/beam-free" || !rewritten {
		t.Fatalf("QualifyModelIDForProvider(dsh, catalog, opencode-go/beam-free) = (%q, %v), want (dsh-opencode-go/beam-free, true)", got, rewritten)
	}

	// A postfixed vendor variant qualifies through the namespace the catalog
	// registers for it. The suffix relation is also asymmetric: rows registered
	// for the plus provider never alias a plain `opencode-go` selection, so the
	// single-namespace check stays a real evidence check and not a prefix
	// wildcard.
	plus := Catalog{Models: []Model{
		{ID: "dsh-opencode-go-plus/beam-free", Provider: "DSH OpenCode Go Plus"},
	}}
	got, rewritten = QualifyModelIDForProvider("dsh", plus, "opencode-go-plus/beam-free")
	if got != "dsh-opencode-go-plus/beam-free" || !rewritten {
		t.Fatalf("QualifyModelIDForProvider(dsh, plus, opencode-go-plus/beam-free) = (%q, %v), want (dsh-opencode-go-plus/beam-free, true)", got, rewritten)
	}
	got, rewritten = QualifyModelIDForProvider("dsh", plus, "opencode-go/beam-free")
	if got != "opencode-go/beam-free" || rewritten {
		t.Fatalf("QualifyModelIDForProvider(dsh, plus, opencode-go/beam-free) = (%q, %v), want untouched", got, rewritten)
	}
}

// The rewrite must be evidence, not an alias: every no-evidence shape the
// generic qualifier already refuses must still be refused, because an
// unrewritten id reaches the runtime's own resolver and its refusal is the
// honest failure.
func TestQualifyModelIDForProviderDshRefusesWithoutEvidence(t *testing.T) {
	t.Parallel()

	ambiguous := Catalog{Models: append(dshCatalog().Models,
		// A second route carrying the same suffix over the same model segment
		// means the catalog cannot tell which route the persisted name meant.
		Model{ID: "dsh2-opencode-go/beam-free", Provider: "Other DSH OpenCode Go"},
	)}

	// A gateway-style id contains a slash inside its route half; that is not a
	// route name a dsh adapter registers.
	gateway := Catalog{Models: []Model{
		{ID: "gateway-a/dsh-opencode-go/beam-free", Provider: "Gateway A"},
	}}

	// The Provider display name must never own the match: a row whose display
	// name equals the persisted provider but whose id names a different route
	// must not earn a rewrite.
	mislabelled := Catalog{Models: []Model{
		{ID: "dsh-other/beam-free", Provider: "opencode-go"},
	}}

	tests := []struct {
		name    string
		catalog Catalog
		model   string
		want    string
	}{
		{
			name:    "already route-qualified id is left alone",
			catalog: dshCatalog(),
			model:   "dsh-opencode-go/beam-free",
			want:    "dsh-opencode-go/beam-free",
		},
		{
			name:    "model the catalog does not advertise passes through",
			catalog: dshCatalog(),
			model:   "opencode-go/no-such-model",
			want:    "opencode-go/no-such-model",
		},
		{
			name:    "ambiguous namespace passes through",
			catalog: ambiguous,
			model:   "opencode-go/beam-free",
			want:    "opencode-go/beam-free",
		},
		{
			name:    "gateway-style route is not a route name",
			catalog: gateway,
			model:   "dsh-opencode-go/beam-free",
			want:    "dsh-opencode-go/beam-free",
		},
		{
			name:    "the Provider display name does not own the match",
			catalog: mislabelled,
			model:   "opencode-go/beam-free",
			want:    "opencode-go/beam-free",
		},
		{
			name:    "a bare id names no provider to namespace",
			catalog: dshCatalog(),
			model:   "beam-free",
			want:    "beam-free",
		},
		{
			name:    "an empty provider segment is not a route",
			catalog: dshCatalog(),
			model:   "/beam-free",
			want:    "/beam-free",
		},
		{
			name:    "an empty catalog cannot rewrite anything",
			catalog: Catalog{},
			model:   "opencode-go/beam-free",
			want:    "opencode-go/beam-free",
		},
		{
			// Same posture as QualifyModelID: a fallback catalog is a static
			// stand-in, and rewriting against it invents an id the runtime
			// may never have advertised.
			name:    "a fallback catalog is never authoritative",
			catalog: Catalog{Models: dshCatalog().Models, Fallback: true},
			model:   "opencode-go/beam-free",
			want:    "opencode-go/beam-free",
		},
		{
			name:    "blank collapses to the runtime default",
			catalog: dshCatalog(),
			model:   "   ",
			want:    "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, rewritten := QualifyModelIDForProvider("dsh", tt.catalog, tt.model)
			if got != tt.want || rewritten {
				t.Errorf("QualifyModelIDForProvider(dsh, %q) = (%q, %v), want (%q, false)", tt.model, got, rewritten, tt.want)
			}
		})
	}
}

// TestQualifyModelIDForProviderDispatchesByFamily pins the dispatch seam: the
// same catalog must qualify differently per provider, because the dsh rewrite
// criterion (route names, display-name Provider field) is meaningless for a
// runtime whose rows carry the provider segment of their own ids.
func TestQualifyModelIDForProviderDispatchesByFamily(t *testing.T) {
	t.Parallel()

	catalog := dshCatalog()

	// The generic rule on the same catalog cannot rewrite the SDK-shape id:
	// no row's Provider field equals "opencode-go".
	got, rewritten := QualifyModelIDForProvider("claude", catalog, "opencode-go/beam-free")
	if got != "opencode-go/beam-free" || rewritten {
		t.Fatalf("QualifyModelIDForProvider(claude, ...) = (%q, %v), want the value untouched", got, rewritten)
	}

	// The generic rule still owns family rows where Provider IS the id's
	// provider segment.
	generic := Catalog{Models: []Model{{ID: "multica-anthropic/claude/claude-opus-5", Provider: "multica-anthropic"}}}
	got, rewritten = QualifyModelIDForProvider("claude", generic, "claude/claude-opus-5")
	if got != "multica-anthropic/claude/claude-opus-5" || !rewritten {
		t.Fatalf("QualifyModelIDForProvider(claude, gateway catalog) = (%q, %v), want (multica-anthropic/claude/claude-opus-5, true)", got, rewritten)
	}
}
