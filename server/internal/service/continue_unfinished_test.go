package service

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// continueFixture builds an issue assigned to a private agent at the given
// status, plus a completed step-bound run for it. The issue has no project,
// so the workflow switch defaults on.
func continueFixture(t *testing.T, status string) (principalFixture, *TaskService, pgtype.UUID, string) {
	t.Helper()
	f, owner := newPrincipalFixture(t)
	issue := f.Issue(t, "Continuation test", testutil.Cols{"status": status})
	agent := f.privateAgentOwnedBy(t, owner, "cont")
	f.Exec(t, "UPDATE issue SET assignee_type='agent',assignee_id=$1 WHERE id=$2", agent, issue)
	f.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
	f.Cleanup(t, "DELETE FROM comment WHERE issue_id=$1", issue)
	svc := &TaskService{Queries: f.q, TxStarter: f.Pool, Bus: events.New()}
	return f, svc, parseTestUUID(t, issue), agent
}

// continueCompletedRun inserts a completed run on the issue bound to step with
// the given trigger/rerun lineage, and returns it.
func continueCompletedRun(t *testing.T, f principalFixture, issue pgtype.UUID, agent string, step string, triggerCommentID pgtype.UUID, rerunOf pgtype.UUID) db.AgentTaskQueue {
	t.Helper()
	cols := testutil.Cols{
		"issue_id":           util.UUIDToString(issue),
		"runtime_id":         testutil.Raw("(SELECT runtime_id FROM agent WHERE id='" + agent + "')"),
		"status":             "completed",
		"created_at":         testutil.Raw("now() - interval '10 minutes'"),
		"started_at":         testutil.Raw("now() - interval '9 minutes'"),
		"completed_at":       testutil.Raw("now() - interval '8 minutes'"),
		"workflow_step":      step,
		"originator_user_id": f.UserID, "accountable_user_id": f.UserID,
	}
	if triggerCommentID.Valid {
		cols["trigger_comment_id"] = util.UUIDToString(triggerCommentID)
	}
	if rerunOf.Valid {
		cols["rerun_of_task_id"] = util.UUIDToString(rerunOf)
	}
	id := f.Task(t, agent, cols)
	task, err := f.q.GetAgentTask(context.Background(), parseTestUUID(t, id))
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func continuePendingCount(t *testing.T, f principalFixture, issue pgtype.UUID) int {
	t.Helper()
	return f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND status IN ('queued','dispatched','deferred')", issue)
}

func TestContinueUnfinishedQueuesOneRun(t *testing.T) {
	f, svc, issue, agent := continueFixture(t, "in_progress")
	task := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})

	svc.MaybeContinueUnfinishedStep(context.Background(), task)

	if got := continuePendingCount(t, f, issue); got != 1 {
		t.Fatalf("pending continuation tasks = %d, want 1", got)
	}
	var handoff, step, rerun string
	var fireAt pgtype.Timestamptz
	err := f.Pool.QueryRow(context.Background(),
		`SELECT handoff_note, workflow_step, rerun_of_task_id::text, fire_at FROM agent_task_queue
		 WHERE issue_id=$1 AND status='deferred' ORDER BY created_at DESC LIMIT 1`, issue).
		Scan(&handoff, &step, &rerun, &fireAt)
	if err != nil {
		t.Fatalf("read continuation: %v", err)
	}
	if step != "in_progress" {
		t.Fatalf("continuation workflow_step = %q, want in_progress", step)
	}
	if rerun != util.UUIDToString(task.ID) {
		t.Fatalf("continuation rerun_of_task_id = %q, want %s", rerun, util.UUIDToString(task.ID))
	}
	if !strings.Contains(handoff, "without moving the issue or arming a wakeup") {
		t.Fatalf("continuation handoff missing the rule: %q", handoff)
	}
	if !fireAt.Valid {
		t.Fatal("continuation has no fire_at delay")
	}
}

