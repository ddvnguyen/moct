package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issueworkflow"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"log/slog"
)

// Continuation policy (M-279/M-300). A handed-off run that ends "ok" without
// moving the issue or arming a wakeup gets up to two silent continuations in a
// status episode, each deferred by continuationDelay. Continued silence then
// routes to the Orchestrator; it never changes the issue's status.
const (
	maxSilentContinuationsPerEpisode = 2
	maxDerivedRunsPerIssue24h        = 6
	continuationDelay                = 2 * time.Minute
)

// continuationHandoffNote is the one line every continuation run reads. It
// names the rule (move the issue or arm a wakeup) so a quiet-but-correct run
// learns its exit instead of spending another cycle.
const continuationHandoffNote = "Your previous run ended without moving the issue or arming a wakeup. Continue the next unfinished part, then either move the issue with the step's command or arm a wakeup for what you wait on."

// MaybeContinueUnfinishedStep is invoked after a clean task completion. If the
// issue is still at the step the run was handed, no wakeup is armed and no other
// task is pending, it queues a single continuation run (deferred by
// continuationDelay). Otherwise it is a no-op. Outcome counters ride the slog
// lines the Architect asked for (M-279 verdict item 1): continuation_queued /
// suppressed / routed. Failures are logged, never returned to the
// caller. The signature stays stable: M-291 builds on it.
func (s *TaskService) MaybeContinueUnfinishedStep(ctx context.Context, task db.AgentTaskQueue) {
	s.decideTurnEndRouter(ctx, task, false)
}

// ContinuationDecision is the hook's decision for one completed run: the
// outcome (queued / queued:<role> / suppressed:<clause> / skipped:<fast
// precheck>) plus the reminder text for run-end surfaces. Reminder is set
// exactly when the run left its handed-off step without a status move or
// wakeup AND the hook queued nothing behind it (suppressed or failed): that
// is the moment the agent should hear the rule. The CLI prints it after a
// handed-off write that starts no run.
type ContinuationDecision struct {
	Outcome        string
	ContinuationID string
	Reminder       string
}

// DecideContinueUnfinishedStep runs the hook and reports what it did, for
// run-end surfaces (CLI status/update, daemon completion logging).
func (s *TaskService) DecideContinueUnfinishedStep(ctx context.Context, task db.AgentTaskQueue) ContinuationDecision {
	return s.decideTurnEndRouter(ctx, task, false)
}

// DecideFailedIssueRun routes a terminal failed issue task to the Orchestrator
// after the task's retry transaction has committed. A pending retry suppresses
// the route through the same pending-task guard as clean completion.
func (s *TaskService) DecideFailedIssueRun(ctx context.Context, task db.AgentTaskQueue) ContinuationDecision {
	return s.decideTurnEndRouter(ctx, task, true)
}

// decideContinueUnfinished holds the shared fast prechecks, transaction, and
// outcome logging.
func (s *TaskService) decideTurnEndRouter(ctx context.Context, task db.AgentTaskQueue, failed bool) ContinuationDecision {
	if task.IssueID.Valid {
		if issue, err := s.Queries.GetIssue(ctx, task.IssueID); err == nil {
			s.recordTurnEndRouterProductivity(ctx, task, issue)
		}
	}
	step := ""
	if task.WorkflowStep.Valid {
		step = task.WorkflowStep.String
	}
	if step == "" && task.IssueID.Valid {
		// Wakeup and comment-triggered runs may not carry a workflow_step. Bind
		// their turn-end decision to the issue's current status at completion.
		if issue, err := s.Queries.GetIssue(ctx, task.IssueID); err == nil {
			step = issue.Status
		}
	}
	if step == "" {
		return ContinuationDecision{Outcome: "skipped:no_step"}
	}
	_, routerDestination := turnEndRouterTaskRouting(task)
	if task.SquadID.Valid || (task.IsLeaderTask && routerDestination != "leader") {
		// squad runs belong to the leader/member protocol, not to this hook.
		return ContinuationDecision{Outcome: "skipped:squad"}
	}
	switch step {
	case "done", "cancelled", "in_review", "wait_for_decision", "blocked":
		return ContinuationDecision{Outcome: "skipped:terminal_step"}
	}
	var outcome, continuationID string
	err := s.runInTx(ctx, func(qtx *db.Queries) error {
		var err error
		outcome, continuationID, err = s.continueUnfinishedInTx(ctx, qtx, task, step, failed)
		return err
	})
	if err != nil {
		slog.Warn("continue-unfinished: decision failed", "task_id", util.UUIDToString(task.ID), "error", err)
		return ContinuationDecision{Outcome: "error", Reminder: ContinuationReminderForOutcome("error")}
	}
	d := ContinuationDecision{Outcome: outcome, ContinuationID: continuationID}
	switch outcome {
	case "queued":
		d.Reminder = ContinuationReminderForOutcome(outcome)
		slog.Info("continue-unfinished: queued continuation", "task_id", util.UUIDToString(task.ID), "continuation", continuationID, "metric", "continuation_queued")
	default:
		slog.Info("continue-unfinished: suppressed", "task_id", util.UUIDToString(task.ID), "reason", outcome, "metric", "continuation_suppressed")
		d.Reminder = ContinuationReminderForOutcome(outcome)
	}
	return d
}

