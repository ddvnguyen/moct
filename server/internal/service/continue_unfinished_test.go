package service

import (
	"context"
	"encoding/json"
	"fmt"
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
// status, plus a completed step-bound run for it. The router is explicitly
// enabled so the test exercises its active behavior.
func continueFixture(t *testing.T, status string) (principalFixture, *TaskService, pgtype.UUID, string) {
	t.Helper()
	f, owner := newPrincipalFixture(t)
	if _, err := f.q.SetWorkspaceSetting(context.Background(), db.SetWorkspaceSettingParams{
		ID: parseTestUUID(t, f.WorkspaceID), Key: "turn_end_router_mode", Value: []byte(`"on"`),
	}); err != nil {
		t.Fatalf("enable turn-end router for continuation fixture: %v", err)
	}
	issue := f.Issue(t, "Continuation test", testutil.Cols{"status": status})
	agent := f.privateAgentOwnedBy(t, owner, "cont")
	quotaLedger := fmt.Sprintf(`{"rows":[{"tier":"tick","state":"ok","agents":["%s"]}]}`, agent)
	quotaSeats := fmt.Sprintf(`{"lead":["%s"],"architect":["%s"]}`, agent, agent)
	metadata, err := json.Marshal(map[string]string{"quota_ledger": quotaLedger, "quota_seats": quotaSeats})
	if err != nil {
		t.Fatal(err)
	}
	f.Issue(t, "Router quota ledger", testutil.Cols{
		"number":   86,
		"metadata": testutil.Raw("'" + string(metadata) + "'::jsonb"),
	})
	f.Exec(t, "UPDATE issue SET assignee_type='agent',assignee_id=$1 WHERE id=$2", agent, issue)
	f.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
	f.Cleanup(t, "DELETE FROM comment WHERE issue_id=$1", issue)
	svc := &TaskService{Queries: f.q, TxStarter: f.Pool, Bus: events.New()}
	return f, svc, parseTestUUID(t, issue), agent
}

func TestContinuationChainResetsAtStatusEpisodeBoundary(t *testing.T) {
	f, _, issue, agent := continueFixture(t, "in_progress")
	old := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})
	oldContinuation := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, old.ID)
	f.Exec(t, "UPDATE agent_task_queue SET created_at=now()-interval '20 minutes' WHERE id=$1", util.UUIDToString(oldContinuation.ID))
	f.Exec(t, `INSERT INTO activity_log (workspace_id,issue_id,actor_type,actor_id,action,details)
		VALUES ($1,$2,'agent',$3,'status_changed','{"from":"todo","to":"in_progress"}'::jsonb)`,
		f.WorkspaceID, util.UUIDToString(issue), agent)
	current := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, oldContinuation.ID)
	f.Exec(t, "UPDATE agent_task_queue SET created_at=now() WHERE id=$1", util.UUIDToString(current.ID))
	current, err := f.q.GetAgentTask(context.Background(), current.ID)
	if err != nil {
		t.Fatal(err)
	}
	chain := continuationChain(context.Background(), f.q, mustGetIssue(t, f, issue), "in_progress", current)
	if len(chain) != 1 || util.UUIDToString(chain[0].ID) != util.UUIDToString(current.ID) {
		t.Fatalf("episode chain = %v, want only current episode continuation %s", taskIDs(chain), util.UUIDToString(current.ID))
	}
}

func TestContinuationProgressIgnoresTaskResult(t *testing.T) {
	f, _, issue, agent := continueFixture(t, "in_progress")
	prev := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})
	f.Exec(t, "UPDATE agent_task_queue SET result='\"agent wrote output\"'::jsonb WHERE id=$1", util.UUIDToString(prev.ID))
	prev, err := f.q.GetAgentTask(context.Background(), prev.ID)
	if err != nil {
		t.Fatal(err)
	}
	if progressSince(context.Background(), f.q, mustGetIssue(t, f, issue), prev) {
		t.Fatal("non-empty task result counted as progress without a status, comment, or PR change")
	}
}

