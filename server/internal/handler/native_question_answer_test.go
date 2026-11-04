package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// nativeAnswerFixture is one running, supplement-capable turn whose newest
// transcript row is a parked question.
type nativeAnswerFixture struct {
	supplementFixture
	askSeq int32
}

const nativeAskInput = `{"questions":[{"id":"q1","header":"Scope","question":"Which checkout should this land in?","options":[{"label":"Web"},{"label":"Mobile"}],"multi_select":false}]}`

func newNativeAnswerFixture(t *testing.T) nativeAnswerFixture {
	t.Helper()
	f := newSupplementFixture(t, "codex", "running", true)
	dbfx.Insert(t, "task_message", testutil.Cols{"task_id": f.taskID, "seq": 1, "type": "text", "content": "working on it"})
	dbfx.Insert(t, "task_message", testutil.Cols{
		"task_id": f.taskID, "seq": 2, "type": "question", "content": "Which checkout should this land in?",
		"input": testutil.Raw(quoteSQL(nativeAskInput) + "::jsonb"),
	})
	dbfx.Cleanup(t, `DELETE FROM native_question_answer WHERE task_id = $1`, f.taskID)
	return nativeAnswerFixture{supplementFixture: f, askSeq: 2}
}

func quoteSQL(value string) string {
	return `'` + strings.ReplaceAll(value, `'`, `''`) + `'`
}

func (f supplementFixture) insertRow(t *testing.T, seq int32, input *string) {
	t.Helper()
	dbfx.Insert(t, "task_message", testutil.Cols{"task_id": f.taskID, "seq": seq, "type": "text", "content": "row", "input": nil})
}

// insertAt writes one transcript row with the timestamp the shipped-predicate
// fixtures carry, so a delivered steer and an ask compare on the same clock.
func (f supplementFixture) insertAt(t *testing.T, seq int32, input *string, at *time.Time) {
	t.Helper()
	cols := testutil.Cols{"task_id": f.taskID, "seq": seq, "type": "text", "content": "row"}
	if input != nil {
		cols["input"] = testutil.Raw(quoteSQL(*input) + "::jsonb")
	}
	if at != nil {
		cols["created_at"] = *at
	}
	dbfx.Insert(t, "task_message", cols)
}

func (f supplementFixture) deliverSteer(t *testing.T, at string) {
	t.Helper()
	dbfx.Exec(t, `INSERT INTO task_supplement (task_id, workspace_id, issue_id, comment_id, author_id, client_request_id, status, delivered_at)
		VALUES ($1, $2, $3, gen_random_uuid(), $4, gen_random_uuid(), 'delivered', `+at+`)`,
		f.taskID, testWorkspaceID, f.issueID, testUserID)
}

func (f supplementFixture) deliverSteerSinceAsk(t *testing.T) {
	t.Helper()
	f.deliverSteer(t, "now() + interval '1 second'")
}

func answerRequest(t *testing.T, f supplementFixture, seq int32, requestID, content string) *testutil.Response {
	t.Helper()
	req := newRequest(http.MethodPost, "/api/issues/"+f.issueID+"/tasks/"+f.taskID+"/question-answers", map[string]any{
		"question_seq":      seq,
		"content":           content,
		"client_request_id": requestID,
	})
	return testutil.Call(t, testHandler.CreateNativeQuestionAnswer,
		withURLParams(req, "id", f.issueID, "taskId", f.taskID),
	)
}

func wantConflictCode(t *testing.T, resp *testutil.Response, code string) {
	t.Helper()
	if got := resp.Want(http.StatusConflict).Map()["code"]; got != code {
		t.Fatalf("error code = %v, want %q: %s", got, code, resp.Text())
	}
}

// claimSupplement moves the answer's receipt to delivering, which is what the
// daemon does before it acknowledges success or failure.
func claimSupplement(t *testing.T, f supplementFixture, commentID string) {
	t.Helper()
	dbfx.Exec(t, `UPDATE task_supplement SET status = 'delivering', attempt_count = attempt_count + 1
		WHERE comment_id = $1 AND task_id = $2`, commentID, f.taskID)
}

