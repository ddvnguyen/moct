package handler

import (
	"context"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// S1-A1/M-177: answering an ask/plan park resumes the parked run in its own
// session. Server side that means the claim names the parked row's session AND
// flags it pinned, because a blocked row is not terminal: it has no
// completed_at, so the dsh session-start decision would otherwise see a session
// with no end time and start fresh — the answer landing in a new conversation.
//
// The parked row's session survives the interrupt through the mid-flight pin
// plus SetBlockedTaskSession's COALESCE (both #166); these tests pin what the
// claim then promises about it.
func TestClaimTask_ParkedRerunPinsPriorSession(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	agentID, runtimeID, daemonID := createRuntimeGuardAgent(t, ctx)
	issueID := dbfx.Issue(t, "parked ask resume fixture", testutil.Cols{
		"status": "in_progress",
	})

	const parkedSession = "sess-parked-ask"
	var parkedID string
	dbfx.QueryRow(t, `
		INSERT INTO agent_task_queue (
			agent_id, runtime_id, issue_id, status, priority,
			started_at, session_id, wait_reason
		)
		VALUES ($1, $2, $3, 'blocked', 0, now(), $4, 'awaiting human answer')
		RETURNING id
	`, agentID, runtimeID, issueID, parkedSession).Scan(&parkedID)
	dbfx.Exec(t, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, rerun_of_task_id)
		VALUES ($1, $2, $3, 'queued', 0, $4)
	`, agentID, runtimeID, issueID, parkedID)

	task := claimTaskForRuntimeGuard(t, runtimeID, daemonID)
	if task.PriorSessionID != parkedSession {
		t.Fatalf("PriorSessionID = %q, want the parked session %q", task.PriorSessionID, parkedSession)
	}
	if !task.PriorSessionPinned {
		t.Fatal("answer run is not flagged pinned: the dsh decision sees no end time on a parked row and would start fresh")
	}
}

// TestClaimTask_CompletedRerunIsNotPinned is the guard the pin must not weaken:
// an ordinary rerun of a finished run keeps the warmth rules — its session has
// a real end time, and the B2 decision judges it on that.
func TestClaimTask_CompletedRerunIsNotPinned(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	agentID, runtimeID, daemonID := createRuntimeGuardAgent(t, ctx)
	issueID := dbfx.Issue(t, "completed rerun fixture", testutil.Cols{
		"status": "in_progress",
	})

	var sourceID string
	dbfx.QueryRow(t, `
		INSERT INTO agent_task_queue (
			agent_id, runtime_id, issue_id, status, priority,
			started_at, completed_at, session_id
		)
		VALUES ($1, $2, $3, 'completed', 0, now() - interval '1 hour', now() - interval '50 minutes', 'sess-finished')
		RETURNING id
	`, agentID, runtimeID, issueID).Scan(&sourceID)
	dbfx.Exec(t, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, rerun_of_task_id)
		VALUES ($1, $2, $3, 'queued', 0, $4)
	`, agentID, runtimeID, issueID, sourceID)

	task := claimTaskForRuntimeGuard(t, runtimeID, daemonID)
	if task.PriorSessionID != "sess-finished" {
		t.Fatalf("PriorSessionID = %q, want sess-finished", task.PriorSessionID)
	}
	if task.PriorSessionPinned {
		t.Fatal("a completed source was flagged pinned; only a parked (blocked) source continues by human intent")
	}
}
