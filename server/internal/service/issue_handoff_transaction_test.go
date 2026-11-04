package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestPreparedIssueHandoffTransaction(t *testing.T) {
	ctx := context.Background()
	fx, agentID, _ := newArchiveCancelFixture(t)
	issueID := fx.Issue(t, "handoff transaction")
	q := db.New(fx.Pool)
	issue, err := q.GetIssue(ctx, util.MustParseUUID(issueID))
	if err != nil {
		t.Fatal(err)
	}
	bus := events.New()
	seen := 0
	bus.Subscribe(protocol.EventTaskQueued, func(events.Event) { seen++ })
	svc := NewTaskService(q, fx.Pool, nil, bus)
	prepared, err := svc.PrepareIssueHandoff(ctx, issue, util.MustParseUUID(agentID), util.MustParseUUID(fx.UserID))
	if err != nil {
		t.Fatal(err)
	}
	for _, commit := range []bool{false, true} {
		tx, err := fx.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		task, err := svc.EnqueuePreparedIssueHandoffInTx(ctx, q.WithTx(tx), issue, pgtype.UUID{}, prepared)
		if err != nil {
			t.Fatal(err)
		}
		if seen != 0 {
			t.Fatal("event published before commit")
		}
		if commit {
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _, _ = fx.Pool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id=$1`, task.ID) })
			svc.FinalizeIssueHandoff(ctx, task, prepared)
			if seen != 1 {
				t.Fatalf("events after finalize = %d", seen)
			}
		} else {
			if err := tx.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			var count int
			if err := fx.Pool.QueryRow(ctx, `SELECT count(*) FROM agent_task_queue WHERE id=$1`, task.ID).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatal("rolled-back task remained")
			}
		}
	}
	tx, err := fx.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.EnqueuePreparedIssueHandoffInTx(ctx, q.WithTx(tx), issue, pgtype.UUID{}, prepared)
	if !errors.Is(err, ErrDuplicatePendingTask) {
		t.Fatalf("duplicate pending task error = %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if seen != 1 {
		t.Fatalf("duplicate published an event: %d", seen)
	}
}

func TestPreparedSquadHandoffRecordsLeaderAndActor(t *testing.T) {
	ctx := context.Background()
	fx, agentID, _ := newArchiveCancelFixture(t)
	issueID := fx.Issue(t, "squad handoff transaction")
	squadID := fx.Squad(t, "handoff squad", agentID)
	q := db.New(fx.Pool)
	issue, err := q.GetIssue(ctx, util.MustParseUUID(issueID))
	if err != nil {
		t.Fatal(err)
	}
	svc := NewTaskService(q, fx.Pool, nil, events.New())
	prepared, err := svc.PrepareIssueHandoff(ctx, issue, util.MustParseUUID(agentID), util.MustParseUUID(fx.UserID))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := fx.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	task, err := svc.EnqueuePreparedIssueHandoffInTx(ctx, q.WithTx(tx), issue, util.MustParseUUID(squadID), prepared)
	if err != nil {
		t.Fatal(err)
	}
	if !task.IsLeaderTask || task.SquadID != util.MustParseUUID(squadID) || task.OriginatorUserID != util.MustParseUUID(fx.UserID) || task.AccountableUserID != util.MustParseUUID(fx.UserID) {
		t.Fatalf("incorrect leader/actor attribution: %+v", task)
	}
}
