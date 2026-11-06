package freebuffrt

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The bundle version store.
//
// A runtime directory (FREEBUFF_RUNTIME_DIR) can hold any number of
// orchestrator bundles side by side, one per Desktop release:
//
//	<runtimeDir>/versions/0.0.188/orchestrator/orchestrator.js
//	<runtimeDir>/versions/0.0.196/orchestrator/orchestrator.js
//	<runtimeDir>/versions/<semver>/manifest.json
//
// Each entry is a Desktop resources directory, exactly what the legacy single
// path pointed at. The store directory name is the bundle's version; its
// manifest.json records that version and the commit the bundle was built
// from. A bundle without one is still listed, by its directory name. Legacy
// layouts (orchestrator/ directly under the runtime dir) keep working: a
// version pin is what selects the store, and no pin means the resolution
// order in ResolveBundle is unchanged.

// EnvAppVersion pins which installed bundle version a runtime's orchestrator
// runs. It is read through the same setting path as FREEBUFF_BUN_PATH
// (runtime env, then the daemon's own environment).
const EnvAppVersion = "FREEBUFF_APP_VERSION"

// versionsDirName is the store directory under the runtime dir.
const versionsDirName = "versions"

// BundleManifest is the manifest.json inside an installed bundle.
type BundleManifest struct {
	Version string `json:"version"`
	// Commit is the build the bundle was made from; empty for bundles
	// installed without build metadata.
	Commit string `json:"commit,omitempty"`
}

// InstalledBundle is one bundle in the version store.
type InstalledBundle struct {
	Version string
	// Commit is the bundle's build commit, when its manifest records one.
	Commit string
	// Dir is the bundle's resources directory.
	Dir string
}

// VersionsDir is the bundle store of a runtime directory.
func VersionsDir(runtimeDir string) string {
	return filepath.Join(runtimeDir, versionsDirName)
}