func TestContinueUnfinishedSuppressedOnMoveReassignWakeup(t *testing.T) {
	// Status moved: nothing queued.
	f, svc, issue, agent := continueFixture(t, "in_progress")
	moved := continueCompletedRun(t, f, issue, agent, "todo", pgtype.UUID{}, pgtype.UUID{})
	svc.MaybeContinueUnfinishedStep(context.Background(), moved)
	if got := continuePendingCount(t, f, issue); got != 0 {
		t.Fatalf("moved step queued %d, want 0", got)
	}

	// Reassigned: nothing queued.
	f2, svc2, issue2, agent2 := continueFixture(t, "in_progress")
	other := f2.privateAgentOwnedBy(t, f2.UserID, "cont-other")
	f2.Exec(t, "UPDATE issue SET assignee_id=$1 WHERE id=$2", other, util.UUIDToString(issue2))
	reassigned := continueCompletedRun(t, f2, issue2, agent2, "in_progress", pgtype.UUID{}, pgtype.UUID{})
	svc2.MaybeContinueUnfinishedStep(context.Background(), reassigned)
	if got := continuePendingCount(t, f2, issue2); got != 0 {
		t.Fatalf("reassigned issue queued %d, want 0", got)
	}

	// Waiting wakeup: nothing queued.
	f3, s3, issue3, agent3 := continueFixture(t, "in_progress")
	wakeSvc := &IssueWakeupService{Tasks: &TaskService{Queries: f3.q, TxStarter: f3.Pool, Bus: events.New()}}
	w := wakeCreate(t, f3, wakeSvc, issue3, WakeupInput{AgentID: agent3, Kind: "event", EventTypes: []string{"comment.created"}, Instruction: "watch"})
	f3.Comment(t, util.UUIDToString(issue3), "input while running")
	_ = w
	still := continueCompletedRun(t, f3, issue3, agent3, "in_progress", pgtype.UUID{}, pgtype.UUID{})
	s3.MaybeContinueUnfinishedStep(context.Background(), still)
	if got := continuePendingCount(t, f3, issue3); got != 0 {
		t.Fatalf("waiting wakeup queued %d, want 0", got)
	}
}

func TestContinueUnfinishedConsultStaysQuiet(t *testing.T) {
	f, svc, issue, agent := continueFixture(t, "in_progress")
	commentID := f.Comment(t, util.UUIDToString(issue), "@agent what do you think?")
	consult := continueCompletedRun(t, f, issue, agent, "in_progress", parseTestUUID(t, commentID), pgtype.UUID{})
	svc.MaybeContinueUnfinishedStep(context.Background(), consult)
	if got := continuePendingCount(t, f, issue); got != 0 {
		t.Fatalf("consult queued %d, want 0", got)
	}
}

func TestContinueUnfinishedSwitchOffQueuesNothing(t *testing.T) {
	f, svc, issue, agent := continueFixture(t, "in_progress")
	wf := f.Insert(t, "issue_workflow", testutil.Cols{
		"workspace_id": f.WorkspaceID, "name": "Strict", "description": "",
		"initial_status_key": "todo", "steps": testutil.Raw("'[]'::jsonb"), "is_default": true,
		"continue_unfinished": false,
	})
	proj := f.Insert(t, "project", testutil.Cols{"workspace_id": f.WorkspaceID, "title": "P", "workflow_id": wf})
	f.Exec(t, "UPDATE issue SET project_id=$1 WHERE id=$2", proj, util.UUIDToString(issue))
	task := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})

	svc.MaybeContinueUnfinishedStep(context.Background(), task)

	if got := continuePendingCount(t, f, issue); got != 0 {
		t.Fatalf("switch-off workflow queued %d, want 0", got)
	}
}