// continueUnfinishedInTx decides and acts in one transaction. LockWakeupIssue
// takes the issue row FOR NO KEY UPDATE, so a concurrent wakeup dispatch or a
// second completion sees the continuation task or the blocked status before
// deciding — exactly one follow-up wins the race. Returns (outcome,
// continuationID, nil) with outcome queued / queued:<role> /
// suppressed:<clause>.
func (s *TaskService) continueUnfinishedInTx(ctx context.Context, qtx *db.Queries, task db.AgentTaskQueue, step string, failed bool) (string, string, error) {
	issue, err := qtx.LockWakeupIssue(ctx, task.IssueID)
	if err != nil {
		return "", "", fmt.Errorf("lock issue: %w", err)
	}
	if issue.Status != step {
		return "suppressed:status_moved", "", nil
	}
	workspace, err := qtx.GetWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return "", "", fmt.Errorf("load router mode: %w", err)
	}
	mode := turnEndRouterModeFromSettings(workspace.Settings)
	if mode == "off" {
		return "suppressed:mode_off", "", nil
	}
	_, sourceDestination := turnEndRouterTaskRouting(task)
	if sourceDestination == "" && task.WorkflowStep.Valid && task.WorkflowStep.String != "" && (!issue.AssigneeID.Valid || issue.AssigneeID != task.AgentID) {
		return "suppressed:reassigned", "", nil
	}
	if pending, err := qtx.HasActiveTurnEndRouterTaskForIssue(ctx, db.HasActiveTurnEndRouterTaskForIssueParams{IssueID: issue.ID, SourceTaskID: task.ID}); err != nil {
		return "", "", fmt.Errorf("pending task check: %w", err)
	} else if pending {
		// HasPendingTaskForIssue only sees queued/dispatched rows; the hook runs
		// right after CompleteTaskWithTransition flipped this run to completed,
		// so a true here is always somebody else's pending run.
		return "suppressed:pending_task", "", nil
	}
	// Lock every waiting wakeup row FOR UPDATE before deciding — the same
	// grade dispatch takes (LockIssueWakeup → check → enqueue). Two
	// FOR NO KEY UPDATE issue locks do NOT conflict with each other, so the
	// issue lock alone cannot serialize us against a concurrent dispatch; the
	// wakeup-row lock can, because both sides take it on the same rows.
	// SKIP LOCKED keeps us from wedging behind a dispatch: a wakeup another
	// writer holds is somebody else's follow-up, so suppress.
	wks, err := qtx.ListWaitingWakeups(ctx, db.ListWaitingWakeupsParams{IssueID: issue.ID, AgentID: task.AgentID})
	if err != nil {
		return "", "", fmt.Errorf("wakeup check: %w", err)
	}
	for _, wid := range wks {
		if _, err := qtx.TryLockIssueWakeup(ctx, wid); err != nil {
			if errorsIsNoRows(err) {
				// SKIP LOCKED skipped a row a concurrent dispatch holds:
				// somebody else's follow-up is already being decided.
				return "suppressed:wakeup_race", "", nil
			}
			return "", "", fmt.Errorf("lock wakeup: %w", err)
		}
	}
	if len(wks) > 0 {
		return "suppressed:waiting_wakeup", "", nil
	}
	if ok, err := continueSwitchOn(ctx, qtx, issue); err != nil {
		return "", "", err
	} else if !ok {
		return "suppressed:switch_off", "", nil
	}
	if !failed {
		if routed, outcome, id, err := s.maybeRouteGreenPRInTx(ctx, qtx, issue, task, step); routed || err != nil {
			return outcome, id, err
		}
	}
	if failed {
		return s.routeOrchestratorInTx(ctx, qtx, issue, task, step, "run_failed")
	}
	_, destination := turnEndRouterTaskRouting(task)
	switch destination {
	case "orchestrator":
		if !progressSince(ctx, qtx, issue, task) {
			return s.routeLeaderInTx(ctx, qtx, issue, task, step, "orchestrator_exhausted")
		}
		return "handled:orchestrator_progress", "", nil
	case "leader":
		if !progressSince(ctx, qtx, issue, task) {
			if err := s.recordTurnEndRouterAudit(ctx, qtx, issue, step, task); err != nil {
				return "", "", err
			}
			return "audit:leader_no_progress", "", nil
		}
		return "handled:leader_progress", "", nil
	case "architect":
		return "handled:architect_reviewed", "", nil
	}
	chain := continuationChain(ctx, qtx, issue, step, task)
	recentCount, err := qtx.CountRecentTurnEndRouterRuns(ctx, db.CountRecentTurnEndRouterRunsParams{IssueID: issue.ID, SourceTaskID: task.ID})
	if err != nil {
		return "", "", fmt.Errorf("recent derived-run guard: %w", err)
	}
	if recentCount > 0 {
		return "suppressed:dedupe_2m", "", nil
	}
	dayCount, err := qtx.CountTurnEndRouterRunsSince(ctx, issue.ID)
	if err != nil {
		return "", "", fmt.Errorf("daily derived-run cap: %w", err)
	}
	if dayCount.RunCount >= maxDerivedRunsPerIssue24h {
		return "suppressed:daily_cap", "", nil
	}
	if continuationSilenceCount(ctx, qtx, issue, chain, task) >= maxSilentContinuationsPerEpisode {
		return s.routeOrchestratorInTx(ctx, qtx, issue, task, step, "cap_reached")
	}
	availability, err := isAssignedRouterAgentAvailable(ctx, qtx, issue, task.AgentID)
	if err != nil {
		return "suppressed:" + availability, "", err
	}
	if availability != "available" {
		if availability == "quota_ledger_unavailable" {
			return "suppressed:quota_ledger_unavailable", "", nil
		}
		return s.routeOrchestratorInTx(ctx, qtx, issue, task, step, "assigned_agent_"+availability)
	}
	if mode == "shadow" {
		if err := s.recordShadowDecision(ctx, qtx, issue, "same_step_no_pending_work", "continuation"); err != nil {
			return "", "", err
		}
		slog.Info("turn-end-router: would queue same-agent continuation", "issue_id", util.UUIDToString(issue.ID), "reason", "same_step_no_pending_work")
		return "shadow:would_queue", "", nil
	}
	cont, err := s.enqueueContinuationInTx(ctx, qtx, issue, task, step, chain)
	if err != nil {
		return "", "", err
	}
	return "queued", util.UUIDToString(cont.ID), nil
}