func (f supplementFixture) countRows(t *testing.T, table string) int {
	t.Helper()
	return dbfx.Count(t, `SELECT count(*) FROM `+table+` WHERE task_id = $1`, f.taskID)
}

// answerComments counts the issue's comments that are not the run's trigger
// comment, which every supplement fixture starts with.
func (f supplementFixture) answerComments(t *testing.T) int {
	t.Helper()
	return dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id = $1 AND id <> $2`, f.issueID, f.triggerID)
}

// liveSupplements counts receipts other than the delivered steers a fixture
// inserts to make an ask stale.
func (f supplementFixture) liveSupplements(t *testing.T) int {
	t.Helper()
	return dbfx.Count(t, `SELECT count(*) FROM task_supplement WHERE task_id = $1 AND status <> 'delivered'`, f.taskID)
}

func TestNativeQuestionAnswerBindsOneAnswer(t *testing.T) {
	f := newNativeAnswerFixture(t)
	var before int64
	dbfx.QueryRow(t, `SELECT revision FROM issue WHERE id = $1`, f.issueID).Scan(&before)

	var created CommentResponse
	answerRequest(t, f.supplementFixture, f.askSeq, "0199a4e8-22ce-7b01-bba5-0000000000a1", "Web").
		Want(http.StatusCreated).JSON(&created)

	if created.Content != "Web" || created.AuthorType != "member" {
		t.Fatalf("receipt = %+v, want the member's own answer", created)
	}
	if created.SupplementStatus != "pending" {
		t.Fatalf("supplement status = %q, want pending", created.SupplementStatus)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id = $1 AND content = 'Web'`, f.issueID); n != 1 {
		t.Fatalf("wrote %d answers, want 1", n)
	}
	if n := f.countRows(t, "task_supplement"); n != 1 {
		t.Fatalf("wrote %d supplements, want 1", n)
	}
	if n := f.countRows(t, "native_question_answer"); n != 1 {
		t.Fatalf("wrote %d bindings, want 1", n)
	}
	var seq int32
	dbfx.QueryRow(t, `SELECT question_seq FROM native_question_answer WHERE task_id = $1`, f.taskID).Scan(&seq)
	if seq != f.askSeq {
		t.Fatalf("binding names sequence %d, want %d", seq, f.askSeq)
	}
	var after int64
	dbfx.QueryRow(t, `SELECT revision FROM issue WHERE id = $1`, f.issueID).Scan(&after)
	if after != before+1 {
		t.Fatalf("issue revision moved %d → %d, want exactly one touch", before, after)
	}
}

func TestNativeQuestionAnswerRetryReturnsTheSameReceipt(t *testing.T) {
	f := newNativeAnswerFixture(t)
	var first, again CommentResponse
	answerRequest(t, f.supplementFixture, f.askSeq, "0199a4e8-22ce-7b01-bba5-0000000000b1", "Mobile").
		Want(http.StatusCreated).JSON(&first)
	answerRequest(t, f.supplementFixture, f.askSeq, "0199a4e8-22ce-7b01-bba5-0000000000b1", "Mobile").
		Want(http.StatusOK).JSON(&again)

	if again.ID != first.ID {
		t.Fatalf("retry returned comment %s, want the original %s", again.ID, first.ID)
	}
	if n := f.countRows(t, "native_question_answer"); n != 1 {
		t.Fatalf("retry wrote %d bindings, want 1", n)
	}
	if n := f.countRows(t, "task_supplement"); n != 1 {
		t.Fatalf("retry wrote %d supplements, want 1", n)
	}
}