func TestContinueUnfinishedCapAndNoProgressBlock(t *testing.T) {
	ctx := context.Background()
	f, svc, issue, agent := continueFixture(t, "in_progress")
	first := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})

	// Queue cap-many continuations, marking each completed WITH progress (a
	// comment) so the guard lets the chain grow to the cap.
	prev := first
	for range maxContinuationsPerEpisode {
		d := svc.DecideContinueUnfinishedStep(ctx, prev)
		if d.Outcome != "queued" {
			t.Fatalf("continuation decision = %q, want queued", d.Outcome)
		}
		if d.ContinuationID == "" {
			t.Fatal("queued continuation has no id")
		}
		f.Comment(t, util.UUIDToString(issue), "progress note")
		f.Exec(t, "UPDATE agent_task_queue SET created_at=now()-interval '7 minutes',started_at=now()-interval '6 minutes',status='completed',completed_at=now(),result='null' WHERE id=$1", d.ContinuationID)
		updated, err := f.q.GetAgentTask(ctx, parseTestUUID(t, d.ContinuationID))
		if err != nil {
			t.Fatal(err)
		}
		prev = updated
	}
	// The cap is reached: one more quiet completion queues nothing.
	d := svc.DecideContinueUnfinishedStep(ctx, prev)
	if d.Outcome == "queued" {
		t.Fatalf("cap reached but still queued %s", d.ContinuationID)
	}
	if d.Outcome != "suppressed:cap_reached" {
		t.Fatalf("outcome = %q, want suppressed:cap_reached", d.Outcome)
	}

	// No-progress guard on a fresh issue: first continuation quiet, second
	// decision blocks instead of queueing a second continuation.
	f2, svc2, issue2, agent2 := continueFixture(t, "in_progress")
	opening := continueCompletedRun(t, f2, issue2, agent2, "in_progress", pgtype.UUID{}, pgtype.UUID{})
	d1 := svc2.DecideContinueUnfinishedStep(ctx, opening)
	if d1.Outcome != "queued" {
		t.Fatalf("first decision = %q, want queued", d1.Outcome)
	}
	f2.Exec(t, "UPDATE agent_task_queue SET created_at=now()-interval '7 minutes',started_at=now()-interval '6 minutes',status='completed',completed_at=now(),result='null' WHERE id=$1", d1.ContinuationID)
	quiet, err := f2.q.GetAgentTask(ctx, parseTestUUID(t, d1.ContinuationID))
	if err != nil {
		t.Fatal(err)
	}
	d2 := svc2.DecideContinueUnfinishedStep(ctx, quiet)
	if d2.Outcome != "no_progress_blocked" {
		t.Fatalf("outcome = %q, want no_progress_blocked", d2.Outcome)
	}
	var status string
	if err := f2.Pool.QueryRow(ctx, "SELECT status FROM issue WHERE id=$1", issue2).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "blocked" {
		t.Fatalf("issue status = %q, want blocked", status)
	}
	if got := f2.Count(t, "SELECT count(*) FROM comment WHERE issue_id=$1 AND author_type='system' AND content LIKE 'Continuation stopped%'", issue2); got != 1 {
		t.Fatalf("no-progress system comments = %d, want 1", got)
	}
	if got := continuePendingCount(t, f2, issue2); got != 0 {
		t.Fatalf("blocked issue still has %d pending tasks, want 0", got)
	}
}

func TestContinueUnfinishedRacesWakeupDispatch(t *testing.T) {
	f, svc, issue, agent := continueFixture(t, "in_progress")
	wakeSvc := &IssueWakeupService{Tasks: &TaskService{Queries: f.q, TxStarter: f.Pool, Bus: events.New()}}
	w := wakeCreate(t, f, wakeSvc, issue, WakeupInput{AgentID: agent, Kind: "event", EventTypes: []string{"comment.created"}, Instruction: "watch"})
	commentID := f.Comment(t, util.UUIDToString(issue), "race input")
	_ = commentID
	task := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})

	var wg sync.WaitGroup
	wg.Add(2)
	var dispatchErr error
	go func() {
		defer wg.Done()
		if err := wakeSvc.dispatch(context.Background(), w); err != nil {
			dispatchErr = err
		}
	}()
	go func() {
		defer wg.Done()
		svc.MaybeContinueUnfinishedStep(context.Background(), task)
	}()
	wg.Wait()
	if dispatchErr != nil {
		t.Fatalf("wakeup dispatch failed: %v", dispatchErr)
	}
	// Exactly one follow-up: either the wakeup's run or the continuation, but
	// never both (the issue row lock serializes the two decisions).
	if got := continuePendingCount(t, f, issue); got != 1 {
		t.Fatalf("follow-up tasks = %d, want exactly 1", got)
	}
}