func continuationSilenceCount(ctx context.Context, q *db.Queries, issue db.Issue, chain []db.AgentTaskQueue, current db.AgentTaskQueue) int {
	if current.RerunOfTaskID.Valid {
		found := false
		for _, run := range chain {
			if run.ID == current.ID {
				found = true
				break
			}
		}
		if !found {
			chain = append(chain, current)
		}
	}
	count := 0
	for i := len(chain) - 1; i >= 0; i-- {
		if progressSince(ctx, q, issue, chain[i]) {
			break
		}
		count++
	}
	return count
}

type turnEndRouterTaskContext struct {
	TurnEndRouter struct {
		Origin               string `json:"origin"`
		Reason               string `json:"reason"`
		Destination          string `json:"destination"`
		StateHash            string `json:"state_hash"`
		BaselineStatus       string `json:"baseline_status"`
		BaselineCommentCount int64  `json:"baseline_comment_count"`
		BaselineHeadSHA      string `json:"baseline_head_sha"`
	} `json:"turn_end_router"`
}

func (s *TaskService) recordTurnEndRouterProductivity(ctx context.Context, task db.AgentTaskQueue, issue db.Issue) {
	var taskContext turnEndRouterTaskContext
	if json.Unmarshal(task.Context, &taskContext) != nil || taskContext.TurnEndRouter.Origin != "derived" {
		return
	}
	comments, err := s.Queries.CountComments(ctx, db.CountCommentsParams{IssueID: issue.ID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		slog.Warn("turn-end-router: count comments for productivity", "task_id", util.UUIDToString(task.ID), "error", err)
		return
	}
	headSHA, ok := issueReviewHeadSHA(ctx, s.Queries, issue.ID)
	if !ok {
		return
	}
	productive := issue.Status != taskContext.TurnEndRouter.BaselineStatus || comments != taskContext.TurnEndRouter.BaselineCommentCount || headSHA != taskContext.TurnEndRouter.BaselineHeadSHA
	if err := s.Queries.SetTaskTurnEndRouterProductive(ctx, db.SetTaskTurnEndRouterProductiveParams{ID: task.ID, Productive: productive}); err != nil {
		slog.Warn("turn-end-router: record productivity", "task_id", util.UUIDToString(task.ID), "error", err)
	}
}

func issueReviewHeadSHA(ctx context.Context, q *db.Queries, issueID pgtype.UUID) (string, bool) {
	headSHA, err := q.GetIssueReviewHeadSha(ctx, issueID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", true
	}
	if err != nil {
		slog.Warn("turn-end-router: read PR head for productivity", "issue_id", util.UUIDToString(issueID), "error", err)
		return "", false
	}
	return headSHA, true
}

func turnEndRouterModeFromSettings(settings []byte) string {
	var values map[string]json.RawMessage
	if json.Unmarshal(settings, &values) != nil {
		return "shadow"
	}
	var mode string
	if json.Unmarshal(values["turn_end_router_mode"], &mode) != nil {
		return "shadow"
	}
	switch mode {
	case "off", "on", "shadow":
		return mode
	default:
		return "shadow"
	}
}

// continueSwitchOn reports the per-workflow continue_unfinished switch.
// Default is on: issues outside any project and lookup failures keep the new
// behavior rather than silently disabling it.
func continueSwitchOn(ctx context.Context, qtx *db.Queries, issue db.Issue) (bool, error) {
	if !issue.ProjectID.Valid {
		return true, nil
	}
	proj, err := qtx.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: issue.ProjectID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return true, nil
	}
	var wf db.IssueWorkflow
	if proj.WorkflowID.Valid {
		var err error
		wf, err = qtx.GetIssueWorkflow(ctx, db.GetIssueWorkflowParams{ID: proj.WorkflowID, WorkspaceID: issue.WorkspaceID})
		if err != nil {
			return true, nil
		}
	} else {
		var err error
		wf, err = qtx.GetDefaultIssueWorkflow(ctx, issue.WorkspaceID)
		if err != nil {
			if errorsIsNoRows(err) {
				return true, nil
			}
			return true, nil
		}
	}
	return wf.ContinueUnfinished, nil
}

