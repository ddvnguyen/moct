package handler

// M-275: DB-backed tests for the plan page's review threads — an anchored
// comment, a reply, a resolve, a stale revision, a human section edit with its
// history, and the verdict that sends the waiting comments to the agent.

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

type planCommentBody struct {
	Comment planCommentResponse `json:"comment"`
}

func TestPlanCommentsThreadsResolveAndDelivery(t *testing.T) {
	f := newAskPlanFixture(t)
	planID, rev := submittedPlan(t, f)
	t.Cleanup(func() {
		dbfx.Exec(t, `DELETE FROM agent_plan_comment WHERE plan_id=$1`, planID)
		dbfx.Exec(t, `DELETE FROM agent_plan_section_version WHERE plan_id=$1`, planID)
	})

	// A comment anchored to the passage the reviewer selected.
	var first planCommentBody
	testutil.Call(t, testHandler.CreatePlanComment,
		withURLParams(newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/comments", map[string]any{
			"base_revision": rev,
			"section_id":    "s1",
			"quote":         "Ship on Thursday",
			"body":          "Be specific about the day.",
		}), "id", testWorkspaceID, "planId", planID),
	).Want(http.StatusCreated).JSON(&first)
	if first.Comment.SectionID != "s1" || first.Comment.Quote != "Ship on Thursday" {
		t.Fatalf("anchored comment: %+v", first.Comment)
	}

	// A second comment with no anchor, and a reply under the first.
	var second planCommentBody
	testutil.Call(t, testHandler.CreatePlanComment,
		withURLParams(newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/comments", map[string]any{
			"base_revision": rev,
			"section_id":    "",
			"quote":         "",
			"body":          "Also add a metrics section.",
		}), "id", testWorkspaceID, "planId", planID),
	).Want(http.StatusCreated).JSON(&second)

	var reply planCommentBody
	testutil.Call(t, testHandler.CreatePlanComment,
		withURLParams(newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/comments", map[string]any{
			"base_revision":     rev,
			"section_id":        "s1",
			"quote":             "Ship on Thursday",
			"body":              "Thursday is fine, name the hour.",
			"parent_comment_id": first.Comment.ID,
		}), "id", testWorkspaceID, "planId", planID),
	).Want(http.StatusCreated).JSON(&reply)
	if reply.Comment.ParentCommentID == nil || *reply.Comment.ParentCommentID != first.Comment.ID {
		t.Fatalf("reply parent: %+v", reply.Comment)
	}

	// A comment fenced on a revision the plan no longer has is refused with
	// the current one, never anchored to text it did not see.
	stale := withURLParams(newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/comments", map[string]any{
		"base_revision": rev + 99,
		"section_id":    "s1",
		"quote":         "Ship on Thursday",
		"body":          "Stale.",
	}), "id", testWorkspaceID, "planId", planID)
	var staleBody map[string]any
	testutil.Call(t, testHandler.CreatePlanComment, stale).Want(http.StatusConflict).JSON(&staleBody)
	if staleBody["error"] != "stale_plan_revision" || staleBody["current_revision"] != float64(rev) {
		t.Fatalf("stale comment body: %+v", staleBody)
	}

	// Resolve the unanchored comment; a second resolve is a business 409.
	testutil.Call(t, testHandler.ResolvePlanComment,
		withURLParams(newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/comments/"+second.Comment.ID+"/resolve", nil),
			"id", testWorkspaceID, "planId", planID, "commentId", second.Comment.ID),
	).Want(http.StatusOK)
	testutil.Call(t, testHandler.ResolvePlanComment,
		withURLParams(newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/comments/"+second.Comment.ID+"/resolve", nil),
			"id", testWorkspaceID, "planId", planID, "commentId", second.Comment.ID),
	).Want(http.StatusConflict)

	// The issue read carries the threads, oldest first.
	var state askPlanStateResponse
	testutil.Call(t, testHandler.GetIssueAskPlan, issueAskPlanRequest(t, f)).Want(http.StatusOK).JSON(&state)
	if state.Plan == nil || len(state.Plan.Comments) != 3 {
		t.Fatalf("ask-plan read comments: %+v", state.Plan)
	}
	if state.Plan.Comments[0].ID != first.Comment.ID {
		t.Fatalf("comment order: %+v", state.Plan.Comments)
	}

	// A human edit bumps the revision and, while the plan is in review, the
	// submitted revision with it (decision 1).
	var edited planResponse
	testutil.Call(t, testHandler.UpdatePlanSection,
		withURLParams(newRequest(http.MethodPut, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/sections/s1", map[string]any{
			"base_revision": rev,
			"heading":       "Goal",
			"markdown":      "Ship on Thursday, z first.",
		}), "id", testWorkspaceID, "planId", planID, "sectionId", "s1"),
	).Want(http.StatusOK).JSON(&edited)
	if edited.Revision != rev+1 {
		t.Fatalf("edit revision = %d, want %d", edited.Revision, rev+1)
	}
	if edited.SubmittedRevision == nil || *edited.SubmittedRevision != rev+1 {
		t.Fatalf("edit submitted_revision = %v, want %d", edited.SubmittedRevision, rev+1)
	}

	// The history holds the agent's write and the human's, newest first, and
	// reading it a second time does not append anything.
	for attempt := 0; attempt < 2; attempt++ {
		var history struct {
			SectionID string                       `json:"section_id"`
			Revision  int32                        `json:"revision"`
			Versions  []planSectionVersionResponse `json:"versions"`
		}
		testutil.Call(t, testHandler.ListPlanSectionHistory,
			withURLParams(newRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/sections/s1/history", nil),
				"id", testWorkspaceID, "planId", planID, "sectionId", "s1"),
		).Want(http.StatusOK).JSON(&history)
		if len(history.Versions) != 2 {
			t.Fatalf("attempt %d history: %+v", attempt, history)
		}
		if history.Versions[0].Revision != rev+1 || history.Versions[0].WriterType != "member" {
			t.Fatalf("newest version: %+v", history.Versions[0])
		}
		if history.Versions[1].Revision != rev || history.Versions[1].WriterType != "agent" {
			t.Fatalf("oldest version: %+v", history.Versions[1])
		}
	}

	// Request changes: no flat note box, only the pending passage comments —
	// which is enough, because a verdict sends them.
	var verdict struct {
		Plan planResponse `json:"plan"`
	}
	testutil.Call(t, testHandler.ReviewPlan,
		withURLParams(newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/plans/"+planID+"/verdict", map[string]any{
			"revision": rev + 1,
			"verdict":  "changes_requested",
			"comments": []string{},
			"note":     "",
		}), "id", testWorkspaceID, "planId", planID),
	).Want(http.StatusOK).JSON(&verdict)

	// Every comment is delivered exactly once, tagged with the verdict.
	if pending := dbfx.Count(t, `SELECT count(*) FROM agent_plan_comment WHERE plan_id=$1 AND delivered_at IS NULL`, planID); pending != 0 {
		t.Fatalf("%d comments still pending after the verdict", pending)
	}
	if tagged := dbfx.Count(t, `SELECT count(*) FROM agent_plan_comment WHERE plan_id=$1 AND delivered_verdict='changes_requested'`, planID); tagged != 3 {
		t.Fatalf("%d comments tagged with the verdict", tagged)
	}

	// The flat review history keeps its contract: the delivered bodies, in
	// order, as a JSON array of strings.
	var recorded string
	dbfx.QueryRow(t, `SELECT comments::text FROM agent_plan_review WHERE plan_id=$1 AND verdict='changes_requested'`, planID).Scan(&recorded)
	var bodies []string
	if err := json.Unmarshal([]byte(recorded), &bodies); err != nil {
		t.Fatalf("review comments are not a string array: %v (%s)", err, recorded)
	}
	want := []string{"Be specific about the day.", "Also add a metrics section.", "Thursday is fine, name the hour."}
	if len(bodies) != len(want) {
		t.Fatalf("review comments = %v, want %v", bodies, want)
	}
	for i, body := range want {
		if bodies[i] != body {
			t.Fatalf("review comments = %v, want %v", bodies, want)
		}
	}

	// The resumed run reads the anchor: the section heading, the quoted
	// passage, the body and its reply.
	var note string
	dbfx.QueryRow(t, `SELECT COALESCE(handoff_note,'') FROM agent_task_queue WHERE issue_id=$1 AND status='queued' AND trigger_evidence_kind='plan_verdict'`, f.issueID).Scan(&note)
	for _, want := range []string{"### Goal", "> Ship on Thursday", "Be specific about the day.", "  - reply: Thursday is fine, name the hour.", "Also add a metrics section."} {
		if !strings.Contains(note, want) {
			t.Fatalf("handoff note missing %q:\n%s", want, note)
		}
	}
}

