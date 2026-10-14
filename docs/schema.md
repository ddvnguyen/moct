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
| 8 | MOCT team memory | `team_memory_records`, `team_memory_tags`, `team_memory_links`, `team_memory_versions`, `team_memory_settings` | applied |

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
### Summary generations are projected from the ledger

`team/thread-summary-committed` is folded into `team_thread_summaries`, so a summary the
ledger committed is readable through the v6 route below without replaying the log. The
operation calls the token count `transcriptTokens`; the column calls it `tokens`, and that
is where it lands. The operation carries `model` as `{provider, model}` and the table has
one `TEXT` column, so it is stored as `provider/model`. `usage` has no column and is not
carried.

Idempotent, like every projection here: appending the same operation twice stores one row.
An operation that cannot be projected (no `threadRef`, a `trigger` that is not
`rolling`/`wrapup`, a fractional `generation`, no `text`) stays a plain log entry and is
read as no summary, never as a zeroed one.

New routes (read-only, loopback, additive):

- `GET /team/v1/usage?workspaceId=&groupBy=member|day|session|total&memberId=&since=&until=`
  `since` is inclusive, `until` exclusive, both ISO dates or instants compared with the Turn's `endedAt`.
- `GET /team/v1/bindings?workspaceId=&threadRef=` or `&memberId=` (exactly one).

Rollback: an older build ignores the v7 tables and routes. The DB stays valid for it.

## v8 — Team memory

Backend-owned state, **not** a projection of `team_operations`. No ledger op kind
is added. `how_to_work` follows an expert across Workspaces, and a purge must
remove text, which an append-only log cannot. Design: typed records with
visibility tags (design v5, approved on the MOCT memory thread).

- `team_memory_records(id PK, workspace_id, type, title, body, attrs, home_kind, home_ref, priority, pinned, status, flag, supersedes, superseded_by, conflicts_with, task_ref, unique_key, author_kind, author_id, created_at, updated_at, last_used_at, use_count, version, embedding)`.
  The current state of each record. CHECKs pin each type to its homes, and make
  `workspace_id` NULL exactly for `how_to_work`:

  | Type | Home | Visible to | Priority |
  |---|---|---|---|
  | `rule` | team, channel | that team or channel; always loads | 100 |
  | `decision` | task, channel | the whole team (+ its home) | 80 |
  | `convention` | team, channel | that team or channel | 60 |
  | `how_to_work` | expert | that expert (+ orchestrators) | 60 |
  | `task` | task | the whole team; one per task | 40 |
  | `branch` | channel | the whole team; one per repo + branch | 40 |

  `status` is one of `pending`, `active`, `superseded`, `retracted`, `expired`,
  `purged`. `flag` is `blocked_budget` when an approval was refused because the
  home's always-load set is full. `unique_key` is the taskRef itself (`task:<uuid>`) or
  `branch:<repo>#<branch>`, with `UNIQUE(workspace_id, unique_key)` (NULLs are
  distinct, so other types are unaffected). `embedding` is reserved for vector
  search and is unused in 0.11.0.
- `team_memory_tags(record_id, kind, ref, PRIMARY KEY(record_id, kind, ref))`.
  Visibility tags are `team`, `channel`, `task`, `expert`; `repo` and `branch`
  tags only describe. `home` is the narrowest visibility tag. Decisions, tasks
  and branches always carry the team tag.
- `team_memory_links(from_id, to_id, kind, PRIMARY KEY(from_id, to_id, kind))`.
  `on_branch`, `decided_in`, `blocks`, `relates`. Links are made by the store from
  a record's cited `taskRef`; a model never names a link target.
- `team_memory_versions(memory_id, version, action, workspace_id, type, home_kind, home_ref, tags_json, title, body, attrs, priority, pinned, status, actor_kind, actor_id, reason, at, PRIMARY KEY(memory_id, version))`.
  One row per change: `create`, `edit`, `pin`, `unpin`, `priority`, `widen`,
  `approve`, `supersede`, `retract`, `restore`, `expire`, `purge`. **Every version
  is kept**, with a tags snapshot. Triggers make the table insert-only; the single
  exception is a purge scrubbing `title`, `body` and `attrs` to same-length `#`
  filler or NULL.
- `team_memory_settings(key PK, value, updated_at, updated_by)`. Human-set:
  `expert_approval` (`required` by default), `orchestrators` (JSON list of member
  ids: the first-mate experts), `inject_layer_tokens` (default 1000, hard cap 2000).

Rules the store enforces (`src/team-room/memory.ts`):

- **Scope.** Every read is filtered by the scope the caller names (Workspace,
  expert, Channels, Tasks, or `all` for orchestrators), so a read never crosses
  into another Workspace or a Channel or Task outside the scope. `memory_get`
  answers an invisible, unknown or purged id in `missing`. The backend has no auth
  on loopback: the caller asserts `actor` and scope, and the plugin is the trust
  boundary that fills both from the session.