// ValidateVersion rejects anything that is not a plain directory name, so a
// pin or an install target cannot escape the store.
func ValidateVersion(version string) error {
	if version == "" || version != filepath.Base(version) ||
		strings.ContainsAny(version, `/\`) || version == "." || version == ".." ||
		version != strings.TrimSpace(version) {
		return fmt.Errorf("invalid freebuff engine version %q", version)
	}
	return nil
}

// readBundleManifest reads a bundle's manifest.json. A bundle without one is
// not an error — the caller falls back to the directory name.
func readBundleManifest(resourcesDir string) (BundleManifest, bool) {
	raw, err := os.ReadFile(filepath.Join(resourcesDir, "manifest.json"))
	if err != nil {
		return BundleManifest{}, false
	}
	var m BundleManifest
	if json.Unmarshal(raw, &m) != nil || m.Version == "" {
		return BundleManifest{}, false
	}
	return m, true
}

// InstalledVersions lists the bundles in a runtime's store, oldest first.
// Each bundle is listed under its store directory name — the version a pin
// resolves; anything that is not a directory (or holds no orchestrator) is
// skipped. The commit comes from the bundle's manifest or build-info.json.
func InstalledVersions(runtimeDir string) []InstalledBundle {
	entries, err := os.ReadDir(VersionsDir(runtimeDir))
	if err != nil {
		return nil
	}
	var out []InstalledBundle
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(VersionsDir(runtimeDir), e.Name())
		b := Bundle{ResourcesDir: dir}
		if fi, err := os.Stat(b.OrchestratorPath()); err != nil || fi.IsDir() {
			continue
		}
		version := e.Name()
		commit := ""
		if m, ok := readBundleManifest(dir); ok {
			commit = m.Commit
		}
		if commit == "" {
			// Installs written before commitSha was read carry a manifest
			// without a commit; the bundle's build-info.json still has it.
			commit = readBuildCommit(dir)
		}
		out = append(out, InstalledBundle{Version: version, Commit: commit, Dir: dir})
	}
	sort.Slice(out, func(i, j int) bool { return compareVersions(out[i].Version, out[j].Version) < 0 })
	return out
}

// compareVersions orders version strings numerically per dot-separated
// component; non-numeric components compare as strings. It is a display
// order, not a full semver implementation.
func compareVersions(a, b string) int {
	as := strings.Split(a, ".")
	bs := strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		var av, bv int
		var aRest, bRest string
		if i < len(as) {
			n, _ := fmt.Sscanf(as[i], "%d%s", &av, &aRest)
			if n == 0 {
				av, aRest = 0, as[i]
			}
		}
		if i < len(bs) {
			n, _ := fmt.Sscanf(bs[i], "%d%s", &bv, &bRest)
			if n == 0 {
				bv, bRest = 0, bs[i]
			}
		}
		if av != bv {
			if av < bv {
				return -1
			}
			return 1
		}
		if aRest != bRest {
			if aRest < bRest {
				return -1
			}
			return 1
		}
	}
	return 0
}

// PinnedBundle resolves the bundle a FREEBUFF_APP_VERSION pin selects. It
// fails closed: an unknown version is an error that names the installed
// versions, never a silent fallback to another bundle.
func PinnedBundle(runtimeDir, version string) (Bundle, error) {
	if err := ValidateVersion(version); err != nil {
		return Bundle{}, err
	}
	if runtimeDir == "" {
		return Bundle{}, fmt.Errorf("%s requires %s", EnvAppVersion, EnvRuntimeDir)
	}
	b := Bundle{ResourcesDir: filepath.Join(VersionsDir(runtimeDir), version)}
	if fi, err := os.Stat(b.OrchestratorPath()); err == nil && !fi.IsDir() {
		return b, nil
	}
	installed := InstalledVersions(runtimeDir)
	names := make([]string, 0, len(installed))
	for _, in := range installed {
		names = append(names, in.Version)
	}
	if len(names) == 0 {
		return Bundle{}, fmt.Errorf("%s %q is not installed and no versions are installed under %s",
			EnvAppVersion, version, VersionsDir(runtimeDir))
	}
	return Bundle{}, fmt.Errorf("%s %q is not installed; installed versions: %s",
		EnvAppVersion, version, strings.Join(names, ", "))
}

// InstallBundle copies a Desktop resources directory (or an export of one)
// into the version store as version. The copy lands atomically: it is built
// under a temporary directory and renamed into place only when complete, so a
// failed install never leaves a half bundle behind. The installed manifest's
// version is the store directory name; the manifest's commit (or the source
// build-info.json's) is kept.
func InstallBundle(srcDir, runtimeDir, version string) (Bundle, error) {
	if err := ValidateVersion(version); err != nil {
		return Bundle{}, err
	}
	src := Bundle{ResourcesDir: srcDir}
	if fi, err := os.Stat(src.OrchestratorPath()); err != nil || fi.IsDir() {
		return Bundle{}, fmt.Errorf("%s is not a freebuff bundle: no orchestrator/orchestrator.js", srcDir)
	}
	if err := os.MkdirAll(VersionsDir(runtimeDir), 0o755); err != nil {
		return Bundle{}, err
	}
	tmp, err := os.MkdirTemp(VersionsDir(runtimeDir), ".install-")
	if err != nil {
		return Bundle{}, err
	}
	defer os.RemoveAll(tmp)

	if err := copyTree(srcDir, tmp); err != nil {
		return Bundle{}, err
	}
	m, ok := readBundleManifest(tmp)
	if !ok || m.Version != version {
		if m.Commit == "" {
			m.Commit = readBuildCommit(srcDir)
		}
		m.Version = version
		raw, err := json.Marshal(m)
		if err != nil {
			return Bundle{}, err
		}
		if err := os.WriteFile(filepath.Join(tmp, "manifest.json"), raw, 0o644); err != nil {
			return Bundle{}, err
		}
	}
	dst := filepath.Join(VersionsDir(runtimeDir), version)
	if err := os.RemoveAll(dst); err != nil {
		return Bundle{}, err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return Bundle{}, err
	}
	return Bundle{ResourcesDir: dst}, nil
}

// readBuildCommit picks up the bundle's build commit from build-info.json,
// the file the orchestrator build writes alongside itself. Desktop builds
// write the commit as "commitSha"; older shapes used "commit" or "sha".
func readBuildCommit(resourcesDir string) string {
	raw, err := os.ReadFile(filepath.Join(resourcesDir, "orchestrator", "build-info.json"))
	if err != nil {
		return ""
	}
	var info struct {
		CommitSHA string `json:"commitSha"`
		Commit    string `json:"commit"`
		SHA       string `json:"sha"`
	}
	if json.Unmarshal(raw, &info) != nil {
		return ""
	}
	switch {
	case info.CommitSHA != "":
		return info.CommitSHA
	case info.Commit != "":
		return info.Commit
	default:
		return info.SHA
	}
}

// copyTree copies src into dst, preserving file modes. Symlinks are copied
// as files (their content read through), which is what a bundle export needs.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if d.Type()&fs.ModeSymlink != 0 {
			real, err := filepath.EvalSymlinks(path)
			if err != nil {
				return err
			}
			fi, err := os.Stat(real)
			if err != nil {
				return err
			}
			if fi.IsDir() {
				return copyTree(real, target)
			}
			d = fs.FileInfoToDirEntry(fi)
			path = real
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		mode := fs.FileMode(0o644)
		if fi, err := d.Info(); err == nil {
			mode = fi.Mode().Perm()
		}
		return os.WriteFile(target, raw, mode)
	})
}
