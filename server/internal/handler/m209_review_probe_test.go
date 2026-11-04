package handler

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type m209Wakeup func(string, string)

func (f m209Wakeup) NotifyTaskAvailable(runtimeID, taskID string) { f(runtimeID, taskID) }

func m209ObservedHandler(t *testing.T, issue string) (*Handler, *int, *int) {
	t.Helper()
	h := *testHandler
	bus := events.New()
	taskService := service.NewTaskService(testHandler.TaskService.Queries, testHandler.TaskService.TxStarter, testHandler.TaskService.Hub, bus)
	h.Bus = bus
	h.TaskService = taskService
	observedEvents, observedHints := 0, 0
	checkCommitted := func() { assertM209Rows(t, issue, "in_progress", 1, 1, 1) }
	for _, kind := range []string{protocol.EventTaskQueued, protocol.EventIssueUpdated, protocol.EventCommentCreated} {
		bus.Subscribe(kind, func(events.Event) { checkCommitted(); observedEvents++ })
	}
	taskService.Wakeup = m209Wakeup(func(_, _ string) { checkCommitted(); observedHints++ })
	return &h, &observedEvents, &observedHints
}

func TestM209CommitFailureRollsBackEverything(t *testing.T) {
	issue, _, _, body := m209ReviewSetup(t)
	h, eventCount, hintCount := m209ObservedHandler(t, issue)
	h.TxStarter = rollbackOnCommitTxStarter{pool: testPool}
	w := m209ReviewCall(h, issue, body)
	if w.Code != 500 {
		t.Fatalf("commit failure = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "wait_for_decision", 0, 0, 0)
	if *eventCount != 0 || *hintCount != 0 {
		t.Fatalf("precommit effects: %d events, %d hints", *eventCount, *hintCount)
	}
}

func TestM209ReceiptInsertFailureRollsBackEverything(t *testing.T) {
	issue, _, _, body := m209ReviewSetup(t)
	body["decision"] = "m209 injected receipt failure"
	dbfx.Exec(t, `CREATE FUNCTION m209_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.decision = 'm209 injected receipt failure' THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END $$`)
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DROP FUNCTION IF EXISTS m209_fail_receipt() CASCADE`)
	})
	dbfx.Exec(t, `CREATE TRIGGER m209_fail_receipt BEFORE INSERT ON issue_decision_response FOR EACH ROW EXECUTE FUNCTION m209_fail_receipt()`)
	h, eventCount, hintCount := m209ObservedHandler(t, issue)
	w := m209ReviewCall(h, issue, body)
	if w.Code != 500 {
		t.Fatalf("insert failure = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "wait_for_decision", 0, 0, 0)
	if *eventCount != 0 || *hintCount != 0 {
		t.Fatalf("precommit effects: %d events, %d hints", *eventCount, *hintCount)
	}
}

func TestM209PublishesAfterCommitOnce(t *testing.T) {
	issue, _, _, body := m209ReviewSetup(t)
	var waitingAt time.Time
	dbfx.QueryRow(t, `SELECT updated_at FROM issue WHERE id=$1`, issue).Scan(&waitingAt)
	h, eventCount, hintCount := m209ObservedHandler(t, issue)
	if w := m209ReviewCall(h, issue, body); w.Code != 200 {
		t.Fatalf("answer = %d: %s", w.Code, w.Body.String())
	}
	if w := m209ReviewCall(h, issue, body); w.Code != 200 {
		t.Fatalf("retry = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "in_progress", 1, 1, 1)
	var requestedAt time.Time
	dbfx.QueryRow(t, `SELECT requested_at FROM issue_decision_response WHERE issue_id=$1`, issue).Scan(&requestedAt)
	if !requestedAt.Equal(waitingAt) {
		t.Fatalf("requested at %v, want %v", requestedAt, waitingAt)
	}
	if *eventCount != 3 || *hintCount != 1 {
		t.Fatalf("events/hints = %d/%d, want 3/1", *eventCount, *hintCount)
	}
}

func TestM209HandoffDoesNotAlsoWakeHandler(t *testing.T) {
	issue, agent, _, body := m209ReviewSetup(t)
	m209SeedWaitingStatus(t)
	var runtime string
	dbfx.QueryRow(t, `SELECT runtime_id::text FROM agent WHERE id=$1`, agent).Scan(&runtime)
	watcher := dbfx.Agent(t, "M209 watcher "+workflowTestSuffix(), runtime)
	svc := service.IssueWakeupService{Tasks: testHandler.TaskService}
	create := func(agentID string) string {
		w, err := svc.Create(t.Context(), parseUUID(issue), parseUUID(testUserID), pgtype.UUID{}, service.WakeupInput{AgentID: agentID, Kind: "event", EventTypes: []string{"issue.status_changed", "comment.created"}, Instruction: "review"})
		if err != nil {
			t.Fatal(err)
		}
		id := uuidToString(w.ID)
		t.Cleanup(func() {
			_, _ = testPool.Exec(context.Background(), `DELETE FROM issue_wakeup_receipt WHERE wakeup_id=$1`, id)
			_, _ = testPool.Exec(context.Background(), `DELETE FROM issue_wakeup WHERE id=$1`, id)
		})
		return id
	}
	handlerWakeup, watcherWakeup := create(agent), create(watcher)
	if w := m209ReviewCall(testHandler, issue, body); w.Code != 200 {
		t.Fatalf("answer = %d: %s", w.Code, w.Body.String())
	}
	var handlerCount, watcherCount int
	dbfx.QueryRow(t, `SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1`, handlerWakeup).Scan(&handlerCount)
	dbfx.QueryRow(t, `SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1`, watcherWakeup).Scan(&watcherCount)
	if handlerCount != 0 || watcherCount != 2 {
		t.Fatalf("handler/watcher wakeup receipts = %d/%d", handlerCount, watcherCount)
	}
	// A normal comment remains observable even when another write has named a
	// handoff agent; only decision responses opt into comment suppression.
	tx, err := testPool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `SELECT set_config('multica.handed_to_agent',$1,true)`, agent); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO comment(issue_id,workspace_id,author_type,author_id,content,type) VALUES ($1,$2,'member',$3,'normal comment','comment')`, issue, testWorkspaceID, testUserID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	dbfx.QueryRow(t, `SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='comment.created'`, handlerWakeup).Scan(&handlerCount)
	if handlerCount != 1 {
		t.Fatalf("normal comment wakeup receipts = %d, want 1", handlerCount)
	}
}

func TestM209SquadLeadHandoffAndAgentToken(t *testing.T) {
	issue, agent, project, body := m209ReviewSetup(t)
	squad := dbfx.Squad(t, "M209 squad "+workflowTestSuffix(), agent)
	// The workflow editor forbids new squad handoffs, but the decoder supports
	// persisted squad handlers. Exercise that existing stored representation.
	workflow := projectWorkflowID(t, project)
	var original []byte
	dbfx.QueryRow(t, `SELECT steps FROM issue_workflow WHERE id=$1`, workflow).Scan(&original)
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `UPDATE issue_workflow SET steps=$1 WHERE id=$2`, original, workflow)
	})
	dbfx.Exec(t, `UPDATE issue_workflow SET steps=(SELECT jsonb_agg(CASE WHEN step->>'status_key'='in_progress' THEN jsonb_set(step, '{handler}', jsonb_build_object('type','squad','id',$2::text)) ELSE step END ORDER BY n) FROM jsonb_array_elements(steps) WITH ORDINALITY AS s(step,n)) WHERE id=$1`, workflow, squad)
	req := withURLParam(workflowRequest("POST", "/api/issues/"+issue+"/decision-response", body), "issueId", issue)
	req.Header.Set("X-Actor-Source", "task_token")
	req.Header.Set("X-Agent-ID", agent)
	w := httptest.NewRecorder()
	testHandler.DecisionResponse(w, req)
	if w.Code != 403 {
		t.Fatalf("agent token = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "wait_for_decision", 0, 0, 0)
	other := dbfx.User(t, "squad owner", "m209-squad-owner-"+workflowTestSuffix()+"@example.invalid")
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `UPDATE agent SET owner_id=$1 WHERE id=$2`, testUserID, agent)
	})
	dbfx.Exec(t, `UPDATE agent SET owner_id=$1, permission_mode='private' WHERE id=$2`, other, agent)
	if w := m209ReviewCall(testHandler, issue, body); w.Code != 403 {
		t.Fatalf("unauthorized squad leader = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "wait_for_decision", 0, 0, 0)
	dbfx.Exec(t, `UPDATE agent SET permission_mode='public_to' WHERE id=$1`, agent)
	dbfx.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": agent, "target_type": "member", "target_id": testUserID})
	if w := m209ReviewCall(testHandler, issue, body); w.Code != 200 {
		t.Fatalf("squad answer = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "in_progress", 1, 1, 1)
	var gotSquad, gotAgent string
	var leader bool
	dbfx.QueryRow(t, `SELECT squad_id::text, agent_id::text, is_leader_task FROM agent_task_queue WHERE issue_id=$1`, issue).Scan(&gotSquad, &gotAgent, &leader)
	if gotSquad != squad || gotAgent != agent || !leader {
		t.Fatalf("incorrect squad task %s/%s/%v", gotSquad, gotAgent, leader)
	}
}

func TestM209NoHandlerAndChangedActor(t *testing.T) {
	issue, _, _, body := m209ReviewSetup(t)
	body["next_status"] = "in_review"
	w := m209ReviewCall(testHandler, issue, body)
	if w.Code != 200 {
		t.Fatalf("no handler = %d: %s", w.Code, w.Body.String())
	}
	var receipt map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt["task_id"] != nil {
		t.Fatalf("no-handler task_id = %v, want null", receipt["task_id"])
	}
	assertM209Rows(t, issue, "in_review", 1, 1, 0)
	other := dbfx.User(t, "another responder", "m209-responder-"+workflowTestSuffix()+"@example.invalid")
	dbfx.Member(t, testWorkspaceID, other, "member")
	req := withURLParam(workflowRequest("POST", "/api/issues/"+issue+"/decision-response", body), "issueId", issue)
	req.Header.Set("X-User-ID", other)
	w = httptest.NewRecorder()
	testHandler.DecisionResponse(w, req)
	if w.Code != 409 {
		t.Fatalf("changed actor = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "in_review", 1, 1, 0)
}

func TestM209UnprojectedIssue(t *testing.T) {
	issue, _, _, body := m209ReviewSetup(t)
	dbfx.Exec(t, `UPDATE issue SET project_id=NULL WHERE id=$1`, issue)
	var revision int64
	dbfx.QueryRow(t, `SELECT revision FROM issue WHERE id=$1`, issue).Scan(&revision)
	body["expected_issue_revision"] = revision
	if w := m209ReviewCall(testHandler, issue, body); w.Code != 200 {
		t.Fatalf("unprojected issue = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "in_progress", 1, 1, 0)
}

func TestM209ExistingPendingTaskRollsBack(t *testing.T) {
	issue, agent, _, body := m209ReviewSetup(t)
	var runtimeID string
	dbfx.QueryRow(t, `SELECT runtime_id::text FROM agent WHERE id=$1`, agent).Scan(&runtimeID)
	dbfx.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": runtimeID, "status": "queued"})
	if w := m209ReviewCall(testHandler, issue, body); w.Code != 409 {
		t.Fatalf("pending task conflict = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "wait_for_decision", 0, 0, 1)
}

func TestM209ForbiddenWorkflowStep(t *testing.T) {
	issue, _, project, body := m209ReviewSetup(t)
	m209SeedWaitingStatus(t)
	wf := createTestWorkflow(t, "M209 restricted "+workflowTestSuffix(), "wait_for_decision")
	setProjectWorkflow(t, project, map[string]any{"workflow_id": wf.ID}).Want(200)
	if w := m209ReviewCall(testHandler, issue, body); w.Code != 400 {
		t.Fatalf("step outside workflow = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "wait_for_decision", 0, 0, 0)
}

func m209SeedWaitingStatus(t *testing.T) {
	t.Helper()
	dbfx.Exec(t, `INSERT INTO issue_status (workspace_id,key,name,description,category,color,position) VALUES ($1,'wait_for_decision','Wait for decision','','started','#ff0000',1)`, testWorkspaceID)
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM issue_status WHERE workspace_id=$1 AND key='wait_for_decision'`, testWorkspaceID)
	})
}

func m209ReviewSetup(t *testing.T) (string, string, string, map[string]any) {
	t.Helper()
	seedTestCatalog(t)
	agent := createHandlerTestAgent(t, "M209 review target", []byte(`{}`))
	project := deliveryProject(t, "M209 review project", agent)
	issue := dbfx.Issue(t, "M209 review answer", testutil.Cols{"project_id": project, "status": "wait_for_decision"})
	t.Cleanup(func() {
		for _, table := range []string{"issue_decision_response", "comment", "agent_task_queue"} {
			_, _ = testPool.Exec(context.Background(), "DELETE FROM "+table+" WHERE issue_id=$1", issue)
		}
	})
	var revision int64
	var requestID string
	dbfx.QueryRow(t, "SELECT revision, gen_random_uuid()::text FROM issue WHERE id=$1", issue).Scan(&revision, &requestID)
	return issue, agent, project, map[string]any{"client_request_id": requestID, "expected_issue_revision": revision, "decision": "Approve", "next_status": "in_progress"}
}

func TestM209InvocationUsesTransaction(t *testing.T) {
	issue, agentID, _, _ := m209ReviewSetup(t)
	_ = issue
	owner := dbfx.User(t, "other owner", "m209-auth-other-"+workflowTestSuffix()+"@example.invalid")
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `UPDATE agent SET owner_id=$1 WHERE id=$2`, testUserID, agentID)
	})
	dbfx.Exec(t, `UPDATE agent SET owner_id=$1, permission_mode='public_to' WHERE id=$2`, owner, agentID)
	dbfx.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": agentID, "target_type": "member", "target_id": testUserID})
	agent, err := testHandler.Queries.GetAgent(t.Context(), parseUUID(agentID))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := testPool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `DELETE FROM agent_invocation_target WHERE agent_id=$1`, agentID); err != nil {
		t.Fatal(err)
	}
	if !testHandler.canInvokeAgent(t.Context(), agent, "member", testUserID, testUserID, testWorkspaceID) {
		t.Fatal("shared connection should still see the committed grant")
	}
	if testHandler.canInvokeAgentWithQueries(t.Context(), testHandler.Queries.WithTx(tx), agent, "member", testUserID, testUserID, testWorkspaceID) {
		t.Fatal("transaction ignored the revoked grant")
	}
}

func TestM209AuthorizationRevokedBeforeTransaction(t *testing.T) {
	issue, agent, _, body := m209ReviewSetup(t)
	owner := dbfx.User(t, "other owner", "m209-auth-change-"+workflowTestSuffix()+"@example.invalid")
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `UPDATE agent SET owner_id=$1 WHERE id=$2`, testUserID, agent)
	})
	dbfx.Exec(t, `UPDATE agent SET owner_id=$1, permission_mode='public_to' WHERE id=$2`, owner, agent)
	dbfx.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": agent, "target_type": "member", "target_id": testUserID})
	h := *testHandler
	h.TxStarter = hookedTxStarter{base: testHandler.TxStarter, hook: func() error {
		_, err := testPool.Exec(context.Background(), `DELETE FROM agent_invocation_target WHERE agent_id=$1`, agent)
		return err
	}}
	w := m209ReviewCall(&h, issue, body)
	if w.Code != 403 {
		t.Fatalf("revoked authorization returned %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "wait_for_decision", 0, 0, 0)
}

func assertM209Rows(t *testing.T, issue, status string, receipts, comments, tasks int) {
	t.Helper()
	var gotStatus string
	var r, c, q int
	err := testPool.QueryRow(t.Context(), `SELECT status,
		(SELECT count(*) FROM issue_decision_response WHERE issue_id=i.id),
		(SELECT count(*) FROM comment WHERE issue_id=i.id),
		(SELECT count(*) FROM agent_task_queue WHERE issue_id=i.id)
		FROM issue i WHERE id=$1`, issue).Scan(&gotStatus, &r, &c, &q)
	if err != nil {
		t.Fatal(err)
	}
	if gotStatus != status || r != receipts || c != comments || q != tasks {
		t.Fatalf("status/receipts/comments/tasks = %s/%d/%d/%d; want %s/%d/%d/%d", gotStatus, r, c, q, status, receipts, comments, tasks)
	}
}

func TestM209ConcurrentRetryAndConflicts(t *testing.T) {
	issue, _, _, body := m209ReviewSetup(t)
	const n = 4
	results := make([]*httptest.ResponseRecorder, n)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(i int) { defer wg.Done(); results[i] = m209ReviewCall(testHandler, issue, body) }(i)
	}
	wg.Wait()
	var original map[string]any
	for _, result := range results {
		if result.Code != 200 {
			t.Fatalf("concurrent retry returned %d: %s", result.Code, result.Body.String())
		}
		var receipt map[string]any
		if err := json.Unmarshal(result.Body.Bytes(), &receipt); err != nil {
			t.Fatal(err)
		}
		if original == nil {
			original = receipt
		} else if receipt["id"] != original["id"] {
			t.Fatalf("different receipts: %v and %v", original, receipt)
		}
	}
	assertM209Rows(t, issue, "in_progress", 1, 1, 1)
	changed := make(map[string]any, len(body))
	for k, v := range body {
		changed[k] = v
	}
	changed["decision"] = "Reject"
	if w := m209ReviewCall(testHandler, issue, changed); w.Code != 409 {
		t.Fatalf("changed payload = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "in_progress", 1, 1, 1)
}

func TestM209ReceiptAppearsDuringPreparation(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "matching", true: "different revision"}[changed], func(t *testing.T) {
			issue, agent, _, body := m209ReviewSetup(t)
			if !changed {
				dbfx.Exec(t, `UPDATE agent SET archived_at=now() WHERE id=$1`, agent)
			}
			h := *testHandler
			h.TxStarter = hookedTxStarter{base: testHandler.TxStarter, hook: func() error {
				if !changed {
					dbfx.Exec(t, `UPDATE agent SET archived_at=NULL WHERE id=$1`, agent)
				}
				w := m209ReviewCall(testHandler, issue, body)
				if w.Code != 200 {
					t.Fatalf("concurrent original = %d: %s", w.Code, w.Body.String())
				}
				return nil
			}}
			request := make(map[string]any, len(body))
			for k, v := range body {
				request[k] = v
			}
			if changed {
				request["expected_issue_revision"] = body["expected_issue_revision"].(int64) + 1
			}
			w := m209ReviewCall(&h, issue, request)
			want := 200
			if changed {
				want = 409
			}
			if w.Code != want {
				t.Fatalf("retry = %d, want %d: %s", w.Code, want, w.Body.String())
			}
			assertM209Rows(t, issue, "in_progress", 1, 1, 1)
		})
	}
}

func TestM209StaleAndInvalidStatus(t *testing.T) {
	issue, _, _, body := m209ReviewSetup(t)
	invalid := make(map[string]any, len(body))
	for k, v := range body {
		invalid[k] = v
	}
	invalid["next_status"] = "wait_for_decision"
	if w := m209ReviewCall(testHandler, issue, invalid); w.Code != 400 {
		t.Fatalf("same status = %d: %s", w.Code, w.Body.String())
	}
	invalid["next_status"] = "not_a_workflow_step"
	if w := m209ReviewCall(testHandler, issue, invalid); w.Code != 400 {
		t.Fatalf("forbidden status = %d: %s", w.Code, w.Body.String())
	}
	dbfx.Exec(t, `UPDATE issue SET status='in_progress', revision=revision+1 WHERE id=$1`, issue)
	dbfx.Exec(t, `UPDATE issue SET status='wait_for_decision', revision=revision+1 WHERE id=$1`, issue)
	if w := m209ReviewCall(testHandler, issue, body); w.Code != 409 {
		t.Fatalf("old waiting visit = %d: %s", w.Code, w.Body.String())
	}
	assertM209Rows(t, issue, "wait_for_decision", 0, 0, 0)
}

func m209ReviewCall(h *Handler, issue string, body map[string]any) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := withURLParam(workflowRequest("POST", "/api/issues/"+issue+"/decision-response", body), "issueId", issue)
	h.DecisionResponse(w, req)
	return w
}

func TestM209ReviewTaskUsesDestinationStep(t *testing.T) {
	issue, _, _, body := m209ReviewSetup(t)
	w := m209ReviewCall(testHandler, issue, body)
	if w.Code != 200 {
		t.Fatalf("initial response %d: %s", w.Code, w.Body.String())
	}
	var step string
	dbfx.QueryRow(t, "SELECT workflow_step FROM agent_task_queue WHERE issue_id=$1", issue).Scan(&step)
	if step != "in_progress" {
		t.Fatalf("queued task workflow_step=%q, want destination in_progress", step)
	}
}

func TestM209ReviewRetrySurvivesArchivedTarget(t *testing.T) {
	issue, agent, _, body := m209ReviewSetup(t)
	w := m209ReviewCall(testHandler, issue, body)
	if w.Code != 200 {
		t.Fatalf("initial response %d: %s", w.Code, w.Body.String())
	}
	dbfx.Exec(t, "UPDATE agent SET archived_at=now() WHERE id=$1", agent)
	retry := m209ReviewCall(testHandler, issue, body)
	if retry.Code != 200 {
		t.Fatalf("matching retry %d: %s; expected original receipt", retry.Code, retry.Body.String())
	}
}

func TestM209ReviewWorkflowTargetChangedBeforeBegin(t *testing.T) {
	issue, _, project, body := m209ReviewSetup(t)
	replacement := createHandlerTestAgent(t, "M209 replacement target", []byte(`{}`))
	h := *testHandler
	h.TxStarter = hookedTxStarter{base: testHandler.TxStarter, hook: func() error {
		setColumnHandoff(t, project, "in_progress", handToAgent(replacement, "Replacement instructions")).Want(200)
		return nil
	}}
	w := m209ReviewCall(&h, issue, body)
	if w.Code == 409 {
		return
	}
	if w.Code != 200 {
		t.Fatalf("unexpected response %d: %s", w.Code, w.Body.String())
	}
	var assignee, queued string
	dbfx.QueryRow(t, "SELECT assignee_id::text FROM issue WHERE id=$1", issue).Scan(&assignee)
	dbfx.QueryRow(t, "SELECT agent_id::text FROM agent_task_queue WHERE issue_id=$1", issue).Scan(&queued)
	if assignee != queued {
		t.Fatalf("committed issue assignee=%s but queued agent=%s", assignee, queued)
	}
}

func TestM209ReviewMemberHandoffRequiresNoTask(t *testing.T) {
	issue, _, project, body := m209ReviewSetup(t)
	setColumnHandoff(t, project, "in_progress", map[string]any{"handler": map[string]any{"type": "member", "id": testUserID}}).Want(200)
	w := m209ReviewCall(testHandler, issue, body)
	if w.Code != 200 {
		t.Fatalf("stable member handoff returned %d: %s; expected receipt/status/comment without task", w.Code, w.Body.String())
	}
	var count int
	dbfx.QueryRow(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue).Scan(&count)
	if count != 0 {
		t.Fatalf("member handoff created %d tasks", count)
	}
}
