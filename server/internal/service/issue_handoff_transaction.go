package service

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/attribution"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// PreparedIssueHandoff contains network-dependent data prepared before the
// caller locks the issue. Its target must still be validated in the transaction.
type PreparedIssueHandoff struct {
	agent   db.Agent
	attr    attribution.Result
	overlay runtimeMCPOverlayData
	head    pgtype.Text
}

func (s *TaskService) PrepareIssueHandoff(ctx context.Context, issue db.Issue, agentID, actorID pgtype.UUID) (PreparedIssueHandoff, error) {
	if !actorID.Valid {
		return PreparedIssueHandoff{}, fmt.Errorf("issue handoff requires a member actor")
	}
	agent, err := s.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: agentID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return PreparedIssueHandoff{}, fmt.Errorf("load handoff agent: %w", err)
	}
	if agent.ArchivedAt.Valid || !agent.RuntimeID.Valid {
		return PreparedIssueHandoff{}, fmt.Errorf("handoff agent is archived or has no runtime")
	}
	attr := s.attributionForIssueTask(ctx, issue, pgtype.UUID{}, attribution.SourceCommentSource, actorID)
	attr, err = s.applyAttributionFallback(ctx, attr, agent)
	if err != nil {
		return PreparedIssueHandoff{}, err
	}
	return PreparedIssueHandoff{
		agent: agent, attr: attr,
		overlay: s.buildRuntimeMCPOverlay(ctx, attr.UserID, agent),
		head:    headShaText(s.ResolveIssueReviewSHA(ctx, issue.ID)),
	}, nil
}

// EnqueuePreparedIssueHandoffInTx inserts the durable task without publishing
// events. The caller validates workflow, membership, invocation access and any
// squad leader relationship in the same transaction before calling it.
func (s *TaskService) EnqueuePreparedIssueHandoffInTx(ctx context.Context, q *db.Queries, issue db.Issue, squadID pgtype.UUID, prepared PreparedIssueHandoff) (db.AgentTaskQueue, error) {
	if err := guardIssueNotInTriage(ctx, q, issue.ID, OriginDerived); err != nil {
		return db.AgentTaskQueue{}, err
	}
	agent, err := q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: prepared.agent.ID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return db.AgentTaskQueue{}, fmt.Errorf("revalidate handoff agent: %w", err)
	}
	if agent.ArchivedAt.Valid || !agent.RuntimeID.Valid || agent.RuntimeID != prepared.agent.RuntimeID {
		return db.AgentTaskQueue{}, fmt.Errorf("handoff agent changed during preparation")
	}
	source, delegated, kind, ref := attributionCreateParams(prepared.attr)
	task, err := q.CreateAgentTask(ctx, db.CreateAgentTaskParams{
		ID: dbid.NewV7(), AgentID: agent.ID, RuntimeID: agent.RuntimeID, IssueID: issue.ID,
		Priority: priorityToInt(issue.Priority), IsLeaderTask: pgtype.Bool{Bool: squadID.Valid, Valid: squadID.Valid},
		SquadID: squadID, OriginatorUserID: prepared.attr.UserID, AccountableUserID: prepared.attr.AccountableUserID,
		RuleVersionID: prepared.attr.RuleVersionID, RuntimeMcpOverlay: prepared.overlay.Overlay,
		RuntimeConnectedApps: prepared.overlay.ConnectedApps, OriginatorSource: source,
		DelegatedFromTaskID: delegated, TriggerEvidenceKind: kind, TriggerEvidenceRefID: ref,
		HeadSha: prepared.head, FreshRerun: pgtype.Bool{Bool: false, Valid: true},
	})
	if err != nil {
		if isDuplicatePendingTaskErr(err) {
			return db.AgentTaskQueue{}, ErrDuplicatePendingTask
		}
		return db.AgentTaskQueue{}, fmt.Errorf("create handoff task: %w", err)
	}
	return task, nil
}

// HandoffAgent exposes the prepared agent for caller-side transaction
// revalidation without leaking the field's mutability.
func (p PreparedIssueHandoff) HandoffAgent() db.Agent { return p.agent }

// FinalizeIssueHandoff publishes only after the caller has committed.
func (s *TaskService) FinalizeIssueHandoff(ctx context.Context, task db.AgentTaskQueue, prepared PreparedIssueHandoff) {
	s.RecordHumanDelegation(ctx, prepared.attr)
	s.broadcastTaskEvent(ctx, protocol.EventTaskQueued, task)
	s.NotifyTaskEnqueued(ctx, task)
}
