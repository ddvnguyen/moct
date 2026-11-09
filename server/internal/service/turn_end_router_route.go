package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type turnEndRouterContext struct {
	TurnEndRouter struct {
		Origin               string `json:"origin"`
		Reason               string `json:"reason"`
		Destination          string `json:"destination"`
		StateHash            string `json:"state_hash"`
		BaselineStatus       string `json:"baseline_status"`
		BaselineCommentCount int64  `json:"baseline_comment_count"`
		BaselineHeadSHA      string `json:"baseline_head_sha"`
	} `json:"turn_end_router"`
}

func turnEndRouterTaskRouting(task db.AgentTaskQueue) (reason, destination string) {
	var taskContext turnEndRouterContext
	if json.Unmarshal(task.Context, &taskContext) == nil && taskContext.TurnEndRouter.Origin == "derived" {
		return taskContext.TurnEndRouter.Reason, taskContext.TurnEndRouter.Destination
	}
	return "", ""
}

func turnEndRouterStateHash(issue db.Issue, commentCount int64, headSHA string, pending bool) string {
	state, _ := json.Marshal(struct {
		Status     string `json:"status"`
		AssigneeID string `json:"assignee_id"`
		Comments   int64  `json:"comments"`
		HeadSHA    string `json:"head_sha"`
		Pending    bool   `json:"pending"`
	}{issue.Status, util.UUIDToString(issue.AssigneeID), commentCount, headSHA, pending})
	digest := sha256.Sum256(state)
	return hex.EncodeToString(digest[:])
}

func (s *TaskService) recordShadowDecision(ctx context.Context, q *db.Queries, issue db.Issue, reason, destination string) error {
	details, _ := json.Marshal(map[string]any{
		"reason":      reason,
		"destination": destination,
		"would_queue": true,
	})
	_, err := q.CreateActivity(ctx, db.CreateActivityParams{
		WorkspaceID: issue.WorkspaceID,
		IssueID:     issue.ID,
		ActorType:   pgtype.Text{String: "system", Valid: true},
		Action:      "turn_end_router_shadow",
		Details:     details,
	})
	if err != nil {
		return fmt.Errorf("persist shadow decision: %w", err)
	}
	return nil
}

func (s *TaskService) routeOrchestratorInTx(ctx context.Context, q *db.Queries, issue db.Issue, source db.AgentTaskQueue, step, reason string) (string, string, error) {
	return s.routeAgentInTx(ctx, q, issue, source, step, reason, "orchestrator")
}

func (s *TaskService) routeLeaderInTx(ctx context.Context, q *db.Queries, issue db.Issue, source db.AgentTaskQueue, step, reason string) (string, string, error) {
	return s.routeAgentInTx(ctx, q, issue, source, step, reason, "leader")
}

func (s *TaskService) routeArchitectInTx(ctx context.Context, q *db.Queries, issue db.Issue, source db.AgentTaskQueue, step, reason string) (string, string, error) {
	return s.routeAgentInTx(ctx, q, issue, source, step, reason, "architect")
}

func (s *TaskService) maybeRouteGreenPRInTx(ctx context.Context, q *db.Queries, issue db.Issue, source db.AgentTaskQueue, step string) (bool, string, string, error) {
	prs, err := q.ListPullRequestsByIssue(ctx, issue.ID)
	if err != nil {
		return false, "", "", fmt.Errorf("load linked PR checks: %w", err)
	}
	var greenHead string
	for _, pr := range prs {
		if (pr.State != "open" && pr.State != "draft") || pr.HeadSha == "" || pr.HeadSha != pr.SnapshotHeadSha {
			continue
		}
		rollup := strings.ToUpper(pr.ChecksRollupState.String)
		if rollup == "SUCCESS" && pr.ChecksTotal > 0 && pr.ChecksPassed == pr.ChecksTotal && pr.ChecksFailed == 0 && pr.ChecksRunning == 0 {
			greenHead = pr.HeadSha
			break
		}
	}
	if greenHead == "" {
		return false, "", "", nil
	}
	seen, err := q.HasTurnEndRouterReviewForHead(ctx, db.HasTurnEndRouterReviewForHeadParams{IssueID: issue.ID, HeadSha: greenHead})
	if err != nil {
		return false, "", "", fmt.Errorf("check PR review head dedupe: %w", err)
	}
	if seen {
		return false, "", "", nil
	}
	workspace, err := q.GetWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return false, "", "", fmt.Errorf("load router mode for PR review: %w", err)
	}
	mode := turnEndRouterModeFromSettings(workspace.Settings)
	if mode == "off" {
		return true, "suppressed:mode_off", "", nil
	}
	if mode == "shadow" {
		if err := s.recordShadowDecision(ctx, q, issue, "green_pr_no_verdict", "architect"); err != nil {
			return true, "", "", err
		}
		return true, "shadow:would_queue", "", nil
	}
	installs, err := q.ListGitHubInstallationsByWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return true, "", "", fmt.Errorf("check GitHub App connection: %w", err)
	}
	if len(installs) == 0 {
		outcome, id, err := s.createPRReviewWakeupInTx(ctx, q, issue, source, step)
		return true, outcome, id, err
	}
	outcome, id, err := s.routeArchitectInTx(ctx, q, issue, source, step, "green_pr_no_verdict")
	return true, outcome, id, err
}

