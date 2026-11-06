package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// forkMigrationRenames is the fork's migration renumbering made durable: the
// v0.8.1 sync moved upstream onto 595–616, so the fork's own 595–614 moved to
// 617–636 with their order and SQL content untouched.
//
// A lane database that ran the old numbers already has the objects and, under
// the old stems, the schema_migrations rows. Leaving those rows alone would
// make every renumbered version look unapplied and re-run its SQL — and several
// of these migrations are CREATE without IF NOT EXISTS (618_agent_question_card
// dies on `relation "agent_question_card" already exists`), which aborts the
// whole run before the server starts. So the rows are renamed in place before
// the apply loop looks at anything. A fresh database has none of the old stems,
// so the rename is a no-op there and every migration applies normally.
//
// Keeping this as data rather than 20 hand-written statements lets
// TestForkMigrationRenamesMatchFiles check each pair against the files on disk:
// a typo in a stem here would otherwise be invisible, because a rename that
// matches no row is a silent no-op.
var forkMigrationRenames = [][2]string{
	{"595_runtime_profile_add_freebuff", "617_runtime_profile_add_freebuff"},
	{"596_agent_question_card", "618_agent_question_card"},
	{"597_agent_plan", "619_agent_plan"},
	{"598_agent_plan_review", "620_agent_plan_review"},
	{"599_agent_task_queue_blocked", "621_agent_task_queue_blocked"},
	{"600_project_settings", "622_project_settings"},
	{"601_workspace_account", "623_workspace_account"},
	{"602_task_supplement_mode", "624_task_supplement_mode"},
	{"603_workspace_account_managed", "625_workspace_account_managed"},
	{"604_workspace_account_runtime_index", "626_workspace_account_runtime_index"},
	{"605_workspace_account_daemon_id_index", "627_workspace_account_daemon_id_index"},
	{"606_decision_delivered_supplement_index", "628_decision_delivered_supplement_index"},
	{"607_native_question_answer", "629_native_question_answer"},
	{"608_native_question_answer_seq_index", "630_native_question_answer_seq_index"},
	{"609_native_question_answer_request_index", "631_native_question_answer_request_index"},
	{"610_issue_decision_response", "632_issue_decision_response"},
	{"611_issue_decision_response_request_index", "633_issue_decision_response_request_index"},
	{"612_issue_decision_response_id_index", "634_issue_decision_response_id_index"},
	{"613_decision_handoff_wakeup", "635_decision_handoff_wakeup"},
	{"614_workspace_account_engine_version", "636_workspace_account_engine_version"},
}

// renameRenumberedForkMigrations moves each pre-sync version row onto its new
// stem on the caller's pinned connection, so the apply loop sees one
// authoritative row per migration. The NOT EXISTS guard keeps a database that
// already recorded the new stem (a fresh install, or a run interrupted between
// the rename and the next start) from colliding on the primary key.
func renameRenumberedForkMigrations(ctx context.Context, conn *pgxpool.Conn, tableIdent string) error {
	for _, pair := range forkMigrationRenames {
		oldVersion, newVersion := pair[0], pair[1]
		statement := fmt.Sprintf(
			"UPDATE %s SET version = $1 WHERE version = $2 AND NOT EXISTS (SELECT 1 FROM %s WHERE version = $1)",
			tableIdent, tableIdent,
		)
		tag, err := conn.Exec(ctx, statement, newVersion, oldVersion)
		if err != nil {
			return fmt.Errorf("rename migration %q to %q: %w", oldVersion, newVersion, err)
		}
		if tag.RowsAffected() > 0 {
			fmt.Printf("  rename %s -> %s\n", oldVersion, newVersion)
		}
	}
	return nil
}