func TestNativeQuestionAnswerSecondWindowLoses(t *testing.T) {
	f := newNativeAnswerFixture(t)
	answerRequest(t, f.supplementFixture, f.askSeq, "0199a4e8-22ce-7b01-bba5-0000000000c1", "Web").
		Want(http.StatusCreated)

	wantConflictCode(t, answerRequest(t, f.supplementFixture, f.askSeq, "0199a4e8-22ce-7b01-bba5-0000000000c2", "Mobile").
		Want(http.StatusConflict), "question_already_answered")

	if n := f.countRows(t, "native_question_answer"); n != 1 {
		t.Fatalf("two windows wrote %d bindings, want 1", n)
	}
	if n := f.answerComments(t); n != 1 {
		t.Fatalf("two windows wrote %d comments, want 1", n)
	}
}

func TestNativeQuestionAnswerRejectsAnAskTheRunLeft(t *testing.T) {
	cases := []struct {
		name  string
		seq   int32
		setup func(t *testing.T, f supplementFixture)
	}{
		{name: "stale sequence", seq: 1},
		{
			name: "later progress",
			setup: func(t *testing.T, f supplementFixture) {
				f.insertRow(t, 3, nil)
			},
		},
		{
			name: "delivered answer since the ask",
			setup: func(t *testing.T, f supplementFixture) {
				f.deliverSteerSinceAsk(t)
			},
		},
		{name: "not a question", seq: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newNativeAnswerFixture(t)
			if tc.setup != nil {
				tc.setup(t, f.supplementFixture)
			}
			seq := f.askSeq
			if tc.seq != 0 {
				seq = tc.seq
			}
			wantConflictCode(t, answerRequest(t, f.supplementFixture, seq, "0199a4e8-22ce-7b01-bba5-0000000000d1", "Web").
				Want(http.StatusConflict), "question_not_pending")
			if n := f.countRows(t, "native_question_answer"); n != 0 {
				t.Fatalf("a refused answer wrote %d bindings", n)
			}
			if n := f.liveSupplements(t); n != 0 {
				t.Fatalf("a refused answer wrote %d supplements", n)
			}
			if n := f.answerComments(t); n != 0 {
				t.Fatalf("a refused answer wrote %d comments", n)
			}
		})
	}
}

func TestNativeQuestionAnswerTerminalTaskRace(t *testing.T) {
	f := newNativeAnswerFixture(t)
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed', completed_at = now() WHERE id = $1`, f.taskID)

	wantConflictCode(t, answerRequest(t, f.supplementFixture, f.askSeq, "0199a4e8-22ce-7b01-bba5-0000000000e1", "Web").
		Want(http.StatusConflict), "task_supplement_turn_ended")
	if n := f.countRows(t, "native_question_answer"); n != 0 {
		t.Fatalf("a completed run accepted %d answers", n)
	}
	if n := f.answerComments(t); n != 0 {
		t.Fatalf("a completed run wrote %d comments", n)
	}
}

func TestNativeQuestionAnswerRequiresNegotiatedCapability(t *testing.T) {
	f := newSupplementFixture(t, "codex", "running", false)
	f.insertRow(t, 2, strPtr(nativeAskInput))
	answerRequest(t, f, 2, "0199a4e8-22ce-7b01-bba5-0000000000f1", "Web").Want(http.StatusPreconditionFailed)
	if n := f.countRows(t, "native_question_answer"); n != 0 {
		t.Fatalf("an unsupported run accepted %d answers", n)
	}
}

func TestNativeQuestionAnswerRejectsMachineCredentials(t *testing.T) {
	f := newNativeAnswerFixture(t)
	guarded := RequireHumanActor(http.HandlerFunc(testHandler.CreateNativeQuestionAnswer))
	req := newRequest(http.MethodPost, "/api/issues/"+f.issueID+"/tasks/"+f.taskID+"/question-answers", map[string]any{
		"question_seq":      f.askSeq,
		"content":           "Web",
		"client_request_id": "0199a4e8-22ce-7b01-bba5-000000000101",
	})
	req.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, guarded.ServeHTTP, withURLParams(req, "id", f.issueID, "taskId", f.taskID)).
		Want(http.StatusForbidden)
	if n := f.countRows(t, "native_question_answer"); n != 0 {
		t.Fatalf("a machine credential answered %d questions", n)
	}
}

