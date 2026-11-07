package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeDshDetachedRunDir builds a run dir the way a detached launch leaves it.
// An empty exit/stderr string skips that file.
func writeDshDetachedRunDir(t *testing.T, taskID, stdout, stderr, exit string) (workDir, dir string) {
	t.Helper()
	workDir = t.TempDir()
	dir = filepath.Join(workDir, dshDetachedDir, dshDetachedUnit(taskID))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("stdout.jsonl", stdout)
	if stderr != "" {
		write("stderr.log", stderr)
	}
	if exit != "" {
		write("exit", exit)
	}
	return workDir, dir
}

func stubDshScope(t *testing.T, active, known bool) {
	t.Helper()
	orig := dshDetachedScopeActive
	dshDetachedScopeActive = func(string) (bool, bool) { return active, known }
	t.Cleanup(func() { dshDetachedScopeActive = orig })
}

const (
	recoverReadyFrame   = `{"v":1,"type":"ready","runtime":"dsh","protocol_version":1}` + "\n"
	recoverSessionFrame = `{"v":1,"type":"session","request_id":"task-r","session_id":"sess-1"}` + "\n"
	recoverUsageFrame   = `{"v":1,"type":"usage","request_id":"task-r","provider":"anthropic","model":"m1","input_tokens":10,"output_tokens":5}` + "\n"
	recoverResultFrame  = `{"v":1,"type":"result","request_id":"task-r","status":"completed","output":"all done","session_id":"sess-1"}` + "\n"
)

func TestRecoverDshDetachedRunFinishedWithResultFrame(t *testing.T) {
	stubDshScope(t, false, true)
	workDir, _ := writeDshDetachedRunDir(t, "task-r",
		recoverReadyFrame+recoverSessionFrame+recoverUsageFrame+recoverResultFrame, "", "0\n")

	out, err := RecoverDshDetachedRun(workDir, "task-r")
	if err != nil {
		t.Fatal(err)
	}
	if !out.Finished || out.Lost {
		t.Fatalf("outcome = %+v, want finished", out)
	}
	if out.Result.Status != "completed" || out.Result.Output != "all done" || out.Result.SessionID != "sess-1" {
		t.Fatalf("result = %+v", out.Result)
	}
	if got := out.Result.Usage["anthropic/m1"]; got.InputTokens != 10 || got.OutputTokens != 5 {
		t.Fatalf("usage = %+v", out.Result.Usage)
	}
	if out.Result.FirstPromptTokens != 10 || out.Result.LastPromptTokens != 10 {
		t.Fatalf("prompt tokens = %d/%d", out.Result.FirstPromptTokens, out.Result.LastPromptTokens)
	}
}

func TestRecoverDshDetachedRunFinishedNonZeroWithoutResult(t *testing.T) {
	stubDshScope(t, false, true)
	workDir, _ := writeDshDetachedRunDir(t, "task-r", recoverReadyFrame+recoverSessionFrame, "boom", "1\n")

	out, err := RecoverDshDetachedRun(workDir, "task-r")
	if err != nil {
		t.Fatal(err)
	}
	if !out.Finished || out.Result.Status != "failed" {
		t.Fatalf("outcome = %+v", out)
	}
	if !strings.Contains(out.Result.Error, "dsh exited with error: exit status 1") || !strings.Contains(out.Result.Error, "boom") {
		t.Fatalf("error = %q", out.Result.Error)
	}
	if out.Result.SessionID != "sess-1" {
		t.Fatalf("session id = %q, want it kept", out.Result.SessionID)
	}
}

func TestRecoverDshDetachedRunFinishedBeforeReady(t *testing.T) {
	stubDshScope(t, false, true)
	workDir, _ := writeDshDetachedRunDir(t, "task-r", "", "", "0\n")

	out, err := RecoverDshDetachedRun(workDir, "task-r")
	if err != nil {
		t.Fatal(err)
	}
	if !out.Finished || out.Result.Status != "failed" || out.Result.Error != "dsh exited before the runtime protocol became ready" {
		t.Fatalf("outcome = %+v", out)
	}
}

func TestRecoverDshDetachedRunFinishedWithoutTerminalResult(t *testing.T) {
	stubDshScope(t, false, true)
	workDir, _ := writeDshDetachedRunDir(t, "task-r", recoverReadyFrame, "", "0\n")

	out, err := RecoverDshDetachedRun(workDir, "task-r")
	if err != nil {
		t.Fatal(err)
	}
	if !out.Finished || out.Result.Error != "dsh exited without a terminal result" {
		t.Fatalf("outcome = %+v", out)
	}
}

func TestRecoverDshDetachedRunNoExitFileByScopeState(t *testing.T) {
	stdout := recoverReadyFrame + recoverSessionFrame
	tests := []struct {
		name          string
		active, known bool
		wantLost      bool
	}{
		{"scope active", true, true, false},
		{"scope inactive", false, true, true},
		{"scope unknown", false, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stubDshScope(t, tt.active, tt.known)
			workDir, _ := writeDshDetachedRunDir(t, "task-r", stdout, "killed", "")

			out, err := RecoverDshDetachedRun(workDir, "task-r")
			if err != nil {
				t.Fatal(err)
			}
			if out.Finished || out.Lost != tt.wantLost {
				t.Fatalf("outcome = %+v, want lost=%v", out, tt.wantLost)
			}
			if !tt.wantLost {
				if out.Result.Status != "" || out.Result.Error != "" {
					t.Fatalf("result must be empty when not decided: %+v", out.Result)
				}
				return
			}
			if out.Result.Status != "failed" || !strings.Contains(out.Result.Error, dshDetachedLostError) ||
				!strings.Contains(out.Result.Error, "killed") || out.Result.SessionID != "sess-1" {
				t.Fatalf("lost result = %+v", out.Result)
			}
		})
	}
}

