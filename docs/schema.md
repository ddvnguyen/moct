# fleet.db schema versions

`SCHEMA_VERSION` in `src/store/schema.ts` is the version this build writes.
`APPLIED_SCHEMA_VERSIONS` lists every version whose DDL ships in `FLEET_SCHEMA_SQL`,
oldest first. Each one gets a `meta` row `schema_version:<n>`. Never drop a version
from that list.

| Version | Owner | Tables | Status |
|---|---|---|---|
| 2 | fleet (Python parity) | `orch_projects`, `orch_tracks`, `orch_tasks`, `orch_workers`, `orch_turns`, `orch_events`, `orch_decisions`, `orch_suggestions`, `orch_model_evaluations` | applied |
| 3 | team domain (LLM-Agents-Orchestration#70) | `teams`, `team_tracks`, `seats`, `seat_sessions` | applied |
| 4 | paseo #68 | `room_messages` | reserved, not in this repo yet |
| 5 | paseo #69 | `task_attempts` | reserved, not in this repo yet |
| 6 | MOCT Team Room (contract v0.3 §2) | `team_operations`, `team_session_runs`, `team_thread_summaries` | applied |
| 7 | MOCT Team Room read models | `team_turns`, `team_thread_bindings` | applied |

Versions 4 and 5 are held for paseo #68 and #69. Both PRs are still open, with
merge blockers, so they are not in this tree. When they are cherry-picked, their
DDL goes into `FLEET_SCHEMA_SQL` and their numbers go into `APPLIED_SCHEMA_VERSIONS`.
Version 6 does not depend on either.

## v6 — Team Room

- `team_operations(workspace_id, sequence, operation_id UNIQUE, kind, record_json, occurred_at, PRIMARY KEY(workspace_id, sequence))`.
  The append-only ledger log. `sequence` is assigned by the ledger and is never
  renumbered. A duplicate sequence is a 409 `SEQUENCE_CONFLICT`. A retried
  `operation_id` with the same record is a 200 replay. A different record under
  the same `operation_id` is a 409 `OPERATION_ID_CONFLICT`.
- `team_session_runs(session_id PK, member_id, parent_session_id, thread_refs_json, …, state)`.
  SessionRun stats rows (contract §3.2). Upserted by `session_id`.
- `team_thread_summaries(thread_ref, generation, trigger, text, covers_through_sequence, tokens, model, at, PRIMARY KEY(thread_ref, generation))`.
  Summary generations (contract §3.3). A generation older than the latest is a
  409 `GENERATION_STALE`. The same generation with different content is a 409
  `GENERATION_CONFLICT`.

The thread-session binding (contract §3.1, `thread.session.bind`) is an operation
in `team_operations`, not a separate table. The projection is rebuilt by the
client ledger, as the contract's section 0 requires.

## v7 — Team Room read models

Derived tables. `team_operations` stays the source of truth; v7 folds two kinds of
operation into tables the backend can query, in the same transaction as the append.
They can be dropped and rebuilt from the log.

- `team_turns(workspace_id, sequence, operation_id, session_id, member_id, turn, started_at, ended_at, tool_calls, run_ms, uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, thread_refs_json, PRIMARY KEY(workspace_id, sequence))`.
  One row per `team/session-turn-recorded` operation. A token figure the Turn did not
  report is NULL, never 0, so `GET /team/v1/usage` can say how many Turns a sum does
  not cover (`unknown*Turns`).
- `team_thread_bindings(workspace_id, thread_ref, member_id, session_id, session_reason, session_sequence, slot, slot_bound_at, slot_sequence, PRIMARY KEY(workspace_id, thread_ref, member_id))`.
  The current Thread to Session half (`team/thread-session-bound`) and Thread to
  Instance-slot half (`team/thread-instance-bound`) per Member. `*_sequence` records
  which operation set each half, so an older operation never overwrites a newer one.

Operations stored before v7 are folded once at daemon start. The marker is
`meta` key `team_projection:1`, written in the same transaction as the backfill. To
rebuild a read model: delete its rows and that `meta` key, then restart.

New routes (read-only, loopback, additive):

- `GET /team/v1/usage?workspaceId=&groupBy=member|day|session|total&memberId=&since=&until=`
  `since` is inclusive, `until` exclusive, both ISO dates or instants compared with the Turn's `endedAt`.
- `GET /team/v1/bindings?workspaceId=&threadRef=` or `&memberId=` (exactly one).

Rollback: an older build ignores the v7 tables and routes. The DB stays valid for it.