func errorsIsNoRows(err error) bool {
	return err != nil && (pgx.ErrNoRows == err || strings.Contains(err.Error(), "no rows in result set"))
}

// continuationChain lists this episode's continuation runs, oldest first: the
// completed continuations whose rerun_of_task_id chain leads back to a run
// handed the same step. The just-finished run only joins the chain when it is
// itself a continuation: a first-generation handed-off run opens the episode
// and must not count toward the cap, or a quiet first run would burn one of
// its own follow-ups. A status change starts a new episode because every
// continuation binds to its step (MUL-7420), so only runs that never left the
// step count.
func continuationChain(ctx context.Context, qtx *db.Queries, issue db.Issue, step string, justFinished db.AgentTaskQueue) []db.AgentTaskQueue {
	tasks, err := qtx.ListTasksByIssue(ctx, issue.ID)
	if err != nil {
		return nil
	}
	enteredAt, enteredErr := qtx.GetIssueStatusEnteredAt(ctx, db.GetIssueStatusEnteredAtParams{IssueID: issue.ID, Status: step})
	if enteredErr != nil && !errorsIsNoRows(enteredErr) {
		// A failed boundary read must not reset the cap and create more runs.
		enteredAt = pgtype.Timestamptz{}
	}
	insideEpisode := func(task db.AgentTaskQueue) bool {
		return !enteredAt.Valid || !task.CreatedAt.Valid || !task.CreatedAt.Time.Before(enteredAt.Time)
	}
	var chain []db.AgentTaskQueue
	seen := map[string]bool{}
	for _, t := range tasks {
		if t.Status != "completed" {
			continue
		}
		if !t.WorkflowStep.Valid || t.WorkflowStep.String != step {
			continue
		}
		if !t.RerunOfTaskID.Valid {
			continue
		}
		if !insideEpisode(t) {
			continue
		}
		if util.UUIDToString(t.ID) == util.UUIDToString(justFinished.ID) {
			continue
		}
		chain = append([]db.AgentTaskQueue{t}, chain...)
		seen[util.UUIDToString(t.ID)] = true
	}
	// The just-finished run joins the chain only when it is itself a
	// continuation. Its completion may not be visible to the listing query
	// under all isolation levels, so append by id.
	if justFinished.RerunOfTaskID.Valid && insideEpisode(justFinished) && !seen[util.UUIDToString(justFinished.ID)] {
		chain = append(chain, justFinished)
	}
	return chain
}