func TestContinuationReminderMatchesOutcome(t *testing.T) {
	queued := ContinuationReminderForOutcome("queued")
	suppressed := ContinuationReminderForOutcome("suppressed:pending_task")
	if !strings.Contains(queued, "queued") {
		t.Fatalf("queued reminder = %q, want queued outcome", queued)
	}
	if strings.Contains(suppressed, "will be queued") || !strings.Contains(suppressed, "No follow-up was queued") {
		t.Fatalf("suppressed reminder = %q, must describe suppression", suppressed)
	}
	for outcome, want := range map[string]string{
		"queued:orchestrator": "Orchestrator",
		"queued:leader":       "Leader",
		"queued:architect":    "Architect",
		"shadow:would_queue":  "no follow-up run was queued",
	} {
		if reminder := ContinuationReminderForOutcome(outcome); !strings.Contains(strings.ToLower(reminder), strings.ToLower(want)) {
			t.Errorf("%s reminder = %q, want %q", outcome, reminder, want)
		}
	}
}

func mustGetIssue(t *testing.T, f principalFixture, issue pgtype.UUID) db.Issue {
	t.Helper()
	got, err := f.q.GetIssue(context.Background(), issue)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func taskIDs(tasks []db.AgentTaskQueue) []string {
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, util.UUIDToString(task.ID))
	}
	return ids
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

func TestContinueUnfinishedCommentRunCanContinue(t *testing.T) {
	f, svc, issue, agent := continueFixture(t, "in_progress")
	commentID := f.Comment(t, util.UUIDToString(issue), "@agent what do you think?")
	consult := continueCompletedRun(t, f, issue, agent, "in_progress", parseTestUUID(t, commentID), pgtype.UUID{})
	d := svc.DecideContinueUnfinishedStep(context.Background(), consult)
	if d.Outcome != "queued" {
		t.Fatalf("comment-triggered run outcome = %q, want queued", d.Outcome)
	}
	if got := continuePendingCount(t, f, issue); got != 1 {
		t.Fatalf("comment-triggered run queued %d, want 1 continuation", got)
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

func TestSilentContinuationsEscalateWithoutChangingIssueStatus(t *testing.T) {
	ctx := context.Background()
	f, svc, issue, agent := continueFixture(t, "in_progress")
	prev := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})
	for i := 1; i <= maxSilentContinuationsPerEpisode; i++ {
		d := svc.DecideContinueUnfinishedStep(ctx, prev)
		if d.Outcome != "queued" || d.ContinuationID == "" {
			t.Fatalf("silent exit %d decision = %+v, want queued continuation", i, d)
		}
		f.Exec(t, "UPDATE agent_task_queue SET created_at=now()-interval '3 minutes',started_at=now()-interval '4 minutes',status='completed',completed_at=now(),result='null' WHERE id=$1", d.ContinuationID)
		var err error
		prev, err = f.q.GetAgentTask(ctx, parseTestUUID(t, d.ContinuationID))
		if err != nil {
			t.Fatal(err)
		}
	}
	d := svc.DecideContinueUnfinishedStep(ctx, prev)
	if d.Outcome != "queued:orchestrator" {
		t.Fatalf("third silent exit = %q, want queued:orchestrator", d.Outcome)
	}
	var status string
	if err := f.Pool.QueryRow(ctx, "SELECT status FROM issue WHERE id=$1", issue).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "in_progress" {
		t.Fatalf("issue status = %q, want unchanged in_progress", status)
	}
	orchestratorID := d.ContinuationID
	f.Exec(t, "UPDATE agent_task_queue SET created_at=now()-interval '3 minutes',started_at=now()-interval '4 minutes',status='completed',completed_at=now(),result='null' WHERE id=$1", orchestratorID)
	orchestrator, err := f.q.GetAgentTask(ctx, parseTestUUID(t, orchestratorID))
	if err != nil {
		t.Fatal(err)
	}
	d = svc.DecideContinueUnfinishedStep(ctx, orchestrator)
	if d.Outcome != "queued:leader" {
		t.Fatalf("silent Orchestrator outcome = %q, want queued:leader", d.Outcome)
	}
	leaderID := d.ContinuationID
	f.Exec(t, "UPDATE agent_task_queue SET created_at=now()-interval '3 minutes',started_at=now()-interval '4 minutes',status='completed',completed_at=now(),result='null' WHERE id=$1", leaderID)
	leader, err := f.q.GetAgentTask(ctx, parseTestUUID(t, leaderID))
	if err != nil {
		t.Fatal(err)
	}
	d = svc.DecideContinueUnfinishedStep(ctx, leader)
	if d.Outcome != "audit:leader_no_progress" {
		t.Fatalf("silent Leader outcome = %q, want audit", d.Outcome)
	}
	if got := f.Count(t, "SELECT count(*) FROM comment WHERE issue_id=$1 AND content LIKE 'Turn-end router stopped%'", issue); got != 1 {
		t.Fatalf("router exhaustion audit comments = %d, want 1", got)
	}
}

