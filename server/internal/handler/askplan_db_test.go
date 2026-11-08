package handler

// S1-A1 (M-118): DB-backed integration tests for the ask/plan flows. These
// exercise the real handlers, transactions and resume enqueue against the
// database — the acceptance criteria for the card (green tests + migration).

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type askPlanFixture struct {
	runtimeID string
	agentID   string
	issueID   string
	taskID    string
}

// newAskPlanFixture builds a running issue task plus a workspace member. The
// issue starts in a planning status so the plan gate passes by default; tests
// that want a non-planning issue update it themselves.
func newAskPlanFixture(t *testing.T) askPlanFixture {
	t.Helper()
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID := dbfx.Runtime(t, "askplan-runtime", testutil.Cols{"provider": "claude", "status": "online", "daemon_id": "park-daemon"})
	agentID := dbfx.Agent(t, "AskPlan Agent", runtimeID)
	issueID := dbfx.Issue(t, "askplan issue", testutil.Cols{"status": "planing_2", "assignee_type": "agent", "assignee_id": agentID})
	taskID := dbfx.Task(t, agentID, testutil.Cols{
		"issue_id":   issueID,
		"runtime_id": runtimeID,
		"status":     "running",
	})
	dbfx.Cleanup(t, `DELETE FROM agent_question_card WHERE task_id = $1`, taskID)
	// Plan review threads and section history reference the plan, so they go
	// first (cleanups run last-registered-first).
	dbfx.Cleanup(t, `DELETE FROM agent_plan_comment WHERE plan_id IN (SELECT id FROM agent_plan WHERE task_id = $1)`, taskID)
	dbfx.Cleanup(t, `DELETE FROM agent_plan_section_version WHERE plan_id IN (SELECT id FROM agent_plan WHERE task_id = $1)`, taskID)
	dbfx.Cleanup(t, `DELETE FROM agent_plan WHERE task_id = $1`, taskID)
	dbfx.Cleanup(t, `DELETE FROM agent_plan_review WHERE plan_id IN (SELECT id FROM agent_plan WHERE issue_id = $1)`, issueID)
	dbfx.Cleanup(t, `DELETE FROM inbox_item WHERE issue_id = $1 AND type IN ('agent_question','plan_review')`, issueID)
	return askPlanFixture{runtimeID: runtimeID, agentID: agentID, issueID: issueID, taskID: taskID}
}

// agentAskRequest builds a task-token-shaped request: the X-Task-ID header is
// what the auth middleware stamps for a mat_ token, and the handlers key their
// identity off it.
func agentAskRequest(t *testing.T, f askPlanFixture, method, path string, body any) *http.Request {
	t.Helper()
	req := newRequest(method, path, body)
	req.Header.Set("X-Task-ID", f.taskID)
	req.Header.Set("X-Agent-ID", f.agentID)
	req.Header.Set("X-Actor-Source", "task_token")
	return withURLParams(req, "id", testWorkspaceID, "taskId", f.taskID)
}

func validAskBody() map[string]any {
	return map[string]any{
		"context": "We are choosing a release lane.",
		"questions": []map[string]any{
			{"prompt": "Which release day?", "options": []map[string]string{{"label": "Thursday"}, {"label": "Friday"}}},
		},
	}
}

// agentPlanRequest builds a task-token request for the plan routes, which key
// off the planId URL param (not taskId).
func agentPlanRequest(t *testing.T, f askPlanFixture, method, path, planID string, body any) *http.Request {
	t.Helper()
	req := newRequest(method, path, body)
	req.Header.Set("X-Task-ID", f.taskID)
	req.Header.Set("X-Agent-ID", f.agentID)
	req.Header.Set("X-Actor-Source", "task_token")
	return withURLParams(req, "id", testWorkspaceID, "planId", planID)
}