func TestNativeQuestionAnswerRetryAfterFailedDelivery(t *testing.T) {
	f := newNativeAnswerFixture(t)
	var created CommentResponse
	answerRequest(t, f.supplementFixture, f.askSeq, "0199a4e8-22ce-7b01-bba5-000000000111", "Web").
		Want(http.StatusCreated).JSON(&created)

	claimSupplement(t, f.supplementFixture, created.ID)
	ack := withURLParams(newOwnerDaemonRequest(http.MethodPost, "/ack", map[string]any{
		"delivered": false, "error": protocol.TaskSupplementFailureProviderRejected,
	}), "taskId", f.taskID, "commentId", created.ID)
	testutil.Call(t, testHandler.AckTaskSupplement, ack).Want(http.StatusOK)

	// A second answer to the same sequence is still the same question: the
	// member retries the failed receipt instead of steering a new one.
	wantConflictCode(t, answerRequest(t, f.supplementFixture, f.askSeq, "0199a4e8-22ce-7b01-bba5-000000000112", "Web").
		Want(http.StatusConflict), "question_already_answered")

	retry := withURLParams(newRequest(http.MethodPost, "/retry", nil), "id", f.issueID, "taskId", f.taskID, "commentId", created.ID)
	testutil.Call(t, testHandler.RetryTaskSupplement, retry).Want(http.StatusOK)
	if n := f.countRows(t, "native_question_answer"); n != 1 {
		t.Fatalf("retry wrote %d bindings, want the original", n)
	}
	var status string
	dbfx.QueryRow(t, `SELECT status FROM task_supplement WHERE comment_id = $1`, created.ID).Scan(&status)
	if status != "pending" {
		t.Fatalf("retried supplement is %q, want pending", status)
	}
}

// TestNativeDecisionReceiptStates walks the projection's answer states: an
// unanswered ask is open, a queued steer is queued with its receipt, a failed
// delivery is failed with its reason, and only delivery takes the row out of
// the pending queue.
func TestNativeDecisionReceiptStates(t *testing.T) {
	f := newNativeAnswerFixture(t)
	native := func() *decisionItem {
		t.Helper()
		raw, err := testHandler.Queries.ListDecisions(t.Context(), db.ListDecisionsParams{
			WorkspaceID:   parseUUID(testWorkspaceID),
			VisibleAgents: []pgtype.UUID{parseUUID(f.agentID)},
			State:         "pending",
			PageLimit:     100,
		})
		if err != nil {
			t.Fatal(err)
		}
		var got decisionsResult
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatal(err)
		}
		for i, item := range got.Items {
			if item.Kind == "native" && item.TaskID != nil && *item.TaskID == f.taskID {
				return &got.Items[i]
			}
		}
		return nil
	}

	open := native()
	if open == nil || open.Status != "open" || open.ResponseID != nil {
		t.Fatalf("unanswered ask = %+v, want open with no receipt", open)
	}

	var created CommentResponse
	answerRequest(t, f.supplementFixture, f.askSeq, "0199a4e8-22ce-7b01-bba5-000000000121", "Web").
		Want(http.StatusCreated).JSON(&created)

	queued := native()
	if queued == nil || queued.Status != "queued" {
		t.Fatalf("queued ask = %+v, want queued", queued)
	}
	if queued.ResponseID == nil || *queued.ResponseID != created.ID {
		t.Fatalf("queued row receipt = %v, want %s", queued.ResponseID, created.ID)
	}

	claimSupplement(t, f.supplementFixture, created.ID)
	ack := withURLParams(newOwnerDaemonRequest(http.MethodPost, "/ack", map[string]any{
		"delivered": false, "error": protocol.TaskSupplementFailureTurnEnded,
	}), "taskId", f.taskID, "commentId", created.ID)
	testutil.Call(t, testHandler.AckTaskSupplement, ack).Want(http.StatusOK)

	failed := native()
	if failed == nil || failed.Status != "failed" {
		t.Fatalf("failed ask = %+v, want failed", failed)
	}
	if failed.ReceiptReason == nil || *failed.ReceiptReason != protocol.TaskSupplementFailureTurnEnded {
		t.Fatalf("failed row reason = %v", failed.ReceiptReason)
	}

	claimSupplement(t, f.supplementFixture, created.ID)
	redeliver := withURLParams(newOwnerDaemonRequest(http.MethodPost, "/ack", map[string]any{
		"delivered": true,
	}), "taskId", f.taskID, "commentId", created.ID)
	testutil.Call(t, testHandler.AckTaskSupplement, redeliver).Want(http.StatusOK)
	if delivered := native(); delivered != nil {
		t.Fatalf("a delivered answer left the row pending: %+v", delivered)
	}
}