func TestFailedRunRoutesToOrchestrator(t *testing.T) {
	f, svc, issue, agent := continueFixture(t, "in_progress")
	task := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})
	task.Status = "failed"

	d := svc.DecideFailedIssueRun(context.Background(), task)
	if d.Outcome != "queued:orchestrator" {
		t.Fatalf("failed-run outcome = %q, want queued:orchestrator", d.Outcome)
	}
	if got := continuePendingCount(t, f, issue); got != 1 {
		t.Fatalf("pending tasks after failure = %d, want one Orchestrator task", got)
	}
}

func TestRunWithoutWorkflowStepUsesCurrentIssueStep(t *testing.T) {
	f, svc, issue, agent := continueFixture(t, "in_progress")
	task := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})
	task.WorkflowStep = pgtype.Text{}

	d := svc.DecideContinueUnfinishedStep(context.Background(), task)
	if d.Outcome != "queued" {
		t.Fatalf("no-step run outcome = %q, want continuation bound to current issue step", d.Outcome)
	}
}

func TestShadowModeRecordsDecisionWithoutQueueing(t *testing.T) {
	f, svc, issue, agent := continueFixture(t, "in_progress")
	if _, err := f.q.SetWorkspaceSetting(context.Background(), db.SetWorkspaceSettingParams{
		ID: parseTestUUID(t, f.WorkspaceID), Key: "turn_end_router_mode", Value: []byte(`"shadow"`),
	}); err != nil {
		t.Fatal(err)
	}
	task := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})
	d := svc.DecideFailedIssueRun(context.Background(), task)
	if d.Outcome != "shadow:would_queue" {
		t.Fatalf("shadow failure outcome = %q, want shadow:would_queue", d.Outcome)
	}
	if got := continuePendingCount(t, f, issue); got != 0 {
		t.Fatalf("shadow mode queued %d tasks, want none", got)
	}
	if got := f.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND action='turn_end_router_shadow'", issue); got != 1 {
		t.Fatalf("persisted shadow decisions = %d, want 1", got)
	}
}