- **Roles.** The human; orchestrators (the `orchestrators` setting) with full
  access; workers. `task` and `branch` records are kept by orchestrators only.
  A worker changes only its own records, writes only its own `how_to_work`, and
  never pins, sets priority or widens.
- **Human only.** `restore`, `purge`, settings, and approving a team-scoped rule.
- **Approval.** With `expert_approval = required`, a worker's `rule`, `decision`
  and `how_to_work` start `pending`, and a worker's text edit puts an active one
  back to `pending`. A team-scoped rule written or widened by anyone but the human
  is `pending` for the human. Nobody approves their own record.
- **Always-load cap.** Rules and pinned records always load, so a write, pin,
  approval or widen that would push a home's set past 2000 tokens is refused with
  409 `BUDGET_FULL`. `details` carries `home`, `capTokens`, `usedTokens`,
  `neededTokens` and the five largest consumers. A refused approval stays
  `pending` with `flag = blocked_budget` and never auto-activates.
- **Near matches.** A new record whose title shares half its words with an active
  or pending record of the same type is held back (`record: null`, `nearMatches`)
  unless `confirmNew`; a confirmed one records them in `conflicts_with`. A
  superseding record names the one it replaces there too.
- **Task and branch** writes are an idempotent upsert on `unique_key`: `created`,
  `unchanged` or `updated`. The same key in another home is 409 `UNIQUE_CONFLICT`.
- **Widen** (promote) moves a record to a wider allowed home in place
  (task → channel, channel → team), replacing narrower visibility tags, in one
  version with the tags snapshot.
- **Secrets.** Title, body or attrs matching a credential rule is refused with 422
  `SECRET_DETECTED`; the message names the rule, never the match.
- **Concurrency.** Every change carries `baseVersion`; a stale one is 409 `VERSION_STALE`.
- **Expiry.** Unpinned `convention` and `how_to_work` records idle 30 days (no
  edit, no `memory_get` citation) become `expired`. Rules, decisions, tasks and
  branches never expire. The daemon sweeps once at start and hourly. The sweep
  never deletes.
- **Injection** (`GET /team/v1/memory/inject`) is read-only. Buckets narrowest
  first (task, channel, team, expert); the task bucket also holds what is linked
  to the current task record. In each, rules and pinned records always load; the
  rest fills the layer budget by priority, then recency. Duplicate text is
  skipped. Of two conflicting records only the winner (priority, then narrower
  home, then newer) loads. What did not load is listed in a per-layer index
  (count, plus up to five ids) for lazy load.

### Purge

`POST /team/v1/memory/:id/purge` overwrites title, body and attrs in place with
same-length filler, then sets them NULL on the record and on every version, drops
the descriptive tags and the unique key, writes a tombstone version (who, when,
why), and runs `PRAGMA wal_checkpoint(TRUNCATE)` so no WAL frame still holds the
text. Measured: after a purge, the purged string appears 0 times in `fleet.db`
and its WAL.

**Backups are not reached.** Any `/team/v1/backup` copy taken before the purge
still holds the text. Delete or re-take those copies to finish removal.

### Routes (loopback, additive)

- `GET /team/v1/memory?workspaceId=&expertId=&channels=&tasks=&all=1&q=&types=&homes=&status=&limit=&cursor=` — search (not a citation)
- `POST /team/v1/memory` — note (create, supersede, or task/branch upsert)
- `POST /team/v1/memory/get?workspaceId=&expertId=&channels=&tasks=&all=1` with `{ids}` — get (a citation)
- `GET|PATCH /team/v1/memory/:id` — read, or one change (text, `pinned` or `priority`)
- `GET /team/v1/memory/:id/versions`
- `POST /team/v1/memory/:id/{widen|approve|retract|restore|purge}`
- `GET|PUT /team/v1/memory/settings`
- `GET /team/v1/memory/inject?expertId=&workspaceId=&channelRef=&taskRef=&layerTokens=`
- `GET /team/v1/memory/rule-feed?workspaceId=&limit=`
- `GET /team/v1/memory/usage?workspaceId=` — each home's always-load use against the cap, with the `injectLayerTokens` bounds (read-only, not a citation). `how_to_work` belongs to no Workspace, so every expert home with an always-load record is listed in every Workspace and counted as the cap counts it; a client narrows them to the Workspace's Members.

Refusals answer `{ok:false, code, error[, details]}` with status 400, 403, 404, 409 or 422.

Rollback: measured on the final DDL. The 0.10.0 dist was run on a copy of a v8
`fleet.db` holding every record type, tags, links, settings, both unique keys and
a purged record. It started with 0 error lines, `/team/v1/health` answered 200
with `schema: 7`, the operations routes answered 200, and a new operation write
answered 201. Rolling forward to 0.11.0 kept every memory row, tag, link, version
and both operations, and a new memory write read back. An older build ignores the
v8 tables and routes.
