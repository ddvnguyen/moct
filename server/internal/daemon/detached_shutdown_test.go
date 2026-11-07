package daemon

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
)

func TestDetachedShutdownReport(t *testing.T) {
	for _, tc := range []struct {
		name               string
		detached, shutdown bool
		wantFail           int32
	}{
		{"detached shutdown", true, true, 0},
		{"ordinary shutdown", false, true, 1},
		{"detached ordinary cancellation", true, false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var fail atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/fail") {
					fail.Add(1)
				}
				_, _ = w.Write([]byte(`{"status":"running"}`))
			}))
			defer srv.Close()
			root, cancel := context.WithCancel(context.Background())
			defer cancel()
			d := &Daemon{client: NewClient(srv.URL), logger: slog.New(slog.NewTextHandler(io.Discard, nil)), workspaces: make(map[string]*workspaceState), runtimeIndex: map[string]Runtime{"rt": {ID: "rt", Provider: "dsh"}}, activeEnvRoots: make(map[string]int), cancelPollInterval: time.Hour}
			d.runner = taskRunnerFunc(func(ctx context.Context, _ Task, _ string, _ int, _ *slog.Logger) (TaskResult, error) {
				if tc.detached {
					detachedShutdownFromContext(ctx).started.Store(true)
				}
				if tc.shutdown {
					cancel()
				}
				return TaskResult{Status: "cancelled"}, nil
			})
			d.handleTask(root, Task{ID: "task", WorkspaceID: "ws", RuntimeID: "rt", IssueID: "issue", Agent: &AgentData{Name: "test"}}, 0)
			if got := fail.Load(); got != tc.wantFail {
				t.Fatalf("failure reports = %d, want %d", got, tc.wantFail)
			}
		})
	}
}

func TestRecoveredDetachedReportUsesDaemonCredentialsAndSkipsTerminal(t *testing.T) {
	var calls atomic.Int32
	status := "running"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer new-daemon-token" {
			http.Error(w, "expired task token", http.StatusUnauthorized)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/status") {
			_, _ = w.Write([]byte(`{"status":"` + status + `"}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/complete") {
			calls.Add(1)
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	client := NewClient(srv.URL)
	client.SetToken("new-daemon-token")
	d := &Daemon{client: client, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	d.reportRecoveredDetachedTask(context.Background(), "task", agent.Result{Status: "completed", Output: "done"})
	status = "completed"
	d.reportRecoveredDetachedTask(context.Background(), "task", agent.Result{Status: "completed", Output: "done"})
	if got := calls.Load(); got != 1 {
		t.Fatalf("completion reports = %d, want 1", got)
	}
}

func TestRunTaskDetachedShutdownPreservesWorktree(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("detached dsh is Linux only")
	}
	repo := t.TempDir()
	gitOK(t, repo, "init", "-q", "-b", "main")
	gitOK(t, repo, "config", "user.name", "Test")
	gitOK(t, repo, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(repo, "source.txt"), []byte("source\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitOK(t, repo, "add", "-A")
	gitOK(t, repo, "commit", "-q", "-m", "initial")
	binDir := t.TempDir()
	writeTestExecutable(t, filepath.Join(binDir, "systemd-run"), []byte("#!/bin/sh\nwhile [ \"$1\" != \"--\" ]; do shift; done\nshift\nexec \"$@\"\n"))
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))
	t.Setenv("MULTICA_DETACHED_RUNTIME", "1")
	bin := filepath.Join(binDir, "dsh")
	writeTestExecutable(t, bin, []byte("#!/bin/sh\nIFS= read -r execute\necho work > child-work.txt\nsleep 4\nprintf '%s\\n' '{\"v\":1,\"type\":\"result\",\"request_id\":\"task-worktree\",\"status\":\"completed\",\"output\":\"done\"}'\n"))
	pinned := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/session") {
			var body struct {
				WorkDir string `json:"work_dir"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.WorkDir != "" {
				select {
				case pinned <- body.WorkDir:
				default:
				}
			}
		}
		_, _ = w.Write([]byte(`{"status":"running"}`))
	}))
	defer srv.Close()
	d := &Daemon{client: NewClient(srv.URL), logger: slog.New(slog.NewTextHandler(io.Discard, nil)), workspaces: make(map[string]*workspaceState), runtimeIndex: map[string]Runtime{"rt": {ID: "rt", Provider: "dsh"}}, activeEnvRoots: make(map[string]int), localPathLocks: NewLocalPathLocker(), cfg: Config{DaemonID: "daemon", WorkspacesRoot: t.TempDir(), ServerBaseURL: srv.URL, Agents: map[string]AgentEntry{"dsh": {Path: bin}}}}
	ref, err := json.Marshal(localDirectoryRef{LocalPath: repo, DaemonID: "daemon", ExecutionMode: localDirectoryModeWorktree})
	if err != nil {
		t.Fatal(err)
	}
	task := Task{ID: "task-worktree", WorkspaceID: "ws", RuntimeID: "rt", IssueID: "issue", AgentID: "agent", AuthToken: "mat_test", Agent: &AgentData{ID: "agent", Name: "test"}, ProjectResources: []ProjectResourceData{{ID: "resource", ResourceType: localDirectoryResourceType, ResourceRef: ref}}}
	root, cancel := context.WithCancel(context.Background())
	defer cancel()
	state := &detachedShutdownState{root: root}
	ctx := context.WithValue(root, detachedShutdownKey{}, state)
	done := make(chan error, 1)
	go func() { _, err := d.runTask(ctx, task, "dsh", 0, d.logger); done <- err }()
	var workDir string
	select {
	case workDir = <-pinned:
	case err := <-done:
		t.Fatalf("run returned before workdir was pinned: %v", err)
	case <-time.After(15 * time.Second):
		t.Fatal("workdir was not pinned")
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(workDir, "child-work.txt")); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("run returned before child started: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("child did not start")
		}
		time.Sleep(25 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runTask: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("shutdown did not drain")
	}
	if _, err := os.Stat(filepath.Join(workDir, "child-work.txt")); err != nil {
		t.Fatalf("worktree was finalized on shutdown: %v", err)
	}
	exitPath := filepath.Join(workDir, ".multica-detached", "multica-dsh-task-worktree", "exit")
	deadline = time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(exitPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child did not finish")
		}
		time.Sleep(25 * time.Millisecond)
	}
}