func TestTurnEndRouterDedupesRecentRunAndDailyCap(t *testing.T) {
	t.Run("recent run", func(t *testing.T) {
		f, svc, issue, agent := continueFixture(t, "in_progress")
		seedID := seedTurnEndRouterRun(t, f, issue, agent, "continuation", "seed")
		f.Exec(t, "UPDATE agent_task_queue SET created_at=now()-interval '1 minute' WHERE id=$1", seedID)
		task := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})
		if d := svc.DecideContinueUnfinishedStep(context.Background(), task); d.Outcome != "suppressed:dedupe_2m" {
			t.Fatalf("recent duplicate outcome = %q", d.Outcome)
		}
	})
	t.Run("daily cap", func(t *testing.T) {
		f, svc, issue, agent := continueFixture(t, "in_progress")
		for i := 0; i < maxDerivedRunsPerIssue24h; i++ {
			seedTurnEndRouterRun(t, f, issue, agent, "continuation", fmt.Sprintf("seed-%d", i))
		}
		task := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})
		if d := svc.DecideContinueUnfinishedStep(context.Background(), task); d.Outcome != "suppressed:daily_cap" {
			t.Fatalf("daily-cap outcome = %q", d.Outcome)
		}
	})
}

func TestGreenPullRequestRoutesArchitectOrArmsWakeup(t *testing.T) {
	for _, connected := range []bool{false, true} {
		t.Run(fmt.Sprintf("github app connected=%t", connected), func(t *testing.T) {
			f, svc, issue, agent := continueFixture(t, "in_progress")
			pr := f.Insert(t, "github_pull_request", testutil.Cols{
				"workspace_id": f.WorkspaceID, "installation_id": 987654321,
				"repo_owner": "fixture", "repo_name": "router", "pr_number": 41,
				"title": "Green PR", "state": "open", "html_url": "https://example.test/pr/41",
				"pr_created_at": testutil.Raw("now() - interval '1 hour'"), "pr_updated_at": testutil.Raw("now()"),
				"head_sha": "head-1", "snapshot_head_sha": "head-1", "checks_rollup_state": "SUCCESS",
			})
			f.Cleanup(t, "DELETE FROM issue_pull_request WHERE pull_request_id=$1", pr)
			f.Exec(t, "INSERT INTO issue_pull_request(issue_id,pull_request_id) VALUES($1,$2)", issue, pr)
			f.Cleanup(t, "DELETE FROM github_pull_request_check_run WHERE pr_id=$1", pr)
			f.Exec(t, `INSERT INTO github_pull_request_check_run(pr_id,head_sha,ordinal,name,status,conclusion)
				VALUES($1,'head-1',1,'ci','completed','success')`, pr)
			if connected {
				f.Insert(t, "github_installation", testutil.Cols{
					"workspace_id": f.WorkspaceID, "installation_id": 987654321,
					"account_login": "fixture", "account_type": "Organization",
				})
			}
			task := continueCompletedRun(t, f, issue, agent, "in_progress", pgtype.UUID{}, pgtype.UUID{})
			d := svc.DecideContinueUnfinishedStep(context.Background(), task)
			if connected && d.Outcome != "queued:architect" {
				t.Fatalf("connected PR review outcome = %q, want queued:architect", d.Outcome)
			}
			if !connected && d.Outcome != "wakeup:pr_checks" {
				t.Fatalf("fallback PR review outcome = %q, want wakeup:pr_checks", d.Outcome)
			}
		})
	}
}

func seedTurnEndRouterRun(t *testing.T, f principalFixture, issue pgtype.UUID, agent, destination, stateHash string) string {
	t.Helper()
	id := f.Task(t, agent, testutil.Cols{
		"issue_id":      util.UUIDToString(issue),
		"runtime_id":    testutil.Raw("(SELECT runtime_id FROM agent WHERE id='" + agent + "')"),
		"status":        "completed",
		"created_at":    testutil.Raw("now() - interval '3 minutes'"),
		"workflow_step": "in_progress",
	})
	if err := f.q.SetTaskTurnEndRouterContext(context.Background(), db.SetTaskTurnEndRouterContextParams{
		ID: parseTestUUID(t, id), Reason: "seed", Destination: destination, StateHash: stateHash,
		BaselineStatus: "in_progress", BaselineCommentCount: 0, BaselineHeadSha: "",
	}); err != nil {
		t.Fatal(err)
	}
	return id
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