func (s *TaskService) createPRReviewWakeupInTx(ctx context.Context, q *db.Queries, issue db.Issue, source db.AgentTaskQueue, step string) (string, string, error) {
	target, availability, err := selectTurnEndRouterAgent(ctx, q, issue, "architect")
	if err != nil {
		slog.Warn("turn-end-router: PR review fallback unavailable", "issue_id", util.UUIDToString(issue.ID), "reason", availability, "error", err)
		return "suppressed:" + availability, "", nil
	}
	if !target.ID.Valid {
		return "suppressed:" + availability, "", nil
	}
	exists, err := q.HasTurnEndRouterPRWakeup(ctx, db.HasTurnEndRouterPRWakeupParams{IssueID: issue.ID, AgentID: target.ID})
	if err != nil {
		return "", "", fmt.Errorf("check existing PR review wakeup: %w", err)
	}
	if exists {
		return "wakeup:pr_checks_already_armed", "", nil
	}
	createdBy := source.OriginatorUserID
	if !createdBy.Valid && issue.CreatorType == "member" {
		createdBy = issue.CreatorID
	}
	if !createdBy.Valid {
		createdBy = target.OwnerID
	}
	if !createdBy.Valid {
		return "suppressed:wakeup_creator_missing", "", nil
	}
	condition := []byte(`{"type":"pull_request","event":"checks_finished"}`)
	wakeup, err := q.CreateIssueWakeup(ctx, db.CreateIssueWakeupParams{
		ID: dbid.NewV7(), WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, AgentID: target.ID,
		CreatedBy: createdBy, SourceTaskID: source.ID,
		Instruction: routerHandoffNote("architect", "PR-link wakeup fallback", issue, step),
		Kind:        "event", Mode: "once", EventTypes: []string{}, Timezone: "UTC",
		NextFireAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
		ExpiresAt:  pgtype.Timestamptz{Time: time.Now().Add(7 * 24 * time.Hour), Valid: true},
		Condition:  condition, MaxFires: pgtype.Int4{Int32: 1, Valid: true},
	})
	if err != nil {
		return "", "", fmt.Errorf("create PR-link review wakeup: %w", err)
	}
	details, _ := json.Marshal(map[string]any{"wakeup_id": util.UUIDToString(wakeup.ID), "destination": "architect", "step": step})
	if _, err := q.CreateActivity(ctx, db.CreateActivityParams{
		WorkspaceID: issue.WorkspaceID, IssueID: issue.ID,
		ActorType: pgtype.Text{String: "system", Valid: true}, Action: "turn_end_router_pr_wakeup", Details: details,
	}); err != nil {
		return "", "", fmt.Errorf("record PR review wakeup: %w", err)
	}
	return "wakeup:pr_checks", util.UUIDToString(wakeup.ID), nil
}

