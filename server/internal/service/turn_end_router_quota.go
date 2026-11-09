package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const quotaLedgerIssueNumber int32 = 86

type turnEndRouterQuotaLedger struct {
	Rows []struct {
		Tier          string   `json:"tier"`
		State         string   `json:"state"`
		CooldownUntil string   `json:"cooldown_until"`
		AgentIDs      []string `json:"agents"`
	} `json:"rows"`
}

type turnEndRouterQuotaSeats struct {
	Lead      []string `json:"lead"`
	Architect []string `json:"architect"`
}

// unwrapIssueMetadataJSON accepts both JSON objects and the JSON-encoded
// strings used by the M-86 operational ledger.
func unwrapIssueMetadataJSON(raw json.RawMessage) []byte {
	var encoded string
	if json.Unmarshal(raw, &encoded) == nil {
		return []byte(encoded)
	}
	return raw
}

func loadTurnEndRouterQuotaConfig(ctx context.Context, q *db.Queries, workspaceID db.Issue) (turnEndRouterQuotaLedger, turnEndRouterQuotaSeats, error) {
	var ledger turnEndRouterQuotaLedger
	var seats turnEndRouterQuotaSeats
	index, err := q.GetIssueByNumber(ctx, db.GetIssueByNumberParams{WorkspaceID: workspaceID.WorkspaceID, Number: quotaLedgerIssueNumber})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ledger, seats, fmt.Errorf("M-86 quota ledger issue is missing")
		}
		return ledger, seats, fmt.Errorf("load M-86 quota ledger issue: %w", err)
	}
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(index.Metadata, &metadata); err != nil {
		return ledger, seats, fmt.Errorf("decode M-86 metadata: %w", err)
	}
	quotaJSON, ok := metadata["quota_ledger"]
	if !ok {
		return ledger, seats, fmt.Errorf("M-86 metadata has no quota_ledger")
	}
	if err := json.Unmarshal(unwrapIssueMetadataJSON(quotaJSON), &ledger); err != nil {
		return ledger, seats, fmt.Errorf("decode M-86 quota_ledger: %w", err)
	}
	if seatsJSON, ok := metadata["quota_seats"]; ok {
		if err := json.Unmarshal(unwrapIssueMetadataJSON(seatsJSON), &seats); err != nil {
			return ledger, seats, fmt.Errorf("decode M-86 quota_seats: %w", err)
		}
	}
	return ledger, seats, nil
}

func quotaRowForAgent(ledger turnEndRouterQuotaLedger, agentID string) (state string, cooldownUntil time.Time, found bool) {
	for _, row := range ledger.Rows {
		for _, id := range row.AgentIDs {
			if id != agentID {
				continue
			}
			until, _ := time.Parse(time.RFC3339Nano, row.CooldownUntil)
			return strings.ToLower(row.State), until, true
		}
	}
	return "unknown", time.Time{}, false
}

func quotaAgentAvailable(ledger turnEndRouterQuotaLedger, agentID string, now time.Time) bool {
	state, until, found := quotaRowForAgent(ledger, agentID)
	if !found {
		// The ledger explicitly treats unobserved accounts as unknown, not
		// cooled. Only confirmed cooldown signals suppress a dispatch.
		return true
	}
	if state == "cooldown" || state == "cooled" {
		return !until.IsZero() && !now.Before(until)
	}
	return until.IsZero() || !now.Before(until)
}

func isAssignedRouterAgentAvailable(ctx context.Context, q *db.Queries, issue db.Issue, agentID pgtype.UUID) (string, error) {
	ledger, _, err := loadTurnEndRouterQuotaConfig(ctx, q, issue)
	if err != nil {
		return "quota_ledger_unavailable", err
	}
	if !quotaAgentAvailable(ledger, util.UUIDToString(agentID), time.Now()) {
		return "quota_cooled", nil
	}
	agent, err := q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: agentID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return "agent_unavailable", nil
	}
	if agent.ArchivedAt.Valid || !agent.RuntimeID.Valid {
		return "agent_unavailable", nil
	}
	active, err := q.CountRunningTasks(ctx, agent.ID)
	if err != nil {
		return "capacity_lookup_failed", err
	}
	if agent.MaxConcurrentTasks > 0 && active >= int64(agent.MaxConcurrentTasks) {
		return "capacity_full", nil
	}
	return "available", nil
}

// selectTurnEndRouterAgent resolves a role from M-86's quota ledger and seat
// lists, then rejects cooled, archived, unbound, or currently saturated agents.
// It intentionally does not estimate remaining quota: M-86 records only
// observed cooldown signals.
func selectTurnEndRouterAgent(ctx context.Context, q *db.Queries, issue db.Issue, destination string) (db.Agent, string, error) {
	ledger, seats, err := loadTurnEndRouterQuotaConfig(ctx, q, issue)
	if err != nil {
		return db.Agent{}, "quota_ledger_unavailable", err
	}
	candidateIDs := make([]string, 0)
	switch destination {
	case "orchestrator":
		for _, row := range ledger.Rows {
			if row.Tier == "tick" {
				candidateIDs = append(candidateIDs, row.AgentIDs...)
			}
		}
	case "leader":
		candidateIDs = append(candidateIDs, seats.Lead...)
	case "architect":
		candidateIDs = append(candidateIDs, seats.Architect...)
	default:
		return db.Agent{}, "invalid_destination", fmt.Errorf("unknown turn-end router destination %q", destination)
	}
	if len(candidateIDs) == 0 {
		return db.Agent{}, "no_role_agent", nil
	}
	now := time.Now()
	seen := make(map[string]struct{}, len(candidateIDs))
	cooled, saturated := 0, 0
	for _, id := range candidateIDs {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		parsed, err := util.ParseUUID(id)
		if err != nil {
			continue
		}
		if !quotaAgentAvailable(ledger, id, now) {
			cooled++
			continue
		}
		agent, err := q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: parsed, WorkspaceID: issue.WorkspaceID})
		if err != nil || agent.ArchivedAt.Valid || !agent.RuntimeID.Valid {
			continue
		}
		active, err := q.CountRunningTasks(ctx, agent.ID)
		if err != nil {
			return db.Agent{}, "capacity_lookup_failed", fmt.Errorf("check router agent capacity: %w", err)
		}
		if agent.MaxConcurrentTasks > 0 && active >= int64(agent.MaxConcurrentTasks) {
			saturated++
			continue
		}
		return agent, "available", nil
	}
	if cooled > 0 && saturated == 0 {
		return db.Agent{}, "quota_cooled", nil
	}
	if saturated > 0 {
		return db.Agent{}, "capacity_full", nil
	}
	return db.Agent{}, "no_available_agent", nil
}