func TestSubmitAskParksTaskAndCreatesCard(t *testing.T) {
	f := newAskPlanFixture(t)
	var resp askResponse
	testutil.Call(t, testHandler.SubmitAsk,
		agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/ask", validAskBody()),
	).Want(http.StatusAccepted).JSON(&resp)

	if resp.CardID == "" || resp.Status != "awaiting_human" {
		t.Fatalf("ask response = %#v", resp)
	}
	// The task must now be parked.
	if status := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE id=$1 AND status='blocked'`, f.taskID); status != 1 {
		t.Fatalf("task not parked as blocked")
	}
	// The card must be open with the questions stored.
	var cardCount int
	dbfx.QueryRow(t, `SELECT count(*) FROM agent_question_card WHERE id=$1 AND status='open'`, resp.CardID).Scan(&cardCount)
	if cardCount != 1 {
		t.Fatalf("question card not open")
	}
	// The task must point at the card via its evidence kind/ref.
	var kind string
	var refID string
	dbfx.QueryRow(t, `SELECT trigger_evidence_kind, trigger_evidence_ref_id::text FROM agent_task_queue WHERE id=$1`, f.taskID).Scan(&kind, &refID)
	if kind != "question_answer" || refID != resp.CardID {
		t.Fatalf("task evidence = kind %q ref %q, want question_answer / card", kind, refID)
	}
	// An inbox item must exist for the member.
	if n := dbfx.Count(t, `SELECT count(*) FROM inbox_item WHERE issue_id=$1 AND type='agent_question'`, f.issueID); n == 0 {
		t.Fatalf("no agent_question inbox item was delivered")
	}
}

func TestAnswerQuestionCardEnqueuesResumeTask(t *testing.T) {
	f := newAskPlanFixture(t)
	var ask askResponse
	testutil.Call(t, testHandler.SubmitAsk,
		agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/ask", validAskBody()),
	).Want(http.StatusAccepted).JSON(&ask)

	// Human answers the open card.
	answerReq := newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/question-cards/"+ask.CardID+"/answer", map[string]any{
		"answers": []map[string]any{{"selected": []int{0}}},
	})
	answerReq.Header.Set("X-Actor-Source", "") // human credential, not a task token
	var answerResp map[string]any
	testutil.Call(t, testHandler.AnswerQuestionCard,
		withURLParams(answerReq, "id", testWorkspaceID, "cardId", ask.CardID),
	).Want(http.StatusOK).JSON(&answerResp)

	// The card must be answered.
	var status string
	dbfx.QueryRow(t, `SELECT status FROM agent_question_card WHERE id=$1`, ask.CardID).Scan(&status)
	if status != "answered" {
		t.Fatalf("card status = %q, want answered", status)
	}
	// A resume task must exist, pointing at the parked task via rerun lineage
	// and carrying the answer evidence kind.
	resumeID, _ := answerResp["resume_task"].(string)
	if resumeID == "" {
		t.Fatalf("no resume task in answer response: %#v", answerResp)
	}
	var rerunOf, kind string
	dbfx.QueryRow(t, `SELECT rerun_of_task_id::text, trigger_evidence_kind FROM agent_task_queue WHERE id=$1`, resumeID).Scan(&rerunOf, &kind)
	if rerunOf != f.taskID {
		t.Fatalf("resume task rerun_of = %q, want parked task %q", rerunOf, f.taskID)
	}
	if kind != "question_answer" {
		t.Fatalf("resume task evidence kind = %q, want question_answer", kind)
	}
	// A second answer must be refused (single-answer rule).
	secondReq := newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/question-cards/"+ask.CardID+"/answer", map[string]any{
		"answers": []map[string]any{{"selected": []int{1}}},
	})
	testutil.Call(t, testHandler.AnswerQuestionCard,
		withURLParams(secondReq, "id", testWorkspaceID, "cardId", ask.CardID),
	).Want(http.StatusConflict)
}

func TestPlanCreateGateRefusesNonPlanningIssue(t *testing.T) {
	f := newAskPlanFixture(t)
	dbfx.Exec(t, `UPDATE issue SET status='in_progress' WHERE id=$1`, f.issueID)
	req := agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/plans", map[string]any{
		"title": "Release plan", "outline": []string{"Goal", "Steps"},
	})
	testutil.Call(t, testHandler.CreatePlan, req).Want(http.StatusConflict)
}

func TestPlanCreateGateRefusesSecondOpenPlan(t *testing.T) {
	f := newAskPlanFixture(t)
	first := agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/plans", map[string]any{
		"title": "First plan", "outline": []string{"Goal"},
	})
	testutil.Call(t, testHandler.CreatePlan, first).Want(http.StatusCreated)
	second := agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/plans", map[string]any{
		"title": "Second plan", "outline": []string{"Goal"},
	})
	testutil.Call(t, testHandler.CreatePlan, second).Want(http.StatusConflict)
}

func TestPlanWriteSectionRevisionFence(t *testing.T) {
	f := newAskPlanFixture(t)
	var created planResponse
	testutil.Call(t, testHandler.CreatePlan,
		agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/plans", map[string]any{
			"title": "Release plan", "outline": []string{"Goal"},
		}),
	).Want(http.StatusCreated).JSON(&created)

	// A stale base_revision must be refused with the current revision.
	stale := agentPlanRequest(t, f, http.MethodPut, "/api/workspaces/"+testWorkspaceID+"/plans/"+created.ID+"/sections", created.ID, map[string]any{
		"base_revision": created.Revision + 99,
		"section":       map[string]any{"section_id": "s1", "heading": "Goal", "markdown": "Ship it"},
	})
	testutil.Call(t, testHandler.WritePlanSection, stale).Want(http.StatusConflict)

	// The correct base_revision writes and bumps the revision.
	ok := agentPlanRequest(t, f, http.MethodPut, "/api/workspaces/"+testWorkspaceID+"/plans/"+created.ID+"/sections", created.ID, map[string]any{
		"base_revision": created.Revision,
		"section":       map[string]any{"section_id": "s1", "heading": "Goal", "markdown": "Ship it"},
	})
	var written planResponse
	testutil.Call(t, testHandler.WritePlanSection, ok).Want(http.StatusOK).JSON(&written)
	if written.Revision != created.Revision+1 {
		t.Fatalf("revision = %d, want %d", written.Revision, created.Revision+1)
	}
}

func TestPlanRoutesRejectAnotherTask(t *testing.T) {
	owner := newAskPlanFixture(t)
	other := owner
	other.agentID = dbfx.Agent(t, "Other Plan Agent", owner.runtimeID)
	other.issueID = dbfx.Issue(t, "other plan issue", testutil.Cols{"status": "planing_2", "assignee_type": "agent", "assignee_id": other.agentID})
	other.taskID = dbfx.Task(t, other.agentID, testutil.Cols{"issue_id": other.issueID, "runtime_id": owner.runtimeID, "status": "running"})
	var plan planResponse
	testutil.Call(t, testHandler.CreatePlan,
		agentAskRequest(t, owner, http.MethodPost, "/plans", map[string]any{
			"title": "Owner plan", "outline": []string{"Goal"},
		}),
	).Want(http.StatusCreated).JSON(&plan)
	write := agentPlanRequest(t, other, http.MethodPut, "/sections", plan.ID, map[string]any{
		"base_revision": plan.Revision,
		"section":       map[string]any{"section_id": "s1", "heading": "Goal", "markdown": "Other agent"},
	})
	testutil.Call(t, testHandler.WritePlanSection, write).Want(http.StatusForbidden)
	submit := agentPlanRequest(t, other, http.MethodPost, "/submit", plan.ID, map[string]any{"revision": plan.Revision})
	testutil.Call(t, testHandler.SubmitPlan, submit).Want(http.StatusForbidden)
}

func TestPlanVerdictApproveWritesDescriptionAndResumes(t *testing.T) {
	f := newAskPlanFixture(t)
	// Create + write a section, then submit (which parks the task).
	var created planResponse
	testutil.Call(t, testHandler.CreatePlan,
		agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/plans", map[string]any{
			"title": "Release plan", "outline": []string{"Goal"},
		}),
	).Want(http.StatusCreated).JSON(&created)
	testutil.Call(t, testHandler.WritePlanSection,
		agentPlanRequest(t, f, http.MethodPut, "/api/workspaces/"+testWorkspaceID+"/plans/"+created.ID+"/sections", created.ID, map[string]any{
			"base_revision": created.Revision,
			"section":       map[string]any{"section_id": "s1", "heading": "Goal", "markdown": "Ship on Thursday"},
		}),
	).Want(http.StatusOK)
	dbfx.Exec(t, `UPDATE agent_task_queue SET status='running' WHERE id=$1`, f.taskID) // submit needs a running task
	submitReq := agentPlanRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+created.ID+"/submit", created.ID, map[string]any{
		"revision": created.Revision + 1,
	})
	testutil.Call(t, testHandler.SubmitPlan, submitReq).Want(http.StatusAccepted)

	// Human approves the plan.
	verdictReq := newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+created.ID+"/verdict", map[string]any{
		"revision": created.Revision + 1, "verdict": "approve",
	})
	testutil.Call(t, testHandler.ReviewPlan,
		withURLParams(verdictReq, "id", testWorkspaceID, "planId", created.ID),
	).Want(http.StatusOK)

	// The plan must be approved with provenance recorded.
	var planStatus string
	dbfx.QueryRow(t, `SELECT status FROM agent_plan WHERE id=$1`, created.ID).Scan(&planStatus)
	if planStatus != "approved" {
		t.Fatalf("plan status = %q, want approved", planStatus)
	}
	// The issue description must carry the rendered plan.
	var description string
	dbfx.QueryRow(t, `SELECT description FROM issue WHERE id=$1`, f.issueID).Scan(&description)
	if !strings.Contains(description, "Ship on Thursday") {
		t.Fatalf("issue description not promoted: %q", description)
	}
	// A review row must be recorded.
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_plan_review WHERE plan_id=$1 AND verdict='approve'`, created.ID); n != 1 {
		t.Fatalf("no approve review recorded")
	}
	// A resume task must exist with the plan_verdict evidence kind.
	var resumeKind string
	dbfx.QueryRow(t, `SELECT trigger_evidence_kind FROM agent_task_queue WHERE issue_id=$1 AND status='queued' AND rerun_of_task_id IS NOT NULL`, f.issueID).Scan(&resumeKind)
	if resumeKind != "plan_verdict" {
		t.Fatalf("resume task evidence = %q, want plan_verdict", resumeKind)
	}
}