func (s *TaskService) routeAgentInTx(ctx context.Context, q *db.Queries, issue db.Issue, source db.AgentTaskQueue, step, reason, destination string) (string, string, error) {
	workspace, err := q.GetWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return "", "", fmt.Errorf("load router mode: %w", err)
	}
	mode := turnEndRouterModeFromSettings(workspace.Settings)
	if mode == "off" {
		return "suppressed:mode_off", "", nil
	}
	target, availability, err := selectTurnEndRouterAgent(ctx, q, issue, destination)
	if err != nil {
		slog.Warn("turn-end-router: role selection unavailable", "issue_id", util.UUIDToString(issue.ID), "destination", destination, "reason", availability, "error", err)
		return "suppressed:" + availability, "", nil
	}
	if !target.ID.Valid {
		return "suppressed:" + availability, "", nil
	}
	if recent, err := q.CountRecentTurnEndRouterRuns(ctx, db.CountRecentTurnEndRouterRunsParams{IssueID: issue.ID, SourceTaskID: source.ID}); err != nil {
		return "", "", fmt.Errorf("recent derived-run guard: %w", err)
	} else if recent > 0 {
		return "suppressed:dedupe_2m", "", nil
	}
	counts, err := q.CountTurnEndRouterRunsSince(ctx, issue.ID)
	if err != nil {
		return "", "", fmt.Errorf("daily derived-run cap: %w", err)
	}
	if counts.RunCount >= maxDerivedRunsPerIssue24h {
		return "suppressed:daily_cap", "", nil
	}
	commentCount, err := q.CountComments(ctx, db.CountCommentsParams{IssueID: issue.ID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return "", "", fmt.Errorf("capture router comment baseline: %w", err)
	}
	headSHA, ok := issueReviewHeadSHA(ctx, q, issue.ID)
	if !ok {
		return "", "", fmt.Errorf("capture router PR baseline")
	}
	stateHash := turnEndRouterStateHash(issue, commentCount, headSHA, false)
	seen, err := q.HasTurnEndRouterStateHash(ctx, db.HasTurnEndRouterStateHashParams{IssueID: issue.ID, StateHash: stateHash, Destination: destination})
	if err != nil {
		return "", "", fmt.Errorf("state hash dedupe: %w", err)
	}
	if seen {
		return "suppressed:duplicate_state", "", nil
	}
	if mode == "shadow" {
		if err := s.recordShadowDecision(ctx, q, issue, reason, destination); err != nil {
			return "", "", err
		}
		slog.Info("turn-end-router: would queue role", "issue_id", util.UUIDToString(issue.ID), "reason", reason, "destination", destination)
		return "shadow:would_queue", "", nil
	}
	note := routerHandoffNote(destination, reason, issue, step)
	txService := &TaskService{Queries: q, Bus: s.Bus, Metrics: s.Metrics, FeatureFlags: s.FeatureFlags}
	isLeader := destination == "leader"
	task, err := txService.enqueueMentionTask(ctx, issue, target.ID, pgtype.UUID{}, isLeader, pgtype.UUID{}, false, note, pgtype.UUID{}, source.ID, OriginDerived)
	if err != nil {
		return "", "", fmt.Errorf("enqueue %s run: %w", destination, err)
	}
	if err := q.SetTaskWorkflowStep(ctx, db.SetTaskWorkflowStepParams{ID: task.ID, WorkflowStep: pgtype.Text{String: step, Valid: step != ""}}); err != nil {
		return "", "", fmt.Errorf("stamp router workflow step: %w", err)
	}
	if err := q.SetTaskTurnEndRouterContext(ctx, db.SetTaskTurnEndRouterContextParams{
		ID: task.ID, Reason: reason, Destination: destination, StateHash: stateHash,
		BaselineStatus: issue.Status, BaselineCommentCount: commentCount, BaselineHeadSha: headSHA,
	}); err != nil {
		return "", "", fmt.Errorf("stamp router context: %w", err)
	}
	return "queued:" + destination, util.UUIDToString(task.ID), nil
}

func routerHandoffNote(destination, reason string, issue db.Issue, step string) string {
	switch destination {
	case "orchestrator":
		return fmt.Sprintf("Turn-end router: handle issue %d after %s. Resume or reroute it by current quota and capacity; preserve status unless workflow work requires a move.", issue.Number, reason)
	case "leader":
		return fmt.Sprintf("Turn-end router: issue %d remains unresolved after the Orchestrator run at step %q. Make one final routing decision; if no progress is possible, leave a concise audit comment and stop.", issue.Number, step)
	case "architect":
		return fmt.Sprintf("Turn-end router: review the linked pull request for issue %d at its current head. Reason: %s. Check the head SHA and verdict before reviewing.", issue.Number, reason)
	default:
		return "Turn-end router follow-up: inspect the issue's current state and take the next valid action."
	}
}

func (s *TaskService) recordTurnEndRouterAudit(ctx context.Context, q *db.Queries, issue db.Issue, step string, task db.AgentTaskQueue) error {
	content := fmt.Sprintf("Turn-end router stopped after the Orchestrator and Leader made no observable progress at step %q (task %s). Further automatic runs were suppressed.", step, util.UUIDToString(task.ID))
	if _, err := q.CreateComment(ctx, db.CreateCommentParams{
		IssueID: issue.ID, WorkspaceID: issue.WorkspaceID, AuthorType: "system", AuthorID: pgtype.UUID{Valid: true}, Content: content, Type: "system",
	}); err != nil {
		return fmt.Errorf("create router exhaustion audit comment: %w", err)
	}
	details, _ := json.Marshal(map[string]any{"task_id": util.UUIDToString(task.ID), "step": step})
	if _, err := q.CreateActivity(ctx, db.CreateActivityParams{
		WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, ActorType: pgtype.Text{String: "system", Valid: true}, Action: "turn_end_router_exhausted", Details: details,
	}); err != nil {
		return fmt.Errorf("record router exhaustion audit: %w", err)
	}
	return nil
}
