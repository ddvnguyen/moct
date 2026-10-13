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
| 8 | MOCT team memory | `team_memory`, `team_memory_versions`, `team_memory_settings` | applied |

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

## v8 — Team memory

Backend-owned state, **not** a projection of `team_operations`. No ledger op kind
is added. The expert layer follows a Member across Workspaces, and a purge must
remove text, which an append-only log cannot.

- `team_memory(id PK, layer, member_id, workspace_id, channel_ref, thread_ref, origin_workspace_id, promoted_from, promoted_to, content, pinned, status, author_kind, author_id, created_at, updated_at, last_used_at, use_count, version, embedding)`.
  The current state of each entry. A CHECK enforces each layer's scope shape:

  | Layer | Scope columns | Meaning |
  |---|---|---|
  | `expert` | `member_id` | how that expert works; follows it everywhere |
  | `team` | `workspace_id` | how this team works: rules, conventions |
  | `channel` | `workspace_id`, `channel_ref` | facts about one project or epic |
  | `task` | `workspace_id`, `channel_ref`, `thread_ref` | working state of one task; expires when the task closes |

  `status` is one of `pending`, `active`, `retracted`, `expired`, `purged`.
  `embedding` is reserved for vector search and is unused in 0.11.0.
- `team_memory_versions(memory_id, version, action, layer, workspace_id, channel_ref, thread_ref, content, pinned, status, actor_kind, actor_id, reason, at, PRIMARY KEY(memory_id, version))`.
  One row per change: `create`, `edit`, `pin`, `unpin`, `promote`, `approve`,
  `retract`, `restore`, `expire`, `purge`. **Every version is kept.** Triggers make
  the table insert-only; the single exception is a purge scrubbing `content`.
- `team_memory_settings(key PK, value, updated_at, updated_by)`. Human-set switches:
  `expert_approval` (`required` by default), `first_mate_members` (JSON list of
  member ids), `inject_layer_tokens` (default 1000, hard cap 2000).

Rules the store enforces (`src/team-room/memory.ts`):

- **Scope.** Every read is filtered by the scope the caller names, so a read never
  crosses into another Workspace, Channel or Thread. The backend has no auth on
  loopback: the caller asserts `actor`, and the plugin is the trust boundary. The
  plugin checks Channel membership and first-mate reach.
- **Owners.** An expert changes only its own notes, and writes only its own expert
  memory. Pins are the human's call, except an expert's own expert notes.
- **Human only.** `restore`, `purge` and settings.
- **Approval.** With `expert_approval = required`, a new expert note written by an
  expert starts `pending`. The human or a first-mate expert approves it; nobody
  approves their own note.
- **Promote** widens task → channel/team and channel → team. It writes a **new**
  entry (unpinned, same author, `promoted_from` = source) and retracts the source
  (`promoted_to` = new id). An entry never changes layer or scope.
- **Secrets.** Content matching a credential rule is refused with 422
  `SECRET_DETECTED`; the message names the rule, never the match.
- **Concurrency.** Every change carries `baseVersion`; a stale one is 409 `VERSION_STALE`.
- **Expiry.** Unpinned entries idle 30 days (no edit, no cited search) become
  `expired`. The daemon sweeps once at start and hourly. The sweep never deletes.
- **Injection** (`GET /team/v1/memory/inject`) is read-only. Narrowest layer first
  (task, channel, team, expert). Each layer loads its pinned notes up to its own
  budget, and unused budget does not carry over. A note whose text a narrower layer
  already loaded is skipped. Everything else active in scope is listed in a
  per-layer index (count, plus up to five ids with snippets) for lazy load.

### Purge

`POST /team/v1/memory/:id/purge` overwrites the text in place with same-length
filler, then sets it NULL on the entry and on every version, writes a tombstone
version (who, when, why), and runs `PRAGMA wal_checkpoint(TRUNCATE)` so no WAL
frame still holds the text. Measured: after a purge, the purged string appears 0
times in `fleet.db` and its WAL.

**Backups are not reached.** Any `/team/v1/backup` copy taken before the purge
still holds the text. Delete or re-take those copies to finish removal.

### Routes (loopback, additive)

- `GET /team/v1/memory?workspaceId=&memberId=&channelRef=&threadRef=&layers=&q=&status=&limit=&cite=1`
- `POST /team/v1/memory` — create
- `GET|PATCH /team/v1/memory/:id` — read, or one change (`content` or `pinned`)
- `GET /team/v1/memory/:id/versions`
- `POST /team/v1/memory/:id/{promote|approve|retract|restore|purge}`
- `GET|PUT /team/v1/memory/settings`
- `GET /team/v1/memory/inject?memberId=&workspaceId=&channelRef=&threadRef=&layerTokens=`
- `POST /team/v1/memory/task-closed`

Refusals answer `{ok:false, code, error}` with status 400, 403, 404, 409 or 422.

Rollback: measured. The 0.10.0 dist was run on a copy of a v8 `fleet.db`. It
started with 0 error lines, `/team/v1/health` answered 200 with `schema: 7`, the
operations routes answered 200, and a new operation write answered 201. Rolling
forward to 0.11.0 kept every memory row and both operations. An older build ignores
the v8 tables and routes.
