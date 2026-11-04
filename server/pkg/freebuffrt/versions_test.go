package freebuffrt

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeBundle writes a minimal bundle (orchestrator.js, optional manifest)
// under dir.
func makeBundle(t *testing.T, dir string, manifest BundleManifest) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "orchestrator"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "orchestrator", "orchestrator.js"), []byte("//"), 0o644); err != nil {
		t.Fatal(err)
	}
	if manifest.Version != "" {
		raw, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "manifest.json"), raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// storeWith installs two bundles under runtimeDir's version store.
func storeWith(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	makeBundle(t, filepath.Join(root, "versions", "0.0.188"), BundleManifest{Version: "0.0.188", Commit: "abc188"})
	makeBundle(t, filepath.Join(root, "versions", "0.0.196"), BundleManifest{Version: "0.0.196"})
	return root
}

// An unset pin keeps today's resolution order: FREEBUFF_RUNTIME_DIR still
// resolves to the legacy single-path layout.
func TestResolveBundleUnsetPinKeepsLegacyOrder(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "orchestrator"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "orchestrator", "orchestrator.js"), []byte("//"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A version store is present but nothing is pinned: it must not matter.
	makeBundle(t, filepath.Join(root, "versions", "0.0.196"), BundleManifest{Version: "0.0.196"})

	for _, env := range []map[string]string{
		{EnvRuntimeDir: root},
		{EnvRuntimeDir: root, EnvAppVersion: ""},
		{EnvRuntimeDir: root, EnvAppVersion: "  "},
	} {
		b, err := ResolveBundle(env, t.TempDir())
		if err != nil || b.ResourcesDir != root {
			t.Errorf("env %v: got %+v err=%v", env, b, err)
		}
	}
}

// A pin to an installed version resolves to that version's bundle.
func TestResolveBundlePinnedVersion(t *testing.T) {
	root := storeWith(t)
	b, err := ResolveBundle(map[string]string{
		EnvRuntimeDir: root,
		EnvAppVersion: "0.0.188",
	}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "versions", "0.0.188"); b.ResourcesDir != want {
		t.Fatalf("resources dir = %q, want %q", b.ResourcesDir, want)
	}
	version, commit := b.Version()
	if version != "0.0.188" || commit != "abc188" {
		t.Fatalf("version/commit = %q/%q", version, commit)
	}
}