func TestRecoverDshDetachedRunIgnoresPartialLineAndForeignRequest(t *testing.T) {
	stubDshScope(t, false, true)
	foreign := `{"v":1,"type":"result","request_id":"other-task","status":"completed","output":"not mine"}` + "\n"
	partial := `{"v":1,"type":"result","request_id":"task-r","status":"comple`
	workDir, _ := writeDshDetachedRunDir(t, "task-r", recoverReadyFrame+foreign+"not json\n"+partial, "", "2\n")

	out, err := RecoverDshDetachedRun(workDir, "task-r")
	if err != nil {
		t.Fatal(err)
	}
	if !out.Finished || out.Result.Status != "failed" || strings.Contains(out.Result.Output, "not mine") {
		t.Fatalf("outcome = %+v", out)
	}
	if !strings.Contains(out.Result.Error, "exit status 2") {
		t.Fatalf("error = %q", out.Result.Error)
	}
}

func TestRecoverDshDetachedRunEmptyExitFileIsNotFinished(t *testing.T) {
	stubDshScope(t, true, true)
	workDir, dir := writeDshDetachedRunDir(t, "task-r", recoverReadyFrame, "", "")
	if err := os.WriteFile(filepath.Join(dir, "exit"), nil, 0o600); err != nil {
		t.Fatal(err)
	}

	out, err := RecoverDshDetachedRun(workDir, "task-r")
	if err != nil {
		t.Fatalf("an unreadable exit record must not surface as an error: %v", err)
	}
	if out.Finished || out.Lost {
		t.Fatalf("outcome = %+v, want undecided", out)
	}
}

func TestRecoverDshDetachedRunMissingDir(t *testing.T) {
	if _, err := RecoverDshDetachedRun(t.TempDir(), "task-none"); err == nil {
		t.Fatal("want an error for a missing run dir")
	}
}

func TestRecoverDshDetachedRunKeepsRunFiles(t *testing.T) {
	stubDshScope(t, false, true)
	workDir, dir := writeDshDetachedRunDir(t, "task-r", recoverReadyFrame+recoverResultFrame, "err", "0\n")

	if _, err := RecoverDshDetachedRun(workDir, "task-r"); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"stdout.jsonl": recoverReadyFrame + recoverResultFrame, "stderr.log": "err", "exit": "0\n",
	} {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q, %v; recovery must not modify the run record", name, got, err)
		}
	}
}

func TestWatchDshDetachedRunReturnsResultOnceFinished(t *testing.T) {
	stubDshScope(t, true, true)
	workDir, dir := writeDshDetachedRunDir(t, "task-r", recoverReadyFrame, "", "")

	go func() {
		time.Sleep(60 * time.Millisecond)
		_ = os.WriteFile(filepath.Join(dir, "stdout.jsonl"), []byte(recoverReadyFrame+recoverSessionFrame+recoverResultFrame), 0o600)
		_ = os.WriteFile(filepath.Join(dir, "exit"), []byte("0\n"), 0o600)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := WatchDshDetachedRun(ctx, workDir, "task-r", 10*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "completed" || res.Output != "all done" || res.SessionID != "sess-1" {
		t.Fatalf("result = %+v", res)
	}
}

func TestWatchDshDetachedRunContextCancel(t *testing.T) {
	stubDshScope(t, true, true)
	workDir, _ := writeDshDetachedRunDir(t, "task-r", recoverReadyFrame, "", "")

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := WatchDshDetachedRun(ctx, workDir, "task-r", 10*time.Millisecond)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want context deadline", err)
	}

	cctx, ccancel := context.WithCancel(context.Background())
	ccancel()
	if _, err := WatchDshDetachedRun(cctx, workDir, "task-r", time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestWatchDshDetachedRunReturnsLost(t *testing.T) {
	stubDshScope(t, false, true)
	workDir, _ := writeDshDetachedRunDir(t, "task-r", recoverReadyFrame, "", "")

	res, err := WatchDshDetachedRun(context.Background(), workDir, "task-r", 10*time.Millisecond)
	if err != nil || res.Status != "failed" || !strings.Contains(res.Error, dshDetachedLostError) {
		t.Fatalf("result = %+v, err = %v", res, err)
	}
}

func TestWatchDshDetachedRunMissingDir(t *testing.T) {
	if _, err := WatchDshDetachedRun(context.Background(), t.TempDir(), "task-none", 10*time.Millisecond); err == nil {
		t.Fatal("want an error for a missing run dir")
	}
}

func TestRecoverDshDetachedRunNonzeroOverridesResultFrame(t *testing.T) {
	workDir, _ := writeDshDetachedRunDir(t, "task-r", recoverReadyFrame+recoverSessionFrame+recoverResultFrame, "boom", "2\n")
	out, err := RecoverDshDetachedRun(workDir, "task-r")
	if err != nil {
		t.Fatal(err)
	}
	if !out.Finished || out.Result.Status != "failed" || !strings.Contains(out.Result.Error, "exit status 2") {
		t.Fatalf("unexpected outcome: %+v", out)
	}
}
