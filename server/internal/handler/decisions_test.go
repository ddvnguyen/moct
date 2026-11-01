package handler

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestNativeDecisionParity(t *testing.T) {
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
		t.Run(tc.Name, func(t *testing.T) {
			issue := dbfx.Issue(t, "native parity")
			runtime := dbfx.Runtime(t, "parity runtime")
			agent := dbfx.Agent(t, "parity agent", runtime)
			task := dbfx.Task(t, agent, testutil.Cols{"issue_id": issue, "status": "running", "runtime_id": runtime})
			tx, err := testPool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(t.Context())
			_, err = tx.Exec(t.Context(), `CREATE TEMP TABLE task_message ON COMMIT DROP AS SELECT * FROM public.task_message WITH NO DATA`)
			if err != nil {
				t.Fatal(err)
			}
			_, err = tx.Exec(t.Context(), `INSERT INTO task_supplement_capability (task_id,workspace_id,issue_id,capability) VALUES ($1,$2,$3,'task-supplement-v1')`, task, testWorkspaceID, issue)
			if err != nil {
				t.Fatal(err)
			}
			if !tc.Live {
				_, err = tx.Exec(t.Context(), `UPDATE agent_task_queue SET status='completed' WHERE id=$1`, task)
				if err != nil {
					t.Fatal(err)
				}
			}
			for _, m := range tc.Messages {
				var input any
				if len(m.Input) > 0 {
					input = string(m.Input)
				}
				_, err = tx.Exec(t.Context(), `INSERT INTO task_message (id,task_id,seq,type,input,created_at) VALUES (gen_random_uuid(),$1,$2,'text',$3::jsonb,$4)`, task, m.Seq, input, m.CreatedAt)
				if err != nil {
					t.Fatal(err)
				}
			}
			for _, at := range tc.Delivered {
				_, err = tx.Exec(t.Context(), `INSERT INTO task_supplement (task_id,workspace_id,issue_id,comment_id,author_id,client_request_id,status,delivered_at) VALUES ($1,$2,$3,gen_random_uuid(),$4,gen_random_uuid(),'delivered',$5)`, task, testWorkspaceID, issue, testUserID, at)
				if err != nil {
					t.Fatal(err)
				}
			}
			raw, err := db.New(tx).ListDecisions(t.Context(), db.ListDecisionsParams{WorkspaceID: parseUUID(testWorkspaceID), VisibleAgents: []pgtype.UUID{parseUUID(agent)}, State: "pending", PageLimit: 100})
			if err != nil {
				t.Fatal(err)
			}
			var got decisionsResult
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatal(err)
			}
			found := false
			for _, item := range got.Items {
				if item.Kind == "native" && item.TaskID != nil && *item.TaskID == task {
					found = true
				}
			}
			if found != tc.Pending {
				t.Fatalf("native pending = %v, want %v", found, tc.Pending)
			}
		})
	}
}