// submittedPlan parks the task behind an in_review plan and returns its id +
// the revision the human will fence on. Shared by the three verdict tests.
func submittedPlan(t *testing.T, f askPlanFixture) (string, int32) {
	t.Helper()
	var plan planResponse
	testutil.Call(t, testHandler.CreatePlan,
		agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/plans", map[string]any{
			"title": "Release plan", "outline": []string{"Goal"},
		}),
	).Want(http.StatusCreated).JSON(&plan)
	testutil.Call(t, testHandler.WritePlanSection,
		agentPlanRequest(t, f, http.MethodPut, "/api/workspaces/"+testWorkspaceID+"/plans/"+plan.ID+"/sections", plan.ID, map[string]any{
			"base_revision": plan.Revision,
			"section":       map[string]any{"section_id": "s1", "heading": "Goal", "markdown": "Ship on Thursday"},
		}),
	).Want(http.StatusOK)
	dbfx.Exec(t, `UPDATE agent_task_queue SET status='running' WHERE id=$1`, f.taskID)
	submit := plan.Revision + 1
	testutil.Call(t, testHandler.SubmitPlan,
		agentPlanRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+plan.ID+"/submit", plan.ID, map[string]any{"revision": submit}),
	).Want(http.StatusAccepted)
	return plan.ID, submit
}

