package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/pkg/freebuffrt"
)

// Freebuff engine version management. These commands run on the daemon's
// machine, where the orchestrator bundles live: a bundle is installed into
// the version store under FREEBUFF_RUNTIME_DIR, and the daemon reports the
// store's contents to the server on its next account refresh. Selecting a
// version for a runtime happens on the runtime page (or by setting
// FREEBUFF_APP_VERSION), never here.

var runtimeFreebuffCmd = &cobra.Command{
	Use:   "freebuff",
	Short: "Manage the Freebuff engine on this machine",
	Long: "Install and list Freebuff orchestrator bundles for this machine's " +
		"version store. Bundles install under the runtime directory named by " +
		"FREEBUFF_RUNTIME_DIR (or --runtime-dir); pick one per runtime on its " +
		"runtime page with the engine version dropdown.",
}

var runtimeFreebuffInstallVersionCmd = &cobra.Command{
	Use:   "install-version <resources-dir-or-deb>",
	Short: "Install a Freebuff orchestrator bundle into the version store",
	Long: "Copy a Freebuff Desktop resources directory (or extract a .deb and " +
		"use its resources) into the version store as a named version. The " +
		"source must contain orchestrator/orchestrator.js.",
	Args: exactArgs(1),
	RunE: runRuntimeFreebuffInstallVersion,
}

var runtimeFreebuffListVersionsCmd = &cobra.Command{
	Use:   "list-versions",
	Short: "List the installed Freebuff orchestrator bundles",
	Args:  cobra.NoArgs,
	RunE:  runRuntimeFreebuffListVersions,
}

func init() {
	runtimeCmd.AddCommand(runtimeFreebuffCmd)
	runtimeFreebuffCmd.AddCommand(runtimeFreebuffInstallVersionCmd)
	runtimeFreebuffCmd.AddCommand(runtimeFreebuffListVersionsCmd)

	// runtime freebuff install-version
	runtimeFreebuffInstallVersionCmd.Flags().String("version", "", "Version name to install as, e.g. 0.0.196 (required)")
	runtimeFreebuffInstallVersionCmd.Flags().String("runtime-dir", "", "Bundle root (defaults to FREEBUFF_RUNTIME_DIR)")

	// runtime freebuff list-versions
	runtimeFreebuffListVersionsCmd.Flags().String("runtime-dir", "", "Bundle root (defaults to FREEBUFF_RUNTIME_DIR)")
	runtimeFreebuffListVersionsCmd.Flags().String("output", "table", "Output format: table or json")
}

// freebuffBundleRoot resolves the version store's root from --runtime-dir or
// the environment, the same knobs the daemon resolves bundles with.
func freebuffBundleRoot(cmd *cobra.Command) (string, error) {
	dir, _ := cmd.Flags().GetString("runtime-dir")
	if dir == "" {
		dir = os.Getenv(freebuffrt.EnvRuntimeDir)
	}
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("no bundle root: pass --runtime-dir or set %s", freebuffrt.EnvRuntimeDir)
	}
	return dir, nil
}

func runRuntimeFreebuffInstallVersion(cmd *cobra.Command, args []string) error {
	version, _ := cmd.Flags().GetString("version")
	if strings.TrimSpace(version) == "" {
		return fmt.Errorf("--version is required")
	}
	if err := freebuffrt.ValidateVersion(version); err != nil {
		return err
	}
	runtimeDir, err := freebuffBundleRoot(cmd)
	if err != nil {
		return err
	}
	src := args[0]

	var cleanup func()
	if strings.HasSuffix(strings.ToLower(src), ".deb") {
		src, cleanup, err = extractDebResources(src, runtimeDir)
		if err != nil {
			return err
		}
		defer cleanup()
	}

	bundle, err := freebuffrt.InstallBundle(src, runtimeDir, version)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Installed Freebuff engine %s at %s.\n", version, bundle.ResourcesDir)
	fmt.Fprintf(os.Stderr, "Select it for a runtime on its runtime page; it applies on the next run.\n")
	return nil
}

func runRuntimeFreebuffListVersions(cmd *cobra.Command, _ []string) error {
	runtimeDir, err := freebuffBundleRoot(cmd)
	if err != nil {
		return err
	}
	installed := freebuffrt.InstalledVersions(runtimeDir)

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		type versionRow struct {
			Version string `json:"version"`
			Commit  string `json:"commit,omitempty"`
			Dir     string `json:"dir"`
		}
		rows := make([]versionRow, 0, len(installed))
		for _, in := range installed {
			rows = append(rows, versionRow{Version: in.Version, Commit: in.Commit, Dir: in.Dir})
		}
		return cli.PrintJSON(os.Stdout, rows)
	}

	headers := []string{"VERSION", "COMMIT", "DIR"}
	rows := make([][]string, 0, len(installed))
	for _, in := range installed {
		rows = append(rows, []string{in.Version, in.Commit, in.Dir})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	return nil
}

// extractDebResources unpacks a Freebuff Desktop .deb and returns the
// directory that holds the orchestrator bundle, plus a cleanup that removes
// the extraction. Work stays inside the bundle root — never a system temp
// dir — and system ar/tar do the unpacking, so every compression the
// package's data tarball uses is supported wherever they exist.
func extractDebResources(debPath, runtimeDir string) (string, func(), error) {
	work, err := os.MkdirTemp(filepath.Dir(freebuffrt.VersionsDir(runtimeDir)), ".deb-install-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { os.RemoveAll(work) }

	run := func(name string, args ...string) error {
		c := exec.Command(name, args...)
		c.Dir = work
		if out, err := c.CombinedOutput(); err != nil {
			return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
		}
		return nil
	}

	if err := run("ar", "x", abs(debPath)); err != nil {
		cleanup()
		return "", nil, err
	}
	// The package's payload is its data tarball, whatever compression it uses.
	entries, err := os.ReadDir(work)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	extractDir := filepath.Join(work, "extract")
	if err := os.MkdirAll(extractDir, 0o755); err != nil {
		cleanup()
		return "", nil, err
	}
	found := false
	for _, e := range entries {
		name := e.Name()
		if name == "data.tar" || strings.HasPrefix(name, "data.tar.") {
			found = true
			if err := run("tar", "-xf", name, "-C", "extract"); err != nil {
				cleanup()
				return "", nil, err
			}
		}
	}
	if !found {
		cleanup()
		return "", nil, fmt.Errorf("%s holds no data tarball: not a Debian package", debPath)
	}

	resources, err := findOrchestratorDir(extractDir)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	return resources, cleanup, nil
}

func abs(path string) string {
	a, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return a
}

// findOrchestratorDir walks an extracted package for the resources directory
// holding orchestrator/orchestrator.js, preferring the deepest match (the
// bundle proper rather than a wrapper).
func findOrchestratorDir(root string) (string, error) {
	var match string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() || d.Name() != "orchestrator" {
			return nil
		}
		if _, err := os.Stat(filepath.Join(path, "orchestrator.js")); err != nil {
			return nil
		}
		dir := filepath.Dir(path)
		if match == "" || len(dir) > len(match) {
			match = dir
		}
		return filepath.SkipDir
	})
	if err != nil {
		return "", err
	}
	if match == "" {
		return "", fmt.Errorf("the package holds no orchestrator bundle: no directory with orchestrator/orchestrator.js")
	}
	return match, nil
}
