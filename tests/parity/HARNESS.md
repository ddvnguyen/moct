# M1 parity harness

Same-input / identical-output gate between the Python `mcp-orchestration`
server (authoritative) and `packages/fleet-backend` over MCP stdio.

## Pinned baseline (round 3, owner should-fix #1)

The Python side is PINNED to `origin/hydra/orchestration`
`13fc0cb0f789965e64e34b541fa5e14fb7b37cf2` (contains LAO #68 — runbook
1.11.0 — and #69), via `LAO_PIN_SHA` in `setup.ts`. `setupParity` verifies
`runbook.py`, `config.py`, `state/timings.py`, and `tools/leader.py` under
`PY_SRC` match the pin byte-for-byte (`git show <pin>:<path>`) and FAILS
LOUDLY with an actionable message on mismatch — hydra progress must never
silently move the baseline, and pointing the env vars at a different tree to
make it pass is called out as wrong in the error itself.

Ported since the 1.10.0 baseline (755c459 → pin): LAO #68 (runbook 1.10.0 →
1.11.0: dev reuse cutoff 160K → 200K + rationale, COMPACT ≤3 THEN RESPAWN,
WRONG-DIRECTION → KILL, ORCHESTRATOR FLAGS + AGENT WATCH steps), LAO #69
(holder re-confirm is an idempotent no-op with its own note, order-sensitive
history test, `outcome` in the confirm event payload; `_agent_cwd`
explicit → `PASEO_AGENT_CWD` → process cwd; `_detect_repo_root` fail-open),
LAO #63 (`orchestrator_workspace_id` + conditional `workspaceId` in the
orchestrator spec). LAO #44 (paseo-fleet plugin) and #61 (deploy-only) touch
no `mcp-orchestration/src` tool contract — nothing to port. Timings `*/30`
was already current in the TS domain.

To move the pin: port the new deltas, update `LAO_PIN_SHA`, re-run parity,
and record the new SHA + case count here and in the PR body.

Run parity with explicit env (no machine-local defaults are baked in —
`setup.ts` names the missing var and refuses to run). The live LAO working
tree drifts past the pin, so the baseline is a read-only `git archive`
extract at the pin (Python anchors repo-relative reads to `__file__`, so the
extract is self-consistent; the venv interpreter is reused from the live
checkout):

```bash
export FLEET_PARITY_LAO_GIT=/path/to/LLM-Agents-Orchestration   # checkout carrying the pin object
PIN=13fc0cb0f789965e64e34b541fa5e14fb7b37cf2                     # LAO_PIN_SHA in setup.ts
mkdir -p packages/fleet-backend/.parity-pin                     # gitignored
git -C "$FLEET_PARITY_LAO_GIT" archive "$PIN" | tar -x -C packages/fleet-backend/.parity-pin/
export FLEET_PARITY_LAO_ROOT="$PWD/packages/fleet-backend/.parity-pin"
export FLEET_PARITY_VENV_PY="$FLEET_PARITY_LAO_GIT/mcp-orchestration/.venv-cd/bin/python"
# optional: export FLEET_PARITY_PY_SRC="$FLEET_PARITY_LAO_ROOT/mcp-orchestration/src"
# optional: export FLEET_PARITY_LIVE_DB=/path/to/live/orchestration.sqlite  # guard only
pnpm --filter @getpaseo/fleet-backend parity
```

## Gate placement (round-3 nit decision)

Parity (~5 min measured, 140 cases, two servers over stdio) is EXCLUDED from the
default `vitest run` via `vitest.config.ts` (the `exclude` also filters
explicit file args, so there is exactly one door: `pnpm parity` sets
`PARITY=1` to lift the exclusion). The default PR gate stays fast on
unit/concurrency/gate tests; parity runs explicitly and its result is
reported in the PR body with the pin SHA + case count.

## Layout

- `tests/fixtures/seed.sql` — checked-in fixture, SCRUBBED (see `SCRUB.md`;
  regeneration via `npm run fixture:regen` is MANUAL when the Python schema
  drifts — never from CI/tests — and the script re-applies the scrub, throwing
  if any banned pattern survives). Counts at generation are recorded in the
  seed header; per-table counts were verified identical before/after scrub.
- `setup.ts` — pin verification, live-DB guard, deterministic builds of both
  engines' DBs from the same seed, server boot.
- `cases.ts` — the case catalog (140 cases spanning all 26 tools: happy-path
  reads, writes, and error cases; +2 vs the 138-claim era for the #69
  predecessor/new-generation outcomes, and the old `...-stale` case renamed to
  `...-reconfirm` since a holder re-confirm is no longer stale).
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

- `setupParity` forbids the LAO-derived ledger path (always) plus
  `FLEET_PARITY_LIVE_DB` when set, and throws LOUDLY if either
  `FLEET_DB_PATH` or `MCP_ORCH_DB_PATH` resolves to one. Fixtures/tests never
  need the live DB — both engines' DBs are built from the checked-in seed.
- `dist/mcp.js` refuses to open any path in `FLEET_FORBIDDEN_DB_PATHS`
  (the harness sets the live path) and never reads `MCP_ORCH_DB_PATH`.
- All TS runtime/test DBs live under worktree-local `.tmp/` or the package
  dir (gitignored); never `/tmp`.

## Unlocked writers share the open transaction (round-3 #4 outcome)

`decision_add` (`decisionRecord`) runs outside `lock()` — a faithful port
(Python's `decision_add` is also unlocked). Pinned by
`tests/concurrency/round3-unlocked-writer.test.ts`: a decision recorded while
another call's `BEGIN IMMEDIATE` is open is absorbed into that transaction —
the call returns `ok` but the row rolls back with the throwing section, and
`turn_count` is unchanged. Python's single-connection `Store` behaves
identically, so NO divergence was confirmed and NO `lock()` wrapping was
added (wrapping is re-opened only if this test ever shows the row surviving).
The same absorption applies to the other unlocked writers
(`project_create`/`track_create`, leader/lessons event appends) by the same
single-connection mechanism.

## Cross-process lock waits (round-3 #3)

Python honors `busy_timeout=5000` and waits; Turso 0.7.2 fresh connects fail
fast on busy|locked. `TursoRepository.lock()` therefore retries `BEGIN
IMMEDIATE` with backoff on busy|locked only, on a ~5s total budget matching
Python's observable behavior, then throws the ORIGINAL error. Non-busy errors
throw immediately. Pinned by the rewritten round-2 test (d) (rival lock waits
and acquires) plus a beyond-budget case (original busy error surfaces).

Deliberate deviation, measured: repo connections set `PRAGMA busy_timeout=0`
(Python sets 5000). A nonzero budget makes the NATIVE call block the Node
event loop for the full budget — the holder's own timer/COMMIT cannot fire
while a waiter is blocked inside `exec`, so waiter starves holder past its own
deadline (probed: holder's 1.5s body took 5.3s). Fail-fast + cooperative
JS-level retry yields between attempts, so the holder progresses: same
observable wait, no frozen server. One-shot helpers never set the pragma
(SQLite default 0), so all connections are consistent.

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