func TestPlanVerdictChangesRequestedNeedsComment(t *testing.T) {
	f := newAskPlanFixture(t)
	planID, rev := submittedPlan(t, f)
	verdictReq := newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/verdict", map[string]any{
		"revision": rev, "verdict": "changes_requested",
	})
	// No comment and no note must be refused — the team-room rule.
	testutil.Call(t, testHandler.ReviewPlan, withURLParams(verdictReq, "id", testWorkspaceID, "planId", planID)).Want(http.StatusBadRequest)

	// With a comment it is accepted; the plan goes to changes_requested (not
	// approved — the description must NOT be promoted) and the run resumes.
	withComment := newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/verdict", map[string]any{
		"revision": rev, "verdict": "changes_requested", "comments": []string{"Tighten the rollback step"},
	})
	testutil.Call(t, testHandler.ReviewPlan, withURLParams(withComment, "id", testWorkspaceID, "planId", planID)).Want(http.StatusOK)
	var status string
	dbfx.QueryRow(t, `SELECT status FROM agent_plan WHERE id=$1`, planID).Scan(&status)
	if status != "changes_requested" {
		t.Fatalf("plan status = %q, want changes_requested", status)
	}
	// changes_requested must NOT promote the plan into the description. The
	// issue description is untouched (NULL here) — coalesce so the scan works
	// whether or not the fixture seeded one.
	var description string
	dbfx.QueryRow(t, `SELECT COALESCE(description,'') FROM issue WHERE id=$1`, f.issueID).Scan(&description)
	if strings.Contains(description, "Ship on Thursday") {
		t.Fatalf("changes_requested promoted the description: %q", description)
	}
}