// TestNativeAnswerParityWithShippedPredicate reuses the same fixture the UI's
// isAgentQuestionPending cases come from: the answer fence and the shipped
// predicate must agree on every case the database can hold. Timestamp-less
// cases are client-side only — task_message.created_at is NOT NULL here, so a
// database row always has one.
func TestNativeAnswerParityWithShippedPredicate(t *testing.T) {
	data, err := os.ReadFile("../../../packages/core/issues/__fixtures__/agent-question-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string `json:"name"`
		Messages []struct {
			Seq       int             `json:"seq"`
			CreatedAt *time.Time      `json:"created_at"`
			Input     json.RawMessage `json:"input"`
		} `json:"messages"`
		Live      bool        `json:"live"`
		Delivered []time.Time `json:"delivered"`
		Pending   bool        `json:"pending"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		skip := len(tc.Messages) == 0
		for _, m := range tc.Messages {
			if len(m.Input) > 0 && m.CreatedAt == nil {
				skip = true
			}
		}
		if skip {
			continue
		}
		t.Run(tc.Name, func(t *testing.T) {
			f := newSupplementFixture(t, "codex", "running", true)
			dbfx.Cleanup(t, `DELETE FROM native_question_answer WHERE task_id = $1`, f.taskID)
			if !tc.Live {
				dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed', completed_at = now() WHERE id = $1`, f.taskID)
			}
			askSeq := int32(-1)
			for _, m := range tc.Messages {
				input := string(m.Input)
				f.insertAt(t, int32(m.Seq), inputOrNil(input), m.CreatedAt)
				if input != "" {
					askSeq = int32(m.Seq)
				}
			}
			for _, at := range tc.Delivered {
				dbfx.Exec(t, `INSERT INTO task_supplement (task_id, workspace_id, issue_id, comment_id, author_id, client_request_id, status, delivered_at)
					VALUES ($1, $2, $3, gen_random_uuid(), $4, gen_random_uuid(), 'delivered', $5)`,
					f.taskID, testWorkspaceID, f.issueID, testUserID, at)
			}
			if askSeq < 0 {
				// No ask at all: any sequence is stale.
				wantConflictCode(t, answerRequest(t, f, 0, "0199a4e8-22ce-7b01-bba5-000000000131", "Web").
					Want(http.StatusConflict), "question_not_pending")
				return
			}
			resp := answerRequest(t, f, askSeq, "0199a4e8-22ce-7b01-bba5-000000000132", "Web")
			if tc.Pending {
				resp.Want(http.StatusCreated)
				return
			}
			// A finished run reports its own fence; a live one that moved past
			// the ask reports the question is no longer pending.
			want := "question_not_pending"
			if !tc.Live {
				want = "task_supplement_turn_ended"
			}
			wantConflictCode(t, resp, want)
		})
	}
}

func inputOrNil(input string) *string {
	if input == "" {
		return nil
	}
	return &input
}
