package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// dshDetachedLostError is the failure reported for a run whose scope is gone
// without the wrapper ever recording an exit status (killed, stopped, host
// reboot), so there is nothing left that could still finish it.
const dshDetachedLostError = "detached dsh run ended without recording an exit status (scope gone)"

// dshDetachedScopeProbeTimeout bounds one liveness probe so a hung systemctl
// cannot stall a recovery sweep.
const dshDetachedScopeProbeTimeout = 5 * time.Second

// dshDetachedWatchDefaultPoll is used when WatchDshDetachedRun gets a
// non-positive interval; each poll may spawn systemctl, so it stays coarse.
const dshDetachedWatchDefaultPoll = 2 * time.Second

// DshDetachedOutcome is what a daemon learns about a detached run it did not launch.
type DshDetachedOutcome struct {
	Finished bool   // the wrapper recorded an exit status
	Lost     bool   // no exit status and the scope is known to be gone (killed/stopped)
	Result   Result // valid when Finished or Lost
}

// dshDetachedScopeActive reports whether the run's transient scope is alive.
// known is false when systemd could not answer; callers must then keep waiting
// rather than declare the run lost. Overridden in tests.
var dshDetachedScopeActive = func(unit string) (active bool, known bool) {
	ctx, cancel := context.WithTimeout(context.Background(), dshDetachedScopeProbeTimeout)
	defer cancel()
	err := exec.CommandContext(ctx, "systemctl", "--user", "is-active", "--quiet", unit+".scope").Run()
	if err == nil {
		return true, true
	}
	var exitErr *exec.ExitError
	// Exit status 3 is systemctl's answer for an inactive or unknown unit.
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 3 {
		return false, true
	}
	return false, false
}

// openDshDetachedRunDir addresses an existing run directory without touching
// it. prepareDshDetachedRun must not be used for recovery: it truncates the
// stdout and stderr files and removes the exit record, which are the run's
// durable result.
func openDshDetachedRunDir(workDir, taskID string) (*dshDetachedRun, error) {
	if strings.TrimSpace(workDir) == "" {
		return nil, errors.New("detached dsh recovery requires a workdir")
	}
	unit := dshDetachedUnit(taskID)
	dir := filepath.Join(workDir, dshDetachedDir, unit)
	info, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("detached dsh run dir: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("detached dsh run dir %s is not a directory", dir)
	}
	return &dshDetachedRun{
		dir:        dir,
		unit:       unit,
		stdoutPath: filepath.Join(dir, "stdout.jsonl"),
		stderrPath: filepath.Join(dir, "stderr.log"),
		exitPath:   filepath.Join(dir, "exit"),
	}, nil
}

// replayDshDetachedStdout feeds the recorded protocol frames through the same
// handler a live run uses. Unparsable lines are skipped: the last line of a
// still-running process is routinely cut mid-write.
func replayDshDetachedStdout(path, taskID string) *dshRunState {
	state := &dshRunState{usage: map[string]TokenUsage{}, requestID: taskID}
	raw, err := os.ReadFile(path)
	if err != nil {
		return state
	}
	for _, line := range bytes.Split(raw, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var frame dshFrame
		if json.Unmarshal(line, &frame) != nil {
			continue
		}
		state.frameCount++
		handleDshFrame(frame, taskID, nil, state)
	}
	return state
}

// RecoverDshDetachedRun reads <workDir>/.multica-detached/<unit(taskID)>/ once, without waiting.
// Not finished and not lost → Outcome{} (still running or unknown).
func RecoverDshDetachedRun(workDir, taskID string) (DshDetachedOutcome, error) {
	run, err := openDshDetachedRunDir(workDir, taskID)
	if err != nil {
		return DshDetachedOutcome{}, err
	}

	// An unreadable exit record (empty, partial) means the wrapper is mid-write
	// or never got there; treat it like a missing one and look again next poll.
	if status, ok, err := run.exitStatus(); err == nil && ok {
		return DshDetachedOutcome{Finished: true, Result: finishedDshDetachedResult(run, taskID, status)}, nil
	}

	active, known := dshDetachedScopeActive(run.unit)
	if active || !known {
		return DshDetachedOutcome{}, nil
	}
	// The wrapper records the status just before the scope disappears, so a
	// probe that lands in between must not misreport a finished run as lost.
	if status, ok, err := run.exitStatus(); err == nil && ok {
		return DshDetachedOutcome{Finished: true, Result: finishedDshDetachedResult(run, taskID, status)}, nil
	}
	state := replayDshDetachedStdout(run.stdoutPath, taskID)
	result := Result{
		Status: "failed", Error: dshDetachedLostError, SessionID: state.sessionID, Usage: state.usage,
		FirstPromptTokens: state.firstPromptTokens, LastPromptTokens: state.lastPromptTokens,
	}
	result.Error = withAgentStderr(result.Error, "dsh", run.stderrTail())
	return DshDetachedOutcome{Lost: true, Result: result}, nil
}

// finishedDshDetachedResult builds the Result Execute would have produced for
// a run that exited with the given status.
func finishedDshDetachedResult(run *dshDetachedRun, taskID string, exitCode int) Result {
	state := replayDshDetachedStdout(run.stdoutPath, taskID)
	result := state.result
	if exitCode != 0 {
		sessionID := state.sessionID
		if result != nil && result.SessionID != "" {
			sessionID = result.SessionID
		}
		return Result{Status: "failed", Error: withAgentStderr(fmt.Sprintf("dsh exited with error: exit status %d", exitCode), "dsh", run.stderrTail()), SessionID: sessionID, Usage: state.usage,
			FirstPromptTokens: state.firstPromptTokens, LastPromptTokens: state.lastPromptTokens}
	}
	if result == nil {
		result = &Result{Status: "failed", SessionID: state.sessionID, Usage: state.usage,
			FirstPromptTokens: state.firstPromptTokens, LastPromptTokens: state.lastPromptTokens}
		switch {
		case state.protocolError != "":
			result.Error = state.protocolError
		case !state.ready:
			result.Error = "dsh exited before the runtime protocol became ready"
		case exitCode != 0:
			result.Error = fmt.Sprintf("dsh exited with error: exit status %d", exitCode)
		default:
			result.Error = "dsh exited without a terminal result"
		}
	}
	if result.Error != "" {
		result.Error = withAgentStderr(result.Error, "dsh", run.stderrTail())
	}
	return *result
}

// WatchDshDetachedRun polls every `poll` until the run is Finished or Lost (or ctx ends → ctx.Err()) and returns the final Result.
func WatchDshDetachedRun(ctx context.Context, workDir, taskID string, poll time.Duration) (Result, error) {
	if poll <= 0 {
		poll = dshDetachedWatchDefaultPoll
	}
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		outcome, err := RecoverDshDetachedRun(workDir, taskID)
		if err != nil {
			return Result{}, err
		}
		if outcome.Finished || outcome.Lost {
			return outcome.Result, nil
		}
		select {
		case <-ctx.Done():
			return Result{}, ctx.Err()
		case <-ticker.C:
		}
	}
}
