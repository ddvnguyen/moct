package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	agentpkg "github.com/multica-ai/multica/server/pkg/agent"
)

// TestOpenCodeV2AcceptsSynthesizedMCPWithoutAgentConfig covers the seam between
// what the daemon composes and what the OpenCode backend accepts.
//
// ExecOptions.McpConfig is not agent.mcp_config. The daemon folds several
// sources into it — workspace MCP servers bound to the agent (at claim), the
// task's integration servers and the plugin-hook tool server (at run, via
// mergeTaskRemoteMCPConfig), and the runtime's own servers. An agent with no MCP
// configuration of its own therefore still reaches a 2.x runtime carrying
// servers, and that run must deliver them through the run transport's env
// channel (a private server: `--standalone`), not refuse them.
//
// This is here rather than in pkg/agent because only this side can use the real
// merge helper: pkg/agent cannot import the daemon. It pins both halves — that
// the daemon really does synthesize a config from nothing, and that the run
// starts with the result instead of failing.
func TestOpenCodeV2AcceptsSynthesizedMCPWithoutAgentConfig(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI is a shell script")
	}

	// What a task with integration or plugin-hook tools contributes. The agent
	// itself has nothing configured: base is nil.
	overlay := json.RawMessage(`{"mcpServers":{"composio-github":{"type":"remote","url":"https://example.invalid/mcp","headers":{"Authorization":"Bearer FAKE-WIRING-TOKEN"}}}}`)
	composed, err := mergeTaskRemoteMCPConfig(nil, overlay)
	if err != nil {
		t.Fatalf("merge task remote MCP config: %v", err)
	}
	if len(composed) == 0 {
		t.Fatal("expected the daemon to synthesize an MCP config from a nil agent config")
	}

	dir := t.TempDir()
	envFile := filepath.Join(dir, "env.txt")
	argsFile := filepath.Join(dir, "argv.txt")
	fakeCLI := filepath.Join(dir, "opencode")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"" + argsFile + "\"\n" +
		"printf '%s\\n' \"$OPENCODE_CONFIG_CONTENT\" > \"" + envFile + "\"\n" +
		"printf '{\"type\":\"step_start\",\"sessionID\":\"ses\",\"part\":{}}\\n'\n" +
		"printf '{\"type\":\"step_finish\",\"sessionID\":\"ses\",\"part\":{}}\\n'\n"
	if err := os.WriteFile(fakeCLI, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake cli: %v", err)
	}

	backend, err := agentpkg.New("opencode", agentpkg.Config{
		ExecutablePath: fakeCLI,
		CLIVersion:     "opencode v2.0.10",
		BuiltinRuntime: true,
		Env:            map[string]string{"MULTICA_OPENCODE_TRANSPORT": "run"},
		Logger:         slog.Default(),
	})
	if err != nil {
		t.Fatalf("new opencode backend: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	session, execErr := backend.Execute(ctx, "prompt-ignored", agentpkg.ExecOptions{
		Cwd:       t.TempDir(),
		McpConfig: composed,
		Timeout:   5 * time.Second,
	})
	if execErr != nil {
		t.Fatalf("expected the composed MCP config to be accepted, got %v", execErr)
	}
	go func() {
		for range session.Messages {
		}
	}()
	<-session.Result

	got, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatalf("read env capture: %v", err)
	}
	if !strings.Contains(string(got), "composio-github") {
		t.Fatalf("2.x run lost the composed MCP server: %q", got)
	}
	argv, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read argv capture: %v", err)
	}
	if !strings.Contains(string(argv), "--standalone") {
		t.Fatalf("2.x run must own a private server, argv = %q", argv)
	}
}