// A pin to a version without a manifest still resolves, named by its
// directory.
func TestResolveBundlePinnedVersionWithoutManifest(t *testing.T) {
	root := t.TempDir()
	makeBundle(t, filepath.Join(root, "versions", "0.0.190"), BundleManifest{})
	b, err := ResolveBundle(map[string]string{EnvRuntimeDir: root, EnvAppVersion: "0.0.190"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if version, _ := b.Version(); version != "0.0.190" {
		t.Fatalf("version = %q, want the directory name", version)
	}
}

// An unknown pin fails closed and names the installed versions.
func TestResolveBundleUnknownPinFailsClosed(t *testing.T) {
	root := storeWith(t)
	_, err := ResolveBundle(map[string]string{EnvRuntimeDir: root, EnvAppVersion: "0.0.190"}, t.TempDir())
	if err == nil {
		t.Fatal("want an error")
	}
	if !strings.Contains(err.Error(), "0.0.188") || !strings.Contains(err.Error(), "0.0.196") {
		t.Fatalf("error does not list installed versions: %v", err)
	}
	if !strings.Contains(err.Error(), "0.0.190") {
		t.Fatalf("error does not name the pin: %v", err)
	}
	// The pinned bundle must not fall back to another bundle.
	if _, err := ResolveBundle(map[string]string{EnvRuntimeDir: root, EnvAppVersion: "0.0.999"}, t.TempDir()); err == nil {
		t.Fatal("unknown pin must not resolve")
	}
}

// A pin without a runtime dir cannot locate a store and says so.
func TestResolveBundlePinRequiresRuntimeDir(t *testing.T) {
	_, err := ResolveBundle(map[string]string{EnvAppVersion: "0.0.196"}, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), EnvRuntimeDir) {
		t.Fatalf("err = %v, want a %s requirement", err, EnvRuntimeDir)
	}
}

// Version strings that could escape the store are rejected.
func TestValidateVersion(t *testing.T) {
	for _, good := range []string{"0.0.188", "0.0.196-beta.1", "1.2.3+build"} {
		if err := ValidateVersion(good); err != nil {
			t.Errorf("ValidateVersion(%q) = %v", good, err)
		}
	}
	for _, bad := range []string{"", "..", ".", "a/b", `a\b`, " 0.0.188", "0.0.188 "} {
		if err := ValidateVersion(bad); err == nil {
			t.Errorf("ValidateVersion(%q) accepted", bad)
		}
	}
}

func TestInstalledVersions(t *testing.T) {
	root := storeWith(t)
	got := InstalledVersions(root)
	if len(got) != 2 {
		t.Fatalf("installed = %+v", got)
	}
	if got[0].Version != "0.0.188" || got[0].Commit != "abc188" {
		t.Errorf("first = %+v", got[0])
	}
	if got[1].Version != "0.0.196" || got[1].Commit != "" {
		t.Errorf("second = %+v", got[1])
	}
	if got[1].Dir != filepath.Join(root, "versions", "0.0.196") {
		t.Errorf("dir = %q", got[1].Dir)
	}
	// A manifest whose version disagrees with its directory is still listed
	// under the directory name — the version a pin resolves.
	makeBundle(t, filepath.Join(root, "versions", "0.0.250"), BundleManifest{Version: "9.9.9", Commit: "abc250"})
	got = InstalledVersions(root)
	if len(got) != 3 || got[2].Version != "0.0.250" || got[2].Commit != "abc250" {
		t.Fatalf("mismatched manifest: %+v", got)
	}
	// No store at all is an empty list, not an error.
	if got := InstalledVersions(t.TempDir()); got != nil {
		t.Errorf("no store: %+v", got)
	}
}

func TestInstallBundle(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "resources")
	makeBundle(t, src, BundleManifest{})
	if err := os.WriteFile(filepath.Join(src, "orchestrator", "build-info.json"), []byte(`{"commit":"deadbee"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	dst := t.TempDir()
	b, err := InstallBundle(src, dst, "0.0.190")
	if err != nil {
		t.Fatal(err)
	}
	if b.ResourcesDir != filepath.Join(dst, "versions", "0.0.190") {
		t.Fatalf("installed at %q", b.ResourcesDir)
	}
	if fi, err := os.Stat(filepath.Join(b.ResourcesDir, "orchestrator", "orchestrator.js")); err != nil || fi.IsDir() {
		t.Fatalf("orchestrator.js not installed: %v", err)
	}
	m, ok := readBundleManifest(b.ResourcesDir)
	if !ok || m.Version != "0.0.190" || m.Commit != "deadbee" {
		t.Fatalf("manifest = %+v ok=%v", m, ok)
	}
	got := InstalledVersions(dst)
	if len(got) != 1 || got[0].Version != "0.0.190" || got[0].Commit != "deadbee" {
		t.Fatalf("installed versions = %+v", got)
	}

	// Reinstalling a version replaces it; other versions survive.
	makeBundle(t, filepath.Join(dst, "versions", "0.0.196"), BundleManifest{Version: "0.0.196"})
	if err := os.WriteFile(filepath.Join(b.ResourcesDir, "orchestrator", "orchestrator.js"), []byte("//v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallBundle(src, dst, "0.0.190"); err != nil {
		t.Fatal(err)
	}
	got = InstalledVersions(dst)
	if len(got) != 2 {
		t.Fatalf("after reinstall: %+v", got)
	}

	// A source without an orchestrator is refused.
	notBundle := filepath.Join(root, "empty")
	if err := os.MkdirAll(notBundle, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallBundle(notBundle, dst, "0.0.191"); err == nil {
		t.Fatal("install from a non-bundle must fail")
	}
}

// Installing a bundle whose source manifest names another version lists and
// resolves it under the store directory name; the source commit is kept.
func TestInstallBundleAlignsManifestVersionWithDirectory(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "resources")
	makeBundle(t, src, BundleManifest{Version: "9.9.9", Commit: "sourca"})

	dst := t.TempDir()
	if _, err := InstallBundle(src, dst, "0.0.196"); err != nil {
		t.Fatal(err)
	}
	m, ok := readBundleManifest(filepath.Join(dst, "versions", "0.0.196"))
	if !ok || m.Version != "0.0.196" || m.Commit != "sourca" {
		t.Fatalf("manifest = %+v ok=%v", m, ok)
	}
	got := InstalledVersions(dst)
	if len(got) != 1 || got[0].Version != "0.0.196" || got[0].Commit != "sourca" {
		t.Fatalf("installed versions = %+v", got)
	}
	b, err := PinnedBundle(dst, "0.0.196")
	if err != nil {
		t.Fatal(err)
	}
	if version, commit := b.Version(); version != "0.0.196" || commit != "sourca" {
		t.Fatalf("version/commit = %q/%q", version, commit)
	}
}

// A Desktop bundle's real build-info.json shape (commitSha) is read through
// InstallBundle, InstalledVersions and Bundle.Version.
func TestBuildCommitFromCommitSha(t *testing.T) {
	const commit = "7807c228ed488496a7bc468aace868368fd605fa"

	root := t.TempDir()
	src := filepath.Join(root, "resources")
	makeBundle(t, src, BundleManifest{})
	if err := os.WriteFile(filepath.Join(src, "orchestrator", "build-info.json"), []byte(`{"commitSha":"`+commit+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readBuildCommit(src); got != commit {
		t.Fatalf("readBuildCommit = %q", got)
	}

	dst := t.TempDir()
	b, err := InstallBundle(src, dst, "0.0.196")
	if err != nil {
		t.Fatal(err)
	}
	got := InstalledVersions(dst)
	if len(got) != 1 || got[0].Version != "0.0.196" || got[0].Commit != commit {
		t.Fatalf("installed versions = %+v", got)
	}
	if version, build := b.Version(); version != "0.0.196" || build != commit {
		t.Fatalf("version/commit = %q/%q", version, build)
	}

	// Without a manifest, Version still reads build-info.json directly.
	bare := filepath.Join(dst, "versions", "0.0.197")
	makeBundle(t, bare, BundleManifest{})
	if err := os.WriteFile(filepath.Join(bare, "orchestrator", "build-info.json"), []byte(`{"commitSha":"`+commit+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if version, build := (Bundle{ResourcesDir: bare}).Version(); version != "0.0.197" || build != commit {
		t.Fatalf("bare version/commit = %q/%q", version, build)
	}
}

func TestCompareVersions(t *testing.T) {
	ordered := []string{"0.0.9", "0.0.188", "0.0.190", "0.0.196", "0.10.0", "1.0.0"}
	for i := 1; i < len(ordered); i++ {
		if compareVersions(ordered[i-1], ordered[i]) >= 0 {
			t.Errorf("%s should sort before %s", ordered[i-1], ordered[i])
		}
		if compareVersions(ordered[i], ordered[i-1]) <= 0 {
			t.Errorf("%s should sort after %s", ordered[i], ordered[i-1])
		}
	}
}