// progressSince reports whether a continuation run produced anything
// observable while it ran: a comment, a linked or updated PR, or a status
// change in the activity log, all strictly after the run started.
// Scoping to the run's own window (not "since it completed") keeps setup the
// test or a prior run wrote from reading as this run's progress — and a
// same-timestamp comment from the enqueue path from blocking the guard. A
// quiet-but-correct run that wrote nothing observable costs one extra
// continuation before the guard stops it — the accepted tradeoff from the
// M-256 discussion.
func progressSince(ctx context.Context, qtx *db.Queries, issue db.Issue, prev db.AgentTaskQueue) bool {
	since := prev.StartedAt
	if !since.Valid {
		since = prev.CreatedAt
	}
	if !since.Valid {
		return false
	}
	after := since.Time.Add(time.Second)
	comments, err := qtx.ListCommentsSinceForIssue(ctx, db.ListCommentsSinceForIssueParams{
		IssueID:     issue.ID,
		WorkspaceID: issue.WorkspaceID,
		CreatedAt:   pgtype.Timestamptz{Time: after, Valid: true},
		Limit:       1,
	})
	if err == nil && len(comments) > 0 {
		return true
	}
	prs, err := qtx.ListPullRequestsByIssue(ctx, issue.ID)
	if err == nil {
		for _, pr := range prs {
			if pr.PrUpdatedAt.Valid && pr.PrUpdatedAt.Time.After(after) {
				return true
			}
		}
	}
	acts, err := qtx.ListActivitiesForIssue(ctx, db.ListActivitiesForIssueParams{
		IssueID: issue.ID,
		Limit:   20,
	})
	if err == nil {
		for _, a := range acts {
			if a.CreatedAt.Time.After(after) && a.Action == "status_changed" {
				return true
			}
		}
	}
	return false
}

