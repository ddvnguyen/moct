package daemon

import (
	"context"
	"log/slog"
	"strings"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// recoverDetachedTasks finishes the tasks a restarted daemon finds still marked
// running for a detached-capable runtime. The previous process launched each
// run in its own systemd scope, so the run may have finished (or been lost)
// while the daemon was down, or may still be executing.
//
//   - no work_dir: the daemon pins work_dir only once the session frame arrived,
//     so there is nothing to look at; the server sweeper's detached bound stays
//     the backstop.
//   - run dir unreadable: skipped for the same reason.
//   - finished or lost: reported synchronously.
//   - otherwise: watched in the background and reported when the run ends; a
//     watch that ends because ctx did reports nothing.
func recoverDetachedTasks(
	ctx context.Context,
	tasks []RunningDetachedTask,
	recoverRun func(workDir, taskID string) (agent.DshDetachedOutcome, error),
	watch func(ctx context.Context, workDir, taskID string) (agent.Result, error),
	report func(ctx context.Context, taskID string, result agent.Result),
	logger *slog.Logger,
) (reported, watching, skipped int) {
	for _, t := range tasks {
		log := logger.With("task_id", t.TaskID)
		if strings.TrimSpace(t.WorkDir) == "" {
			log.Info("detached recovery skipped: task has no pinned work_dir")
			skipped++
			continue
		}
		outcome, err := recoverRun(t.WorkDir, t.TaskID)
		if err != nil {
			log.Warn("detached recovery skipped: run not readable", "work_dir", t.WorkDir, "error", err)
			skipped++
			continue
		}
		if outcome.Finished || outcome.Lost {
			log.Info("detached run already ended; reporting", "lost", outcome.Lost, "status", outcome.Result.Status)
			report(ctx, t.TaskID, outcome.Result)
			reported++
			continue
		}
		log.Info("detached run still running; watching", "work_dir", t.WorkDir)
		watching++
		go func(t RunningDetachedTask) {
			result, err := watch(ctx, t.WorkDir, t.TaskID)
			if err != nil {
				log.Info("detached watch ended without a result", "error", err)
				return
			}
			report(ctx, t.TaskID, result)
		}(t)
	}
	return reported, watching, skipped
}

// recoverDetachedRunningTasks applies a recover-orphans response to this
// daemon. It does nothing unless the server reported a detached runtime with
// running tasks and this host can read detached runs.
func (d *Daemon) recoverDetachedRunningTasks(runtimeID string, res RecoverOrphansResult) {
	if !res.Detached || len(res.RunningDetached) == 0 || !agent.DshDetachedAvailable() {
		return
	}
	reported, watching, skipped := recoverDetachedTasks(
		d.recoveryContext(),
		res.RunningDetached,
		agent.RecoverDshDetachedRun,
		func(ctx context.Context, workDir, taskID string) (agent.Result, error) {
			return agent.WatchDshDetachedRun(ctx, workDir, taskID, 0)
		},
		func(ctx context.Context, taskID string, result agent.Result) {
			d.reportRecoveredDetachedTask(ctx, taskID, result)
		},
		d.logger.With("runtime_id", runtimeID),
	)
	d.logger.Info("detached run recovery", "runtime_id", runtimeID,
		"reported", reported, "watching", watching, "skipped", skipped)
}

func (d *Daemon) reportRecoveredDetachedTask(ctx context.Context, taskID string, result agent.Result) {
	status, err := d.client.GetTaskStatus(ctx, taskID)
	if shouldInterruptAgent(status, err) {
		d.logger.Info("detached recovery skipped terminal task", "task_id", taskID, "status", status)
		return
	}
	if err != nil {
		d.logger.Warn("detached recovery could not check task status; attempting durable report", "task_id", taskID, "error", err)
	}
	d.reportTaskResult(ctx, taskID, detachedTaskResult(result), d.logger.With("task_id", taskID))
}

// detachedTaskResult maps a recovered run's Result onto the TaskResult that
// reportTaskResult reports. Only what the Result carries is set: WorkDir,
// BranchName, DurableWorkDir and the per-run measurements (InitContext,
// SessionStart, usage) belong to the claimed Task and execution environment
// the restarted daemon no longer holds, so they stay empty and the server
// keeps the values it already pinned.
func detachedTaskResult(r agent.Result) TaskResult {
	if r.Status == "completed" {
		return TaskResult{Status: "completed", Comment: r.Output, SessionID: r.SessionID}
	}
	comment := r.Error
	if comment == "" {
		comment = r.Output
	}
	status := r.Status
	if status == "" {
		status = "failed"
	}
	return TaskResult{Status: status, Comment: comment, SessionID: r.SessionID}
}