func TestPlanVerdictCancelFreesIssueForNewPlan(t *testing.T) {
	f := newAskPlanFixture(t)
	planID, rev := submittedPlan(t, f)
	verdictReq := newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/verdict", map[string]any{
		"revision": rev, "verdict": "cancel",
	})
	testutil.Call(t, testHandler.ReviewPlan, withURLParams(verdictReq, "id", testWorkspaceID, "planId", planID)).Want(http.StatusOK)
	var status string
	dbfx.QueryRow(t, `SELECT status FROM agent_plan WHERE id=$1`, planID).Scan(&status)
	if status != "cancelled" {
		t.Fatalf("plan status = %q, want cancelled", status)
	}
	// The verdict re-queues a resume run for the issue, so a second plan is
	// correctly refused: the gate sees the queued resume as another active
	// task. That is the non-blocking design — the human's cancel hands the
	// issue back to the agent to continue, it does not leave the issue idle.
	// The cancelled plan no longer holds the one-open-plan slot
	// (idx_ap_one_open excludes it); once the resume run is claimed the next
	// plan is accepted.
	testutil.Call(t, testHandler.CreatePlan,
		agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/plans", map[string]any{
			"title": "Second plan", "outline": []string{"Goal"},
		},
		)).Want(http.StatusConflict)
}

func TestCancelParkedTaskWithdrawsCard(t *testing.T) {
	f := newAskPlanFixture(t)
	var ask askResponse
	testutil.Call(t, testHandler.SubmitAsk,
		agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/ask", validAskBody()),
	).Want(http.StatusAccepted).JSON(&ask)

	// Cancelling the parked task must withdraw its open card (amendment 3).
	if _, err := testHandler.TaskService.CancelTask(t.Context(), parseUUID(f.taskID)); err != nil {
		t.Fatalf("cancel parked task: %v", err)
	}
	var cardStatus string
	dbfx.QueryRow(t, `SELECT status FROM agent_question_card WHERE id=$1`, ask.CardID).Scan(&cardStatus)
	if cardStatus != "withdrawn" {
		t.Fatalf("card status after cancel = %q, want withdrawn", cardStatus)
	}
}

func TestGetIssueAskPlanReturnsOpenState(t *testing.T) {
	f := newAskPlanFixture(t)
	var ask askResponse
	testutil.Call(t, testHandler.SubmitAsk,
		agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/ask", validAskBody()),
	).Want(http.StatusAccepted).JSON(&ask)

	req := newRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/issues/"+f.issueID+"/ask-plan", nil)
	var state askPlanStateResponse
	testutil.Call(t, testHandler.GetIssueAskPlan,
		withURLParams(req, "id", testWorkspaceID, "issueId", f.issueID),
	).Want(http.StatusOK).JSON(&state)
	if len(state.QuestionCards) != 1 || state.QuestionCards[0].ID != ask.CardID {
		t.Fatalf("ask-plan state = %#v", state)
	}
}

