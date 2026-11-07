package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDshDetachedUnitName(t *testing.T) {
	if got, want := dshDetachedUnit("01a1/task id"), dshDetachedUnitPrefix+"01a1_task_id"; got != want {
		t.Fatalf("unit = %q, want %q", got, want)
	}
	if !strings.HasPrefix(dshDetachedUnit(""), dshDetachedUnitPrefix) {
		t.Fatalf("unit for an empty task id must still be a valid name: %q", dshDetachedUnit(""))
	}
}

// TestDshDetachedArgv pins the launch shape: the command runs inside its own
// transient user scope, through the wrapper that records the exit status, with
// the real executable and its args passed positionally so no re-quoting is
// involved.
func TestDshDetachedArgv(t *testing.T) {
	dir := t.TempDir()
	plan, err := prepareDshDetachedRun(dir, "task-argv")
	if err != nil {
		t.Fatal(err)
	}
	defer plan.Close()

	argv := plan.argv("/usr/bin/dsh", []string{"--profile", "multica", "--stdio"})
	want := []string{
		"--user", "--scope", "--quiet", "--unit", plan.unit, "--",
		"sh", "-c", `"$@"; status=$?; printf '%d\n' "$status" > "$MULTICA_DETACHED_EXIT"; exit $status`,
		"multica-detached",
		"/usr/bin/dsh", "--profile", "multica", "--stdio",
	}
	if strings.Join(argv, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %q, want %q", argv, want)
	}
}

// TestDshDetachedExecuteFrameIsStdin proves the child receives the protocol's
// execute frame from a file rather than a daemon pipe.
func TestDshDetachedExecuteFrameIsStdin(t *testing.T) {
	plan, err := prepareDshDetachedRun(t.TempDir(), "task-frame")
	if err != nil {
		t.Fatal(err)
	}
	defer plan.Close()

	frame := dshExecuteCommand{Version: DshProtocolVersion, Type: "execute", RequestID: "req-1", Prompt: "hello"}
	if err := plan.writeExecuteFrame(frame); err != nil {
		t.Fatalf("writeExecuteFrame: %v", err)
	}
	stdin, err := plan.stdinReader()
	if err != nil {
		t.Fatalf("stdinReader: %v", err)
	}
	defer func() { _ = stdin.Close() }()
	var got dshExecuteCommand
	if err := json.NewDecoder(stdin).Decode(&got); err != nil {
		t.Fatalf("decode frame from stdin: %v", err)
	}
	if got.RequestID != "req-1" || got.Prompt != "hello" {
		t.Fatalf("frame = %+v", got)
	}
}

// TestDshDetachedWrapperRecordsExitStatus runs the wrapper exactly as the scope
// runs it and checks the exit record a recovering daemon reads. No systemd
// involved: this is the wrapper's contract.
func TestDshDetachedWrapperRecordsExitStatus(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell")
	}
	plan, err := prepareDshDetachedRun(t.TempDir(), "task-exit")
	if err != nil {
		t.Fatal(err)
	}
	defer plan.Close()

	// Same command line the scope runs, minus systemd-run: "sh -c <script>
	// multica-detached <exec> <args...>".
	argv := plan.argv("/bin/sh", []string{"-c", "exit 7"})[6:]
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "MULTICA_DETACHED_EXIT="+plan.exitPath)
	if err := cmd.Run(); err == nil {
		t.Fatal("wrapper must propagate the child's non-zero status")
	}

	status, ok, err := plan.exitStatus()
	if err != nil {
		t.Fatalf("exitStatus: %v", err)
	}
	if !ok || status != 7 {
		t.Fatalf("exit record = (%d, %v), want (7, true)", status, ok)
	}
}

// TestDshDetachedExitStatusMissingMeansUnfinished is the recovering daemon's
// signal: no record means the wrapper never finished.
func TestDshDetachedExitStatusMissingMeansUnfinished(t *testing.T) {
	plan, err := prepareDshDetachedRun(t.TempDir(), "task-unfinished")
	if err != nil {
		t.Fatal(err)
	}
	defer plan.Close()

	if _, ok, err := plan.exitStatus(); ok || err != nil {
		t.Fatalf("exitStatus = (_, %v, %v), want (false, nil)", ok, err)
	}
}