func TestDecisionProjectionScopeAndPages(t *testing.T) {
	project := dbfx.Project(t, "decisions project")
	issue := dbfx.Issue(t, "structured", testutil.Cols{"project_id": project})
	waiting := dbfx.Issue(t, "fallback", testutil.Cols{"project_id": project})
	other := dbfx.Issue(t, "unprojected")
	agent := dbfx.Agent(t, "decision owner", "")
	tx, err := testPool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	_, err = tx.Exec(t.Context(), `UPDATE issue SET status='wait_for_decision' WHERE id=ANY($1::uuid[])`, []string{issue, waiting, other})
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(t.Context(), `INSERT INTO agent_question_card (workspace_id,issue_id,task_id,agent_id,status,questions,created_at) VALUES ($1,$2,gen_random_uuid(),$3,'open','[]',now()-interval '3 minutes'), ($1,$2,gen_random_uuid(),$3,'open','[]',now()-interval '2 minutes'), ($1,$2,gen_random_uuid(),$3,'answered','[]',now()-interval '5 minutes')`, testWorkspaceID, issue, agent)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(t.Context(), `UPDATE agent_question_card SET answered_at=now(),answered_by=$2 WHERE issue_id=$1 AND status='answered'`, issue, testUserID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(t.Context(), `INSERT INTO agent_question_card (workspace_id,issue_id,task_id,agent_id,status,questions) VALUES ($1,$2,gen_random_uuid(),$3,'withdrawn','[]')`, testWorkspaceID, waiting, agent)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(t.Context(), `INSERT INTO agent_plan (workspace_id,issue_id,task_id,agent_id,title,status) VALUES ($1,$2,gen_random_uuid(),$3,'draft','draft')`, testWorkspaceID, waiting, agent)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(t.Context(), `INSERT INTO agent_plan (workspace_id,issue_id,task_id,agent_id,title,status,updated_at) VALUES ($1,$2,gen_random_uuid(),$3,'plan','in_review',now()-interval '1 minute')`, testWorkspaceID, issue, agent)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(t.Context(), `INSERT INTO agent_plan_review (plan_id,plan_revision,verdict,comments,reviewed_by) SELECT id,1,'changes_requested','[]',$2 FROM agent_plan WHERE issue_id=$1 AND status='in_review'`, issue, testUserID)
	if err != nil {
		t.Fatal(err)
	}
	q := db.New(tx)
	p := db.ListDecisionsParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(project), VisibleAgents: []pgtype.UUID{parseUUID(agent)}, State: "pending", PageLimit: 2}
	get := func() decisionsResult {
		t.Helper()
		raw, err := q.ListDecisions(t.Context(), p)
		if err != nil {
			t.Fatal(err)
		}
		var out decisionsResult
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	first := get()
	if first.PendingCount != 4 || len(first.Items) != 2 {
		t.Fatalf("first page: %+v", first)
	}
	last := first.Items[1]
	p.CursorTime = pgtype.Timestamptz{Time: last.SortAt, Valid: true}
	p.CursorKind = last.Kind
	p.CursorID = last.SourceID
	second := get()
	if len(second.Items) != 2 || second.PendingCount != 4 {
		t.Fatalf("second page: %+v", second)
	}
	seen := map[string]bool{}
	for _, item := range append(first.Items, second.Items...) {
		if seen[item.SourceID] {
			t.Fatal("duplicate page item")
		}
		seen[item.SourceID] = true
		if item.Kind == "status" && item.IssueID == issue {
			t.Fatal("structured issue duplicated by fallback")
		}
	}
	p.State = "answered"
	p.CursorTime = pgtype.Timestamptz{}
	p.CursorKind = ""
	p.CursorID = ""
	p.PageLimit = 50
	history := get()
	if len(history.Items) != 2 || history.Items[0].ActorID == nil || *history.Items[0].ActorID != testUserID {
		t.Fatalf("history: %+v", history)
	}
	_, err = tx.Exec(t.Context(), `UPDATE agent_question_card SET withdrawn_at=now() WHERE issue_id=$1 AND status='withdrawn'`, waiting)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(t.Context(), `UPDATE agent_plan SET status='cancelled',cancelled_at=now() WHERE issue_id=$1 AND status='draft'`, waiting)
	if err != nil {
		t.Fatal(err)
	}
	history = get()
	if len(history.Items) != 4 {
		t.Fatalf("withdrawn/cancelled history: %+v", history)
	}
	p.ProjectID = pgtype.UUID{}
	p.State = "pending"
	all := get()
	if all.PendingCount != 5 {
		t.Fatalf("all projects: %+v", all)
	}
	p.VisibleAgents = []pgtype.UUID{}
	restricted := get()
	if restricted.PendingCount != 2 {
		t.Fatalf("permission scope: %+v", restricted)
	}
}

func TestDecisionHandlers(t *testing.T) {
	issue := dbfx.Issue(t, "decision detail")
	agent := dbfx.Agent(t, "decision agent", "")
	card := dbfx.Insert(t, "agent_question_card", testutil.Cols{"workspace_id": testWorkspaceID, "issue_id": issue, "agent_id": agent, "task_id": testutil.Raw("gen_random_uuid()"), "questions": testutil.Raw(`'[{"question":"Pick"}]'::jsonb`)})
	req := withURLParam(newRequest("GET", "/decisions?limit=1", nil), "id", testWorkspaceID)
	var page decisionsResult
	testutil.Call(t, testHandler.ListDecisions, req).Want(200).JSON(&page)
	if len(page.Items) != 1 || page.Items[0].SourceID != card {
		t.Fatalf("page: %+v", page)
	}
	for _, query := range []string{"?state=nope", "?limit=101", "?cursor=bad", "?project_id=wrong"} {
		req = withURLParam(newRequest("GET", "/decisions"+query, nil), "id", testWorkspaceID)
		testutil.Call(t, testHandler.ListDecisions, req).Want(400)
	}
	req = withURLParam(newRequest("GET", "/decisions/question/"+card, nil), "id", testWorkspaceID)
	chi.RouteContext(req.Context()).URLParams.Add("kind", "question")
	chi.RouteContext(req.Context()).URLParams.Add("sourceId", card)
	var detail map[string]any
	testutil.Call(t, testHandler.GetDecisionDetail, req).Want(200).JSON(&detail)
	if detail["id"] != card {
		t.Fatalf("detail: %+v", detail)
	}
	otherUser := dbfx.User(t, "other owner", "m208-other@example.invalid")
	otherAgent := dbfx.Agent(t, "private other", "", testutil.Cols{"owner_id": otherUser})
	otherCard := dbfx.Insert(t, "agent_question_card", testutil.Cols{"workspace_id": testWorkspaceID, "issue_id": issue, "agent_id": otherAgent, "task_id": testutil.Raw("gen_random_uuid()"), "questions": testutil.Raw(`'[]'::jsonb`)})
	req = withURLParam(newRequest("GET", "/decisions", nil), "id", testWorkspaceID)
	testutil.Call(t, testHandler.ListDecisions, req).Want(200).JSON(&page)
	if page.PendingCount != 1 {
		t.Fatalf("private source leaked into count: %+v", page)
	}
	req = withURLParam(newRequest("GET", "/decisions/question/"+otherCard, nil), "id", testWorkspaceID)
	chi.RouteContext(req.Context()).URLParams.Add("kind", "question")
	chi.RouteContext(req.Context()).URLParams.Add("sourceId", otherCard)
	testutil.Call(t, testHandler.GetDecisionDetail, req).Want(404)
	dbfx.Exec(t, `UPDATE agent SET permission_mode='public_to' WHERE id=$1`, otherAgent)
	dbfx.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": otherAgent, "target_type": "member", "target_id": testUserID})
	req = withURLParam(newRequest("GET", "/decisions", nil), "id", testWorkspaceID)
	testutil.Call(t, testHandler.ListDecisions, req).Want(200).JSON(&page)
	if page.PendingCount != 2 {
		t.Fatalf("authorized source missing: %+v", page)
	}
}