func TestParkReportRecordsSession(t *testing.T) {
	f := newAskPlanFixture(t)
	testutil.Call(t, testHandler.SubmitAsk,
		agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/ask", validAskBody()),
	).Want(http.StatusAccepted)

	// The daemon's park report records the session on the blocked row.
	parkReq := newDaemonTokenRequest(http.MethodPost, "/blocked", map[string]any{
		"session_id": "sess-parked-1", "work_dir": "/tmp/wd",
	}, testWorkspaceID, "park-daemon")
	testutil.Call(t, testHandler.BlockTask, withURLParam(parkReq, "taskId", f.taskID)).Want(http.StatusOK)

	var sessionID string
	dbfx.QueryRow(t, `SELECT COALESCE(session_id,'') FROM agent_task_queue WHERE id=$1`, f.taskID).Scan(&sessionID)
	if sessionID != "sess-parked-1" {
		t.Fatalf("parked session = %q, want sess-parked-1", sessionID)
	}
	// A park report against a non-blocked task is an advisory no-op.
	other := newDaemonTokenRequest(http.MethodPost, "/blocked", map[string]any{"session_id": "x"}, testWorkspaceID, "park-daemon")
	testutil.Call(t, testHandler.BlockTask, withURLParam(other, "taskId", f.taskID)).Want(http.StatusOK)
}

func TestEmptyParkReportPreservesPinnedSession(t *testing.T) {
	f := newAskPlanFixture(t)
	// A runtime may report its session while running, then return no session
	// when the daemon interrupts it after an ask parks the task.
	pin := newDaemonTokenRequest(http.MethodPost, "/session", map[string]any{
		"session_id": "sess-pinned", "work_dir": "/workspace/fixture",
	}, testWorkspaceID, "park-daemon")
	testutil.Call(t, testHandler.PinTaskSession, withURLParam(pin, "taskId", f.taskID)).Want(http.StatusNoContent)
	var ask askResponse
	testutil.Call(t, testHandler.SubmitAsk,
		agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/ask", validAskBody()),
	).Want(http.StatusAccepted).JSON(&ask)
	park := newDaemonTokenRequest(http.MethodPost, "/blocked", map[string]any{}, testWorkspaceID, "park-daemon")
	testutil.Call(t, testHandler.BlockTask, withURLParam(park, "taskId", f.taskID)).Want(http.StatusOK)
	var sessionID string
	dbfx.QueryRow(t, `SELECT COALESCE(session_id,'') FROM agent_task_queue WHERE id=$1`, f.taskID).Scan(&sessionID)
	if sessionID != "sess-pinned" {
		t.Fatalf("parked session = %q, want the pinned session", sessionID)
	}
	answer := newRequest(http.MethodPost, "/answer", map[string]any{
		"answers": []map[string]any{{"selected": []int{0}}},
	})
	var response map[string]any
	testutil.Call(t, testHandler.AnswerQuestionCard,
		withURLParams(answer, "id", testWorkspaceID, "cardId", ask.CardID),
	).Want(http.StatusOK).JSON(&response)
	resumeID, _ := response["resume_task"].(string)
	if resumeID == "" {
		t.Fatalf("no resume task in answer response: %#v", response)
	}
	var sourceSession string
	dbfx.QueryRow(t, `SELECT COALESCE(parked.session_id,'') FROM agent_task_queue resumed JOIN agent_task_queue parked ON parked.id=resumed.rerun_of_task_id WHERE resumed.id=$1`, resumeID).Scan(&sourceSession)
	if sourceSession != "sess-pinned" {
		t.Fatalf("resume source session = %q, want sess-pinned", sourceSession)
	}
}

// keep the generated and encoding imports used even if a future edit drops a
// direct reference.
var _ = db.AgentQuestionCard{}
var _ = json.Marshal
var _ = strings.Contains