// TestDshDetachedStdoutReaderFollowsFile covers the live stream: the reader sees
// bytes appended after it started, and terminates when the run is told the
// process exited.
func TestDshDetachedStdoutReaderFollowsFile(t *testing.T) {
	plan, err := prepareDshDetachedRun(t.TempDir(), "task-tail")
	if err != nil {
		t.Fatal(err)
	}
	defer plan.Close()

	done := make(chan struct{})
	reader := plan.stdoutReader(done)
	readCh := make(chan string, 1)
	go func() {
		buf := make([]byte, 0, 256)
		tmp := make([]byte, 128)
		for {
			n, err := reader.Read(tmp)
			buf = append(buf, tmp[:n]...)
			if err != nil {
				readCh <- string(buf)
				return
			}
		}
	}()

	if _, err := plan.stdoutFile.WriteString("first\n"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * dshDetachedPollInterval)
	if _, err := plan.stdoutFile.WriteString("second\n"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * dshDetachedPollInterval)
	close(done)

	select {
	case got := <-readCh:
		if got != "first\nsecond\n" {
			t.Fatalf("stream = %q, want %q", got, "first\nsecond\n")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("tail reader did not terminate after done")
	}
}

// writeFakeSystemdRun puts an executable systemd-run on a fresh PATH and
// returns that directory.
func writeFakeSystemdRun(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	writeTestExecutable(t, filepath.Join(dir, "systemd-run"), []byte(script))
	return dir
}

// TestDshDetachedAvailable pins the one predicate the daemon advertises under
// and the launcher launches under: Linux, a true MULTICA_DETACHED_RUNTIME in the
// daemon's boolean vocabulary, and systemd-run on PATH.
func TestDshDetachedAvailable(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("detached runs are Linux only")
	}
	withSystemdRun := writeFakeSystemdRun(t, "#!/bin/sh\nexit 0\n")
	withoutSystemdRun := t.TempDir()

	cases := []struct {
		name string
		path string
		env  string
		want bool
	}{
		{"true", withSystemdRun, "true", true},
		{"one", withSystemdRun, "1", true},
		{"upper yes", withSystemdRun, "YES", true},
		{"padded on", withSystemdRun, " on ", true},
		{"unset", withSystemdRun, "", false},
		{"zero", withSystemdRun, "0", false},
		{"false", withSystemdRun, "false", false},
		{"unknown word", withSystemdRun, "bogus", false},
		{"one without systemd-run", withoutSystemdRun, "1", false},
		{"true without systemd-run", withoutSystemdRun, "true", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PATH", tc.path)
			t.Setenv("MULTICA_DETACHED_RUNTIME", tc.env)
			if got := DshDetachedAvailable(); got != tc.want {
				t.Fatalf("DshDetachedAvailable() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestDshDetachedExecuteDeletesStdinFrame runs the detached launch path end to
// end with a fake systemd-run that just execs the wrapped command. The child
// sleeps before reading stdin, so the frame file is already unlinked when it
// reads: the run only completes if the descriptor it inherited stays readable.
func TestDshDetachedExecuteDeletesStdinFrame(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("detached runs are Linux only")
	}
	dir := writeFakeSystemdRun(t, "#!/bin/sh\nwhile [ \"$1\" != \"--\" ]; do shift; done\nshift\nexec \"$@\"\n")
	t.Setenv("PATH", dir+":/usr/bin:/bin")
	t.Setenv("MULTICA_DETACHED_RUNTIME", "1")

	bin := writeDshFixture(t, `
printf '%s\n' '{"v":1,"type":"ready","runtime":"dsh","plugin_version":"test","capabilities":{}}'
sleep 0.2
IFS= read -r execute
case "$execute" in *'"type":"execute"'*) ;; *) exit 8 ;; esac
printf '%s\n' '{"v":1,"type":"session","request_id":"task-detached","session_id":"session-d","resumed":false}'
printf '%s\n' '{"v":1,"type":"result","request_id":"task-detached","status":"completed","session_id":"session-d","output":"done","resume_rejected":false}'
`)
	b, err := New("dsh", Config{ExecutablePath: bin, TaskID: "task-detached", Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	session, err := b.Execute(context.Background(), "hello", ExecOptions{Cwd: cwd, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	for range session.Messages {
	}
	result := <-session.Result
	if result.Status != "completed" {
		t.Fatalf("bad result: %#v", result)
	}

	runDir := filepath.Join(cwd, dshDetachedDir, dshDetachedUnit("task-detached"))
	if _, err := os.Stat(filepath.Join(runDir, "stdout.jsonl")); err != nil {
		t.Fatalf("detached path not taken, stdout.jsonl: %v", err)
	}
	if _, err := os.Stat(filepath.Join(runDir, "stdin.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("stdin.jsonl must be deleted once the child holds it, stat err = %v", err)
	}
}

// TestDshDetachedCloseRemovesStdinFrame covers the error paths: a run that
// never reached the start still deletes the frame, and keeps the other
// artifacts.
func TestDshDetachedCloseRemovesStdinFrame(t *testing.T) {
	plan, err := prepareDshDetachedRun(t.TempDir(), "task-close")
	if err != nil {
		t.Fatal(err)
	}
	frame := dshExecuteCommand{Version: DshProtocolVersion, Type: "execute", RequestID: "req-close", Prompt: "secret"}
	if err := plan.writeExecuteFrame(frame); err != nil {
		t.Fatalf("writeExecuteFrame: %v", err)
	}
	if _, err := plan.stdinReader(); err != nil {
		t.Fatalf("stdinReader: %v", err)
	}

	plan.Close()
	plan.Close()

	if _, err := os.Stat(plan.stdinPath); !os.IsNotExist(err) {
		t.Fatalf("stdin.jsonl must be removed by Close, stat err = %v", err)
	}
	for _, path := range []string{plan.stdoutPath, plan.stderrPath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("artifact %s must survive Close: %v", path, err)
		}
	}
}

// TestDshDetachedRunDirKeepsArtifacts checks the artifacts live inside the task
// workdir, so they expire with it and a recovering daemon can find them from
// the task row alone.
func TestDshDetachedRunDirKeepsArtifacts(t *testing.T) {
	cwd := t.TempDir()
	plan, err := prepareDshDetachedRun(cwd, "task-artifacts")
	if err != nil {
		t.Fatal(err)
	}
	defer plan.Close()

	for _, path := range []string{plan.stdinPath, plan.stdoutPath, plan.stderrPath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("artifact %s: %v", path, err)
		}
		if !strings.HasPrefix(path, filepath.Join(cwd, dshDetachedDir)) {
			t.Fatalf("artifact %s is outside the task workdir", path)
		}
	}
}

func TestDshDetachedShutdownLeavesChildRunning(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("detached runs are Linux only")
	}
	dir := writeFakeSystemdRun(t, "#!/bin/sh\nwhile [ \"$1\" != \"--\" ]; do shift; done\nshift\nexec \"$@\"\n")
	marker := filepath.Join(dir, "stopped")
	writeTestExecutable(t, filepath.Join(dir, "systemctl"), []byte("#!/bin/sh\ntouch '"+marker+"'\n"))
	t.Setenv("PATH", dir+":/usr/bin:/bin")
	t.Setenv("MULTICA_DETACHED_RUNTIME", "1")
	bin := writeDshFixture(t, `
IFS= read -r execute
sleep 4
printf '%s\n' '{"v":1,"type":"ready","runtime":"dsh","protocol_version":1}'
printf '%s\n' '{"v":1,"type":"result","request_id":"task-shutdown","status":"completed","output":"done"}'
`)
	b, err := New("dsh", Config{ExecutablePath: bin, TaskID: "task-shutdown", Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := false
	s, err := b.Execute(ctx, "hello", ExecOptions{Cwd: t.TempDir(), DetachedStarted: func() { started = true }, PreserveDetached: func() bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	if !started {
		t.Fatal("detached launch was not recorded")
	}
	cancel()
	for range s.Messages {
	}
	result := <-s.Result
	if result.Status != "completed" {
		t.Fatalf("child did not finish: %+v", result)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("scope was stopped: %v", err)
	}
}
