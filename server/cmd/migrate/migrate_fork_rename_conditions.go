package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Gates for the migrations the multica-x fork renumbered in its v0.7.1 sync.
//
// The sync (#52 "Stack: upstream v0.7.1 + freebuff runtime + accounts") moved
// migrations the fork had already shipped to lane databases under other
// numbers onto new version rows — SQL the same now ships as
// 618_agent_question_card … 624_task_supplement_mode where those databases
// recorded running it as their old numbers. Such a database has the objects
// but carries no schema_migrations row for the new versions, so `migrate up`
// re-runs non-idempotent CREATEs and aborts the whole run (M-166/M-167:
// 618_agent_question_card dies with `relation "agent_question_card" already
// exists`).
//
// Each condition here returns apply=false with a reason — the runner records
// the version without executing the SQL — only when EVERY object its
// migration creates already exists, by name (table, columns, indexes and
// constraints, not just the table; a table missing its migration-owned index
// must re-run and will). A fresh database that has none of the objects
// applies the SQL normally. All queries are read-only and run on the same
// pinned connection the SQL itself would use, so unqualified names resolve
// exactly where the migration would have created them.
//
// 621_agent_task_queue_blocked is a DROP + ADD CONSTRAINT pair that passes
// either way on an already-applied database, so it is deliberately not gated.

// renamerObject is one object a renumbered migration created, checked by kind
// and unqualified name. "column" and "constraint" name their containing table.
type renamerObject struct {
	kind  string // "table", "index", "column", "constraint"
	name  string
	table string
}

func (o renamerObject) describe() string {
	switch o.kind {
	case "column":
		return fmt.Sprintf("column %s.%s", o.table, o.name)
	case "constraint":
		return fmt.Sprintf("constraint %s on %s", o.name, o.table)
	default:
		return fmt.Sprintf("%s %s", o.kind, o.name)
	}
}

// renamerProbe runs the read-only existence check for one object kind. Names
// are unqualified: the queries resolve against current_schema(), which the
// runner has already pinned to the schema the SQL would create objects in.
func renamerProbe(ctx context.Context, conn *pgxpool.Conn, o renamerObject) (bool, error) {
	var exists bool
	switch o.kind {
	case "table":
		if err := conn.QueryRow(ctx,
			`SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL`,
			o.name,
		).Scan(&exists); err != nil {
			return false, err
		}
	case "column":
		if err := conn.QueryRow(ctx,
			`SELECT EXISTS (
				SELECT 1
				FROM information_schema.columns
				WHERE table_name = $1
				  AND column_name = $2
				  AND table_schema = current_schema()
			)`,
			o.table, o.name,
		).Scan(&exists); err != nil {
			return false, err
		}
	case "index":
		if err := conn.QueryRow(ctx,
			`SELECT EXISTS (
				SELECT 1
				FROM pg_indexes
				WHERE indexname = $1
				  AND schemaname = current_schema()
			)`,
			o.name,
		).Scan(&exists); err != nil {
			return false, err
		}
	case "constraint":
		if err := conn.QueryRow(ctx,
			`SELECT EXISTS (
				SELECT 1
				FROM pg_constraint
				WHERE conname = $1
				  AND conrelid = to_regclass(current_schema() || '.' || $2)
			)`,
			o.name, o.table,
		).Scan(&exists); err != nil {
			return false, err
		}
	default:
		return false, fmt.Errorf("unknown existence check kind %q", o.kind)
	}
	return exists, nil
}

// whenRenamedObjectsAllPresent builds the migrationCondition for a renumbered
// migration: skip (record without running) when every object exists, run
// otherwise.
func whenRenamedObjectsAllPresent(objects []renamerObject) migrationCondition {
	return func(ctx context.Context, conn *pgxpool.Conn) (bool, string, error) {
		var missing []string
		for _, o := range objects {
			exists, err := renamerProbe(ctx, conn, o)
			if err != nil {
				return false, "", fmt.Errorf("check %s exists: %w", o.describe(), err)
			}
			if !exists {
				missing = append(missing, o.describe())
			}
		}
		if len(missing) == 0 {
			return false, "objects of the migration already exist from its pre-renumber run; recording the version without re-running the SQL (M-167)", nil
		}
		return true, fmt.Sprintf("applying: not all migration objects exist, missing %s", strings.Join(missing, ", ")), nil
	}
}

// renamerObjectsListing groups each renumbered migration's created objects, in
// the order its SQL creates them, for the conditions map below and its tests.

var objects618AgentQuestionCard = []renamerObject{
	{kind: "table", name: "agent_question_card"},
	{kind: "index", name: "idx_aqc_issue"},
	{kind: "index", name: "idx_aqc_open"},
	{kind: "index", name: "idx_aqc_task"},
}

var objects619AgentPlan = []renamerObject{
	{kind: "table", name: "agent_plan"},
	{kind: "index", name: "idx_ap_issue"},
	{kind: "index", name: "idx_ap_task"},
}

var objects620AgentPlanReview = []renamerObject{
	{kind: "table", name: "agent_plan_review"},
	{kind: "index", name: "idx_apr_plan"},
}

var objects622ProjectSettings = []renamerObject{
	{kind: "column", name: "settings", table: "project"},
}

var objects623WorkspaceAccount = []renamerObject{
	{kind: "table", name: "workspace_account"},
	{kind: "index", name: "idx_workspace_account_workspace"},
	{kind: "column", name: "account_mode", table: "agent"},
	{kind: "column", name: "account_id", table: "agent"},
	{kind: "constraint", name: "agent_account_mode_consistent", table: "agent"},
	{kind: "column", name: "account_id", table: "agent_task_queue"},
}

var objects624TaskSupplementMode = []renamerObject{
	{kind: "column", name: "mode", table: "task_supplement"},
	{kind: "constraint", name: "task_supplement_mode_check", table: "task_supplement"},
}