// issueAskPlanRequest is the island read's request: a member read, no task
// token, issueId in the path.
func issueAskPlanRequest(t *testing.T, f askPlanFixture) *http.Request {
	t.Helper()
	return withURLParams(newRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/issues/"+f.issueID+"/ask-plan", nil),
		"id", testWorkspaceID, "issueId", f.issueID)
}

func TestPlanHistorySeedsAPreMigrationSection(t *testing.T) {
	f := newAskPlanFixture(t)
	var created planResponse
	testutil.Call(t, testHandler.CreatePlan,
		agentAskRequest(t, f, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/tasks/"+f.taskID+"/plans", map[string]any{
			"title": "Legacy plan", "outline": []string{"Goal", "Steps"},
		}),
	).Want(http.StatusCreated).JSON(&created)
	testutil.Call(t, testHandler.WritePlanSection,
		agentPlanRequest(t, f, http.MethodPut, "/api/workspaces/"+testWorkspaceID+"/plans/"+created.ID+"/sections", created.ID, map[string]any{
			"base_revision": created.Revision,
			"section":       map[string]any{"section_id": "s2", "heading": "Steps", "markdown": "Write it down."},
		}),
	).Want(http.StatusOK)
	t.Cleanup(func() {
		dbfx.Exec(t, `DELETE FROM agent_plan_section_version WHERE plan_id=$1`, created.ID)
	})

	// Drop the ledger row the agent's write just added, which is the state a
	// section written before this migration is in. The first read must seed
	// the current text instead of claiming the section has no history.
	dbfx.Exec(t, `DELETE FROM agent_plan_section_version WHERE plan_id=$1 AND section_id='s2'`, created.ID)

	var history struct {
		Versions []planSectionVersionResponse `json:"versions"`
	}
	testutil.Call(t, testHandler.ListPlanSectionHistory,
		withURLParams(newRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/plans/"+created.ID+"/sections/s2/history", nil),
			"id", testWorkspaceID, "planId", created.ID, "sectionId", "s2"),
	).Want(http.StatusOK).JSON(&history)
	if len(history.Versions) != 1 {
		t.Fatalf("seeded history: %+v", history)
	}
	if history.Versions[0].Markdown != "Write it down." || history.Versions[0].WriterType != "agent" {
		t.Fatalf("seeded version: %+v", history.Versions[0])
	}
}