// enqueueContinuationInTx queues the next continuation: deferred by
// continuationDelay (the sweeper promotes it, so the 2-min delay needs no
// timer), rerun_of_task_id pointing at the completed run for the chain, the
// step's instructions plus the one-line rule in the handoff note. The deferred
// insert skips the queued/dedup broadcast by design (see enqueueIssueTask):
// NotifyTaskFinished on the next completion wakes the daemon then.
func (s *TaskService) enqueueContinuationInTx(ctx context.Context, qtx *db.Queries, issue db.Issue, task db.AgentTaskQueue, step string, chain []db.AgentTaskQueue) (db.AgentTaskQueue, error) {
	commentCount, err := qtx.CountComments(ctx, db.CountCommentsParams{IssueID: issue.ID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return db.AgentTaskQueue{}, fmt.Errorf("capture router comment baseline: %w", err)
	}
	headSHA, ok := issueReviewHeadSHA(ctx, qtx, issue.ID)
	if !ok {
		return db.AgentTaskQueue{}, fmt.Errorf("capture router PR baseline")
	}
	instructions := stepInstructions(ctx, qtx, issue, step)
	handoff := continuationHandoffNote
	if instructions != "" {
		handoff = "Step instructions:\n" + instructions + "\n\n" + continuationHandoffNote
	}
	txSvc := &TaskService{Queries: qtx, TxStarter: nil, Bus: s.Bus, Metrics: s.Metrics, FeatureFlags: s.FeatureFlags}
	fireAt := pgtype.Timestamptz{Time: time.Now().Add(continuationDelay), Valid: true}
	cont, err := txSvc.enqueueIssueTask(ctx, issue, pgtype.UUID{}, false, handoff, pgtype.UUID{}, task.ID, fireAt, OriginDerived)
	if err != nil {
		return db.AgentTaskQueue{}, fmt.Errorf("enqueue continuation: %w", err)
	}
	if err := qtx.SetTaskWorkflowStep(ctx, db.SetTaskWorkflowStepParams{
		WorkflowStep: pgtype.Text{String: step, Valid: true},
		ID:           cont.ID,
	}); err != nil {
		return db.AgentTaskQueue{}, fmt.Errorf("stamp workflow step: %w", err)
	}
	if err := qtx.SetTaskTurnEndRouterContext(ctx, db.SetTaskTurnEndRouterContextParams{
		ID: cont.ID, Reason: "same_step_no_pending_work", Destination: "continuation",
		StateHash: turnEndRouterStateHash(issue, commentCount, headSHA, false), BaselineStatus: issue.Status,
		BaselineCommentCount: commentCount, BaselineHeadSha: headSHA,
	}); err != nil {
		return db.AgentTaskQueue{}, fmt.Errorf("stamp router context: %w", err)
	}
	cont.WorkflowStep = pgtype.Text{String: step, Valid: true}
	return cont, nil
}

// ContinuationReminder is shown when a handoff write starts no run.
func ContinuationReminder() string {
	return "No run started for this handoff. Move the issue into a handled step or arm a wakeup when work should resume later."
}

func ContinuationReminderForOutcome(outcome string) string {
	switch outcome {
	case "queued":
		return "A continuation run is queued for about two minutes from now."
	case "queued:orchestrator":
		return "The Orchestrator was queued to resume or reroute this issue."
	case "queued:leader":
		return "The Leader was queued to make one final routing decision for this issue."
	case "queued:architect":
		return "The Architect was queued to review the linked pull request."
	case "wakeup:pr_checks":
		return "A PR checks wakeup is armed; the Architect will be routed when checks finish."
	case "wakeup:pr_checks_already_armed":
		return "A PR checks wakeup is already armed for the Architect."
	case "shadow:would_queue":
		return "Shadow mode recorded the routing decision; no follow-up run was queued."
	case "audit:leader_no_progress":
		return "The Leader made no measurable progress; an audit comment was recorded and automatic routing stopped."
	case "handled:orchestrator_progress", "handled:leader_progress", "handled:architect_reviewed":
		return "The issue changed while the routed agent worked; no additional run was queued."
	case "suppressed:pending_task":
		return "No follow-up was queued because another task is already pending for this issue."
	case "suppressed:waiting_wakeup", "suppressed:wakeup_race":
		return "No follow-up was queued because a wakeup is already armed for this issue."
	case "suppressed:mode_off":
		return "No follow-up was queued because turn-end routing is off for this workspace."
	case "suppressed:cap_reached":
		return "The silent-continuation cap was reached; the router attempted to send this issue to the Orchestrator."
	case "suppressed:daily_cap":
		return "No follow-up was queued because this issue reached the 24-hour derived-run cap."
	case "suppressed:dedupe_2m":
		return "No follow-up was queued because the router recently handled this issue."
	case "suppressed:duplicate_state":
		return "No follow-up was queued because this issue state was already routed."
	case "suppressed:quota_cooled", "suppressed:assigned_agent_quota_cooled":
		return "No follow-up was queued because the available account is in cooldown."
	case "suppressed:quota_ledger_unavailable":
		return "No follow-up was queued because the quota ledger could not be read."
	case "suppressed:switch_off":
		return "No follow-up was queued because the workflow has continuation disabled."
	case "suppressed:status_moved", "suppressed:reassigned":
		return "No follow-up was queued because the issue moved to another step or assignee."
	case "error":
		return "The router could not decide the next action; check the issue's task history."
	default:
		return "No follow-up run was queued. Check the issue's task history for the routing outcome."
	}
}

// ContinuationReminder is the IssueService-facing alias the update handler
// uses; TaskService owns the hook, IssueService owns the write path.
func (s *IssueService) ContinuationReminder() string { return ContinuationReminder() }

// stepInstructions resolves the current step's instructions for the handoff
// note, so the continuation rereads what the step asks for. Empty when the
// issue is outside any project or the step carries none.
func stepInstructions(ctx context.Context, qtx *db.Queries, issue db.Issue, step string) string {
	def, _, err := issueworkflow.ForProject(ctx, qtx, issue.WorkspaceID, issue.ProjectID)
	if err != nil || def == nil {
		return ""
	}
	st, ok := def.Step(step)
	if !ok {
		return ""
	}
	return st.Instructions
}
