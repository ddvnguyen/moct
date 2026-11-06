package main

import (
	"context"
	"testing"
	"time"
)

// TestRenamedMigrationConditions covers each fork-rename gate (M-167) in the
// two states that matter:
//
//   - objects absent → the migration applies (a fresh database must run its
//     SQL), and the condition carries no skip reason;
//   - every object present → the migration records as applied without
//     running, with the documented skip reason.
//
// Each case builds ITS migration's own objects with that migration's DDL
// shape, so the gates must recognize the same objects the SQL creates, not
// stand-ins.
var renamerConditionCases = map[string][]string{
	"618_agent_question_card": {
		`CREATE TABLE agent_question_card (
			id UUID PRIMARY KEY,
			status TEXT NOT NULL DEFAULT 'open',
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX idx_aqc_issue ON agent_question_card (created_at DESC)`,
		`CREATE INDEX idx_aqc_open ON agent_question_card (created_at) WHERE status = 'open'`,
		`CREATE INDEX idx_aqc_task ON agent_question_card (created_at) WHERE status = 'open'`,
	},
	"619_agent_plan": {
		`CREATE TABLE agent_plan (
			id UUID PRIMARY KEY,
			status TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX idx_ap_issue ON agent_plan (created_at DESC)`,
		`CREATE INDEX idx_ap_task ON agent_plan (created_at) WHERE status <> 'open'`,
	},
	"620_agent_plan_review": {
		`CREATE TABLE agent_plan_review (
			id UUID PRIMARY KEY,
			plan_id UUID NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX idx_apr_plan ON agent_plan_review (plan_id, created_at DESC)`,
	},
	// project.settings and the account columns ride inside their table fixtures.
	"622_project_settings": {
		`CREATE TABLE project (
			id UUID PRIMARY KEY,
			settings JSONB NOT NULL DEFAULT '{}'
		)`,
	},
	"623_workspace_account": {
		`CREATE TABLE workspace_account (
			id UUID PRIMARY KEY,
			workspace_id UUID NOT NULL
		)`,
		`CREATE INDEX idx_workspace_account_workspace ON workspace_account (workspace_id)`,
		`CREATE TABLE agent (
			id UUID PRIMARY KEY,
			account_mode TEXT NOT NULL DEFAULT 'default',
			account_id UUID
		)`,
		`ALTER TABLE agent ADD CONSTRAINT agent_account_mode_consistent
			CHECK ((account_mode = 'specific') = (account_id IS NOT NULL))`,
		`CREATE TABLE agent_task_queue (
			id UUID PRIMARY KEY,
			account_id UUID
		)`,
	},
	"624_task_supplement_mode": {
		`CREATE TABLE task_supplement (
			id UUID PRIMARY KEY,
			mode TEXT NOT NULL DEFAULT 'steer'
		)`,
		`ALTER TABLE task_supplement
			ADD CONSTRAINT task_supplement_mode_check CHECK (mode IN ('steer', 'queue'))`,
	},
}

func TestRenamedMigrationConditions(t *testing.T) {
	t.Parallel()
	adminPool := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	for version, setup := range renamerConditionCases {
		t.Run(version, func(t *testing.T) {
			schema := createScratchSchema(t, ctx, adminPool, "migrate_fork_rename_")
			pool := openTestPoolWithSearchPath(t, schema+", public")
			condition := upMigrationConditions[version]
			if condition == nil {
				t.Fatalf("no up condition registered for %q", version)
			}
			conn, err := pool.Acquire(ctx)
			if err != nil {
				t.Fatalf("acquire connection: %v", err)
			}

			// Objects absent — a fresh database applies the SQL.
			apply, reason, err := condition(ctx, conn)
			if err != nil {
				t.Fatalf("fresh database: %v", err)
			}
			if !apply {
				t.Fatalf("fresh database: condition skipped the migration (%q)", reason)
			}

			// Objects present — record without re-running.
			for _, statement := range setup {
				if _, err := conn.Exec(ctx, statement); err != nil {
					t.Fatalf("apply fixture statement: %v", err)
				}
			}
			apply, reason, err = condition(ctx, conn)
			if err != nil {
				t.Fatalf("applied database: %v", err)
			}
			if apply || reason == "" {
				t.Fatalf("applied database: condition = (%v, %q), want documented skip", apply, reason)
			}
			conn.Release()
		})
	}
}

// TestRenamedMigrationConditionOpensWithoutItsIndex pins the gate on 596: the
// table alone is not enough — the migration's index must exist before the
// version records as applied, a table-only database re-runs the SQL to
// backfill what is missing.
func TestRenamedMigrationConditionOpensWithoutItsIndex(t *testing.T) {
	t.Parallel()
	adminPool := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	schema := createScratchSchema(t, ctx, adminPool, "migrate_fork_rename_partial_")
	pool := openTestPoolWithSearchPath(t, schema+", public")
	condition := upMigrationConditions["618_agent_question_card"]
	if condition == nil {
		t.Fatalf("no up condition registered for 618")
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, renamerConditionCases["618_agent_question_card"][0]); err != nil {
		t.Fatalf("create table: %v", err)
	}
	apply, reason, err := condition(ctx, conn)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if !apply {
		t.Fatalf("table without its index gated the migration away (%q)", reason)
	}
}
