# M1 parity harness

Same-input / identical-output gate between the Python `mcp-orchestration`
server (authoritative) and `packages/fleet-backend` over MCP stdio.

## Layout

- `tests/fixtures/seed.sql` — checked-in fixture, generated ONCE by
  `npm run fixture:regen` from a read-only snapshot of the live ledger
  (regeneration is MANUAL when the Python schema drifts — never from
  CI/tests). Counts at generation are recorded in the seed header.
- `setup.ts` — live-DB guard, deterministic builds of both engines' DBs from
  the same seed, server boot.
- `cases.ts` — the case catalog (138 cases spanning all 26 tools: happy-path
  reads, writes, and error cases).
- `rpc.ts` — raw JSON-RPC stdio client (no SDK validation: invalid args must
  reach the server so validation errors compare too).
- `normalize.ts` — volatile-field normalization + comparison.
- `parity.test.ts` — runner, per-case pass/fail report with diffs.

## Table mapping (fleet.db v1 rename)

`store/schema.ts` is canonical. The harness compares after un-prefixing:

| live (Python)                                                   | fleet.db v1                                                               | notes                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `projects`                                                      | `orch_projects`                                                           | columns identical                                                      |
| `tracks`                                                        | `orch_tracks`                                                             | columns identical                                                      |
| `tasks`                                                         | `orch_tasks`                                                              | columns identical                                                      |
| `workers`                                                       | `orch_workers`                                                            | columns identical                                                      |
| `turns`                                                         | `orch_turns`                                                              | columns identical                                                      |
| `events`                                                        | `orch_events`                                                             | columns identical                                                      |
| `decisions`                                                     | `orch_decisions`                                                          | columns identical                                                      |
| `suggestions`                                                   | `orch_suggestions`                                                        | columns identical                                                      |
| `model_evaluations`                                             | `orch_model_evaluations`                                                  | columns identical                                                      |
| `schema_version(version, applied_at)`                           | `meta(key, value)`                                                        | rows `schema_version:<n>` → applied_at; mapped back in `unmigrateSeed` |
| `idx_*`                                                         | `idx_orch_*`                                                              | same columns                                                           |
| `events_no_update/_no_delete`, `decisions_no_update/_no_delete` | `orch_events_no_update/_no_delete`, `orch_decisions_no_update/_no_delete` | same `RAISE(ABORT, ...)` payload text                                  |

`python.db` is derived from the SAME `seed.sql` by mechanical identifier
rewrite (`unmigrateSeed`), so both engines start from identical rows.

## Normalization (decision D5: normalized field equality)

Full output JSON is compared field-by-field after replacing:

- generated ids (`p|t|task|d|sugg|eval-<10 hex>`, whole or substring) with
  per-side ordinal tokens `<id:prefix#n>` (appearance order; equal structures
  tokenize identically). VALUES are format-checked by the match itself.
- timestamps (`YYYY-MM-DDTHH:MM:SS.mmmZ`, whole or substring) with `<ts>`.
- server tmp-dir prefixes with `<tmp>` (lesson/reference paths, usage
  `stored` path, summary `path`).
- `*age_s` / `*_age_s` numbers compare with `|a-b| <= 1`: two servers stamp
  two clocks, and a straddling second boundary is a race, not a divergence.
  Everything else (counts, ordering, error text) compares exactly.

## Volatile / environment-coupled fields

- `stderr_tail` (gh failures): both servers shell out to the same `gh`
  binary with the same argv/timeout, so text matches in any environment with
  gh present. Without gh, both sides synthesize CPython's `FileNotFoundError`
  text (`[Errno 2] No such file or directory: 'gh'`), which also matches.
- `adapter_error` / `live_verified` / `checked_at`: `omp`/`opencode` CLI
  probing runs the same binaries on both sides (`checked_at` normalized).
  Missing CLIs degrade to identical synthesized `unverified` results.
- `pr_verified` gh detail: only asserted on the error path (bogus PR), where
  both sides surface the same gh stderr.
- `tokens` / `tokens_estimate`: deterministic functions of identical text.

## Live-DB guard

- `setupParity` resolves the live ledger path and throws LOUDLY if either
  `FLEET_DB_PATH` or `MCP_ORCH_DB_PATH` resolves to it.
- `dist/mcp.js` refuses to open any path in `FLEET_FORBIDDEN_DB_PATHS`
  (the harness sets the live path) and never reads `MCP_ORCH_DB_PATH`.
- All TS runtime/test DBs live under worktree-local `.tmp/` or the package
  dir (gitignored); never `/tmp`.

## Known engine limitations (do not affect parity)

- Turso 0.7.2 ignores `FOREIGN KEY` enforcement (verified by probe; the DDL
  keeps the constraints for schema fidelity). Unreachable via tools: every
  write path resolves parents first and returns `not found` errors.
- Turso has no read-only open (`connect(path)` takes no options): the regen
  script runs SELECT-only against a disposable copy.
- `sqlite_sequence` DDL is rejected by Turso (reserved); sequence state is
  auto-maintained. `__turso_internal%` bookkeeping is excluded from hashing.
- Stored DDL text differs by Turso's whitespace normalization only.
- Integral floats (e.g. `100.0`) are indistinguishable from ints after JSON
  parse; the fixture contains none (verified by scan), and parity write
  cases use ints/strings/bools only.
- MCP validation-error text pins pydantic 2.13 rendering (probed); a venv
  upgrade that changes rendering fails loudly here, which is intended.
