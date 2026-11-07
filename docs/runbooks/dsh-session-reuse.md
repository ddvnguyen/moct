# dsh session reuse on lane z

Runbook for operators of a Multica daemon that runs dsh (DeepSeek harness) agents. Written against `multica-moct` at `03fdf8b`. Citations are `path:line` (repo-relative) or "review Fn" (`docs/reviews/S3-review.md`, written at `93b6f61`; its line numbers are stale). Anything not verified by reading the cited lines is marked "(unverified)".

## 1. Purpose and scope

This runbook explains how a dsh run decides to resume, seed or start fresh. It also covers the clock that builds summaries while the provider cache is warm, the settings that tune both, the detached runtime, and where to read the decisions afterwards. It covers the Go daemon and server only. The bridge (`dsh-multica-runtime`) and dsh itself are not in this repo.

## 2. The three session-start verdicts

Exactly one verdict is stored per run (`server/internal/daemon/dsh_session_start.go:34-47`).

| Verdict | Meaning | Source |
|---|---|---|
| `fresh` | No prior conversation is carried. | `server/internal/daemon/dsh_session_start.go:47` |
| `resumed warm` | The prior session is continued by id. | `server/internal/daemon/dsh_session_start.go:40` |
| `seeded from summary of <id>` | A new session forks from `<id>` and starts with its stored summary plus the trigger text. | `server/internal/daemon/dsh_session_start.go:43`, `:236-238` |

The reason string (for example `warm: idle 10m0s < 45m0s`) goes to the daemon log only. The run row carries the verdict alone (`server/internal/daemon/dsh_session_start.go:146-147`).

### 2.1 Candidate session

- The server offers a same-issue prior session only if it ran on this runtime (`server/internal/handler/daemon.go:3516-3518`).
- It sends the prior end time only if the row has a terminal timestamp (`server/internal/handler/daemon.go:3526-3528`).
- A linked session (parent or child issue) is offered only when the issue has no session of its own (`server/internal/handler/daemon.go:3569-3574`).
- If the daemon sees both, the linked one wins only when its end time is later (`server/internal/daemon/dsh_session_start.go:289-324`).
- "Reachable" means the candidate workdir equals this run's workdir and the session home is reachable (`server/internal/daemon/daemon.go:6665-6670`). A linked session from another workdir is normally not reachable (inference from the same lines).

### 2.2 Decision table (`decideDshSessionStart`)

Warm window = TTL for the model minus margin (`server/internal/daemon/dsh_session_start.go:192`). A negative age is clamped to zero (`:187-191`).

| # | Condition | Verdict | Reason (log only) | Lines |
|---|---|---|---|---|
| 1 | No candidate | `fresh` | `no related session` | `server/internal/daemon/dsh_session_start.go:154-157` |
| 2 | End time unknown, reachable | `resumed warm` | `session end time unknown` | `server/internal/daemon/dsh_session_start.go:179-183` |
| 3 | End time unknown, not reachable | cold path (below) | `cold: session store not reachable` | `server/internal/daemon/dsh_session_start.go:184` |
| 4 | Age < window, reachable | `resumed warm` | `warm: idle X < Y` | `server/internal/daemon/dsh_session_start.go:194-196` |
| 5 | Age < window, not reachable | cold path | `cold: session store not reachable (idle X < Y)` | `server/internal/daemon/dsh_session_start.go:197-199` |
| 6 | Window <= 0 | cold path | `cold: no positive warm window configured` | `server/internal/daemon/dsh_session_start.go:200-201` |
| 7 | Age >= window | cold path | `cold: idle X >= Y` | `server/internal/daemon/dsh_session_start.go:202-203` |

Cold path, in order (`server/internal/daemon/dsh_session_start.go:209-243`):

| Check | Result | Lines |
|---|---|---|
| Summaries disabled | `fresh`, `; summaries disabled` | `:211-214` |
| No summary reader | `fresh`, `; no summary reader` | `:215-218` |
| No `summary.json`, or empty summary | `fresh`, `; no summary beside the session` | `:219-223` |
| Summary `made_at` before the session end | `fresh`, `; summary is older than the session's end` | `:227-230` |
| Seed composes to empty | `fresh`, `; summary produced an empty seed` | `:231-235` |
| Otherwise | `seeded from summary of <id>`, `; summary is fresh` | `:236-243` |

A verdict other than `resumed warm` clears the same-issue prior pointer (`server/internal/daemon/dsh_session_start.go:258-262`).

### 2.3 Intended behavior after S3-fix H

A separate PR, "S3-fix H" (ddvnguyen/multica-x#111), changes rows 2 and 3. An unknown or zero end time will always give `fresh` with reason `fresh: session end time unknown`. It will never be resumed and never be seeded. The review lists unknown-`EndedAt` as an owner decision (review "H. Owner decisions" and the "Decision contradictions" table).

Until S3-fix H is merged, `multica-moct` resumes a reachable session whose end time is unknown (`dsh_session_start.go:179-183`).

Today an unreachable candidate with an unknown end time falls into the cold path. It can then be seeded, because `made_at` is never before a zero time (`server/internal/daemon/dsh_session_start.go:184`, `:227`). Fix H removes that too.

### 2.4 Two other writers of the verdict

| Writer | Verdict and reason | Lines |
|---|---|---|
| Fresh-session retry (the first attempt failed to start on its session) | `fresh`, `fresh-session retry`. Replaces any earlier verdict. | `server/internal/daemon/daemon.go:9290` |
| Seed downgraded because the bridge did not fork | `resumed warm`, reason `bridge did not fork`, resuming the planned fork parent. Logs `dsh seed dropped`. | `server/internal/daemon/daemon.go:9318-9326` |

The downgrade fires when a seed was planned and the run result says no fork happened (`server/internal/daemon/daemon.go:9318`). On the bridge side, a bridge without the `fork` capability, or no ready frame within 15 s, gets a plain resume (`server/pkg/agent/dsh.go:32`, `:617-640`, `:91-94`).

## 3. The summary clock

### 3.1 Arming and delay

- The clock is armed after each dsh run ends, using the final result (`server/internal/daemon/daemon.go:9362`).
- It is not armed if the feature is off, the session id is empty, or the backend cannot summarize (`server/internal/daemon/dsh_summary.go:387-393`, `:741-749`).
- Live delay = TTL for the model minus margin (`server/internal/daemon/dsh_summary.go:399`). With defaults that is 45 minutes. If the margin is not shorter than the TTL, the clock is not armed and a Warn is logged (`:400-404`).
- A resumed session disarms its clock (`server/internal/daemon/daemon.go:9045`). A seeded run disarms the fork parent's clock (`:9052`).
- A newer arm for the same session replaces the pending one (`server/internal/daemon/dsh_summary.go:431-443`).

### 3.2 Re-arm after a daemon restart

- Due-in = `ended_at + TTL - margin - now` (`server/internal/daemon/dsh_summary.go:373-375`). The run's end time anchors the fire time, not the restart time (`:405-409`).
- If due-in is zero or negative, the clock is not armed, the record is removed, and an Info line is logged (`server/internal/daemon/dsh_summary.go:410-414`).
- Re-arm runs once at daemon start, before any claim (`server/internal/daemon/daemon.go:2181-2184`).
- Details of the records are in 3.8.

### 3.3 TTL lookup precedence

`ttlForModel` (`server/internal/daemon/dsh_summary.go:87-97`):

1. The model's `long` TTL from `MULTICA_DSH_PROMPT_CACHE`, if above zero.
2. Else the model's `short` TTL, if above zero.
3. Else `MULTICA_DSH_SUMMARY_TTL`.

The map key is the model the daemon resolved for the run: agent model, else the runtime entry model (`server/internal/daemon/daemon.go:8698-8704`). The key is trimmed (`server/internal/daemon/dsh_summary.go:88`). The session-start decision uses the same function with the same model (`server/internal/daemon/dsh_session_start.go:159`, `:192`).

### 3.4 Trigger and cost rule

When the clock fires (`server/internal/daemon/dsh_summary.go:471-522`):

1. If `summary.json` already exists, nothing happens: Debug log, no decision row (`:479-483`).
2. `tokens_above_init = last_prompt_tokens - init_prefix`, clamped at zero (`:495-505`).
3. `init_prefix` is `init_prefix.json` if present and positive, else this run's `first_prompt_tokens` (`:495-499`).
4. `init_prefix.json` is written by the arm call of a run that did not resume (`prior_session_id` empty), with `first_prompt_tokens > 0`, only if the file does not exist yet (`:394-397`, `:207-239`, `:223`). The first run owns it.
5. Below `MULTICA_DSH_SUMMARY_TRIGGER_TOKENS`: decision `skipped-below-trigger` (`:137-140`).
6. Cost rule: if `tokens_above_init * (ratio - 1) < MULTICA_DSH_SUMMARY_TOKENS`, decision `skipped-cost` (`:141-145`). With defaults the trigger (20000) is far above the cost threshold (about 71 tokens), so the cost rule only bites at ratios near 1 (inference from `:39`, `:55`, `:141-145`).

### 3.5 Size target versus cap

| Setting | Default | What it does | Lines |
|---|---|---|---|
| `MULTICA_DSH_SUMMARY_TOKENS` (target) | 2048 | Used only in the cost rule. It is not sent to the bridge and not checked against the summary. | `server/internal/daemon/dsh_summary.go:39`, `:142` |
| `MULTICA_DSH_SUMMARY_TOKEN_CAP` (cap) | 4096 | Sent to the bridge as the budget, and checked by the daemon when above 0. | `server/internal/daemon/dsh_summary.go:43`, `:522`, `:544` |

- The daemon passes the cap to summarize (`server/internal/daemon/dsh_summary.go:522`).
- The `summarize` command carries `max_tokens` only if the bridge advertised `summarize_max_tokens` (`server/pkg/agent/dsh.go:176-179`, `:1254-1256`). An older bridge gets the command without it (`server/pkg/agent/dsh.go:1141-1142`).
- The daemon checks the returned token count (bridge count, else bytes/4) against the cap (`server/internal/daemon/dsh_summary.go:538-552`, `:266-270`). A cap of 0 turns this check off.
- A bridge refusal with code `DSH_SUMMARY_OVER_CAP` maps to the same decision (`server/pkg/agent/dsh.go:1278-1279`, `server/internal/daemon/dsh_summary.go:529-531`).

### 3.6 Summary over the cap

- Decision is `summary-over-cap`. Nothing is stored. There is no truncation (`server/internal/daemon/dsh_summary.go:40-42`, `:544-552`).
- The daemon-side check sets `summary_tokens` on the row (`:546`). The bridge-side refusal sets `error` instead (`:525`, `:529-531`).
- Next run: cold means no `summary.json`, so `fresh` (`server/internal/daemon/dsh_session_start.go:219-223`). Warm means `resumed warm` (`:194-196`).
- The clock is not re-armed after it fires (arm record removed at `server/internal/daemon/dsh_summary.go:476`).

### 3.7 Summary decision values

Stored in `result.dsh_summary.decision` (`server/internal/daemon/dsh_summary.go:102-108`):

| Value | When |
|---|---|
| `summarized` | Summary stored (`:567-572`). |
| `skipped-below-trigger` | Trigger not reached (`:138-140`). |
| `skipped-cost` | Cost rule failed (`:143-145`). |
| `summarize-failed` | Bridge call failed (`:524-525`). |
| `skipped-bridge-unsupported` | Bridge has no `summarize` capability (`:526-528`, `server/pkg/agent/dsh.go:1247-1251`). |
| `store-failed` | Writing `summary.json` failed (`:559-566`). |
| `summary-over-cap` | See 3.6. |

Not recorded (no row): the already-has-summary skip (`:479-483`) and the past-the-point removal at arm time (`:410-414`). Expired records at daemon start are also silent (3.8).

A session that already has `summary.json` is never summarized again (`server/internal/daemon/dsh_summary.go:479-483`). If such a session is resumed and ends again, its old summary stays; a later cold start then finds it older than the session end and starts `fresh` (`server/internal/daemon/dsh_session_start.go:227-230`).

### 3.8 arm.json and restart re-arm

| Item | Detail | Lines |
|---|---|---|
| Path | `<storeRoot>/<ProjectKey(workDir)>/<sessionID>/arm.json` | `server/internal/daemon/dsh_rearm.go:24`, `:42-57` |
| Fields | `task_id`, `work_dir`, `model`, `ended_at`, `first_prompt_tokens`, `last_prompt_tokens`, `prior_session_id` (omitted if empty) | `server/internal/daemon/dsh_rearm.go:32-40` |
| Written | Temp file plus rename, from `Arm` | `server/internal/daemon/dsh_rearm.go:68-85`, `server/internal/daemon/dsh_summary.go:417-430` |
| Removed | On Cancel, on fire, on a replacing arm, when past the point, on re-arm cleanup | `server/internal/daemon/dsh_rearm.go:87-92`, `server/internal/daemon/dsh_summary.go:413`, `:432-436`, `:462-463`, `:476` |
| Roots scanned | Shared store if `MESSAGE_SINK=dsh`, else `<profile>/dsh-sessions/<runtimeID>/<agentID>` | `server/internal/daemon/dsh_rearm.go:176-203` |
| Sidecar exists | Record removed, no clock | `server/internal/daemon/dsh_rearm.go:140-143` |
| Expired (due-in <= 0) | Record removed, Debug log, no summary, **no decision row** | `server/internal/daemon/dsh_rearm.go:144-149` |
| Unreadable, wrong work_dir or zero `ended_at` | Record removed, Warn | `server/internal/daemon/dsh_rearm.go:128-139` |
| No dsh runtime on this daemon | Record left in place, Warn | `server/internal/daemon/dsh_rearm.go:252-256`, `:150-153` |
| Count | Info `re-armed dsh summary clocks after start` | `server/internal/daemon/dsh_rearm.go:218-220` |

Re-arm is skipped if summaries are disabled (`server/internal/daemon/dsh_rearm.go:101-103`, `:209-211`). If `arm.json` could not be written, the clock does not survive a restart (Warn at `server/internal/daemon/dsh_summary.go:426-429`).

### 3.9 Seed cap (separate from the summary cap)

- The seed is the stored summary plus the trigger text, capped at 32768 estimated tokens (`server/internal/daemon/dsh_session_start.go:54`; the estimate is `(bytes+3)/4`, `:410`).
- The trigger keeps at least 512 tokens of room (`:59`, `:348-382`).
- A summary that does not fit is cut with a `[summary truncated]` marker. The trigger is cut with `[trigger truncated]` if it still does not fit (`server/internal/daemon/dsh_session_start.go:362-380`). This cap is separate from the 4096-token summary cap and applies afterwards.

## 4. Configuration

All are read at daemon start. A bad value fails startup (`server/internal/daemon/config.go:664-667`). Defaults: `server/internal/daemon/dsh_summary.go:39-55`.

| Variable | Default | Parser and validation | Lines |
|---|---|---|---|
| `MULTICA_DSH_SUMMARY_ENABLED` | `true` | Strict bool: `true/1/yes/on`, `false/0/no/off`, case-insensitive. Anything else is an error. | `server/internal/daemon/dsh_summary.go:650-661` |
| `MULTICA_DSH_SUMMARY_TOKENS` | 2048 | Integer, 0 or more | `server/internal/daemon/dsh_summary.go:672`, `:722-732` |
| `MULTICA_DSH_SUMMARY_TOKEN_CAP` | 4096 | Integer, 0 or more. 0 turns off the daemon check and the bridge budget. | `server/internal/daemon/dsh_summary.go:675`, `:544` |
| `MULTICA_DSH_SUMMARY_TRIGGER_TOKENS` | 20000 | Integer, 0 or more | `server/internal/daemon/dsh_summary.go:678` |
| `MULTICA_DSH_SUMMARY_TTL` | `1h` | Go duration plus a `d` suffix. Must be above 0. | `server/internal/daemon/dsh_summary.go:681`, `:697-699`, `server/internal/daemon/helpers.go:21-31`, `:37-52` |
| `MULTICA_DSH_SUMMARY_MARGIN` | `15m` | Same parser. Must be 0 or more, shorter than the TTL, and shorter than every per-model TTL. | `server/internal/daemon/dsh_summary.go:684`, `:700-717` |
| `MULTICA_DSH_SUMMARY_COLD_WARM_RATIO` | 30 | Float above 0 | `server/internal/daemon/dsh_summary.go:687-693` |
| `MULTICA_DSH_PROMPT_CACHE` | unset | JSON object `{"model": {"short": "5m", "long": "1h"}}`. Durations use the same parser and must be above 0. Each model needs `short` or `long`. Bad JSON is an error. | `server/internal/daemon/dsh_summary.go:598-645` |
| `MESSAGE_SINK` | unset | Only `dsh` is honored. Other values are ignored with a Warn. | `server/internal/daemon/config.go:651-655` |
| `MULTICA_DSH_SESSION_ROOT` | set by the daemon | Set for the bridge unless `MESSAGE_SINK=dsh`. | `server/internal/daemon/daemon.go:8952-8960`, `server/internal/daemon/dsh_rearm.go:241-243` |
| `DSH_HOME` | `~/.dsh` | Shared store is `$DSH_HOME/sessions`. | `server/internal/daemon/dsh_summary.go:586-596` |
| `MULTICA_DETACHED_TASK_TIMEOUT` (server) | running timeout + 30m | Go duration (no `d`). `0` disables. Invalid values fall back to the default. | `server/cmd/server/runtime_sweeper.go:96-101`, `:164-178`, `server/cmd/server/main.go:771` |

Notes:

- Raising `MULTICA_DSH_SUMMARY_TTL` also moves the session-start warm window, because both read the same value (`server/internal/daemon/dsh_session_start.go:159`, `:192`).
- With `MESSAGE_SINK` unset, sessions live in the private per-runtime/agent root (`server/internal/daemon/dsh_session_start.go:428-441`). The review flagged that lane z config was not checked for this (review "Decision contradictions", shared-store row).

## 5. Detached runtime

**Keep `MULTICA_DETACHED_RUNTIME` unset on lane z** until re-attach after a daemon restart is proven on that lane.

Why:

- During daemon shutdown, a launched detached dsh scope is left running and its work directory is preserved. Explicit task cancellation still stops the scope. The daemon pins the work directory before launch so recovery can locate it even before the first session frame.
- On restart the daemon only recovers tasks the server lists as running for a detached runtime (`server/internal/daemon/detached_recover.go:67-69`). For each it does one of:
  - no pinned `work_dir`: skipped (`server/internal/daemon/detached_recover.go:33-36`);
  - run directory unreadable: skipped (`:38-42`);
  - finished (exit file) or lost (scope gone, no exit file): reported (`:44-48`, `server/pkg/agent/dsh_detached_recover.go:106-134`);
  - still running: polled every 2 s until it ends, then reported (`:49-60`, `server/pkg/agent/dsh_detached_recover.go:27`, `:162`).
- A zero exit requires a terminal result frame; a nonzero exit fails even if a result frame exists. The restarted daemon reports through its own credentials and skips tasks already terminal on the server.
- The ordinary offline and running timeouts exclude detached dsh runs; the detached timeout remains the backstop when the daemon stays offline beyond reconnect grace.
- A recovered run is reported with status, output and session id only. Session-start verdict, init context and usage stay empty (`server/internal/daemon/detached_recover.go:86-92`). The summary clock is armed only in the normal run path (`server/internal/daemon/daemon.go:9362`, the only non-test call of `armDshSummaryClock`), so a recovered run gets no summary clock (inference from that call site).
- A restarted daemon that keeps heartbeating leaves a skipped row `running`; the server bound needs a stale heartbeat (`server/pkg/db/generated/agent.sql.go:3949-3951`).
- Review F11 also says a server-side cancel during the outage cannot stop the scope (review F11; not re-verified against the current code, so treat as unverified).

Mechanics:

| Item | Detail | Lines |
|---|---|---|
| Parser | Linux only; value `true/1/yes/on` (case-insensitive); `systemd-run` on PATH. Else detached is off. | `server/pkg/agent/dsh_detached.go:86-97` |
| What it enables | The `detached-runtime-v1` capability, the detached launch, and restart recovery | `server/internal/daemon/config.go:660`, `server/internal/daemon/daemon.go:786`, `server/internal/daemon/client.go:219`, `server/pkg/agent/dsh.go:366`, `server/internal/daemon/detached_recover.go:68` |
| Scope | `systemd-run --user --scope --unit multica-dsh-<taskID>` | `server/pkg/agent/dsh_detached.go:48`, `:160` |
| Directory | `<workdir>/.multica-detached/<unit>/` | `server/pkg/agent/dsh_detached.go:44`, `:114` |
| Files | `stdin.jsonl`, `stdout.jsonl`, `stderr.log`, `exit` | `server/pkg/agent/dsh_detached.go:121-124` |
| Reruns | stdin, stdout, stderr are truncated and `exit` is deleted on a new launch of the same task | `server/pkg/agent/dsh_detached.go:126-148` |
| `stdin.jsonl` | Holds the one execute frame. Deleted right after the child starts (the child keeps its own open file). Deleted again on `Close`. | `server/pkg/agent/dsh_detached.go:196-208`, `:228-242`, `server/pkg/agent/dsh.go:462-465` |
| Kept | `stdout.jsonl`, `stderr.log`, `exit` stay as the durable record | `server/pkg/agent/dsh_detached.go:228-231` |

Review F12 says `stdin.jsonl` is kept after the run. That is stale: the code removes it (lines above).

## 6. In-place compaction (review F9)

What happens: the bridge's summarize call runs dsh's own compaction on the parent session (`server/pkg/agent/dsh.go:116-119`). Per review F9, the bridge calls `compactNow` on the parent session and flushes, so the parent's history may be replaced by the summary node. Any later resume of that parent then sees only the summary. (unverified: bridge and dsh not in this repo)

When a later resume of an already-summarized parent can happen:

| Case | Why | Basis |
|---|---|---|
| Unknown end time (before S3-fix H) | Row 2 resumes any reachable session with no end time, summarized or not. | `server/internal/daemon/dsh_session_start.go:179-183`; review F9 |
| Warm-by-clock resume after an early summary | The summary fires at TTL minus margin for the model at arm time. The start decision uses the model and config at claim time. If the TTL or model changed between the two, the decision can still call the session warm. | `server/internal/daemon/dsh_summary.go:399`; `server/internal/daemon/dsh_session_start.go:159`, `:192` (inference) |
| Report latency | The clock starts when the daemon arms it. The server's end time is set when the completion report lands, slightly later. A claim in that gap sees an age under the window after the fire. | `server/internal/daemon/daemon.go:9362`; `server/internal/handler/daemon.go:3526-3527` (inference) |

What to expect:

- The full transcript of that parent may no longer be resumable. The server keeps its rows; the dsh session history is what shrinks (review F9: "Not data loss on the server").
- A normal cold start uses fork-with-seed, not resume, so it does not continue the compacted parent as a live conversation (`server/internal/daemon/dsh_session_start.go:236-238`).
- Whether a refused over-cap summary still leaves the parent compacted is unknown (unverified: bridge not in this repo).
- Whether the flush has completed by the time of a later resume is unknown (unverified: bridge and dsh not in this repo).
- F9 is an open owner decision. The review's suggested fix (compute the summary on a fork or dry run) has not been decided (review F9).

## 7. Reading the decision rows

Both live in `agent_task_queue.result` (JSONB).

| Key | Written by | Notes | Lines |
|---|---|---|---|
| `session_start` | The task-complete callback | A string: the verdict only. Sent for completed runs only; the fail callback has no such field. | `server/internal/daemon/client.go:692-694`, `server/internal/handler/daemon.go:4903-4907`, `:5016`, `server/internal/daemon/daemon.go:6541-6543` |
| `dsh_summary` | `POST /api/daemon/tasks/{taskId}/summary-decision`, merged into `result` | The clock fires long after the run row was written. The row is the run that last armed the clock. | `server/cmd/server/router.go:1632`, `server/internal/handler/task_lifecycle.go:240-266` |

`dsh_summary` fields (`server/internal/handler/task_lifecycle.go:224-232`): `decision`, `session_id`, `model`, `tokens_above_init`, `idle_seconds`, `summary_tokens`, `made_at`, `error`. Values of `decision` are in 3.7. A missing row is a silent no-op (`server/internal/handler/task_lifecycle.go:237-239`); a 404 from an older server is swallowed by the daemon (`server/internal/daemon/dsh_summary.go:775-778`).

Log lines (daemon log):

| Message | Level | Lines |
|---|---|---|
| `dsh session start` (fields `verdict`, `session_id`, `issue_id`, `age`, `ttl`, `margin`, `seed_tokens`, `reason`) | Info | `server/internal/daemon/daemon.go:8744-8753` |
| `dsh seed dropped: ...` | Warn | `server/internal/daemon/daemon.go:9319` |
| `dsh summary clock armed` | Debug | `server/internal/daemon/dsh_summary.go:445` |
| `dsh summary clock fired` | Info | `server/internal/daemon/dsh_summary.go:514` |
| `dsh summary stored beside session` | Info | `server/internal/daemon/dsh_summary.go:570` |
| `dsh summary exceeds the token cap; not stored` | Warn | `server/internal/daemon/dsh_summary.go:547` |
| `dsh summary build failed` / `dsh summary store failed` | Warn | `server/internal/daemon/dsh_summary.go:532`, `:562` |

The session-start **reason** appears only in the `dsh session start` line (the `reason` field). It is not in the row.

Example query (columns `id`, `result`, `created_at` are in `server/migrations/001_init.up.sql:127-140`; `issue_id` is nullable since `server/migrations/033_chat.up.sql:33`):

```sql
SELECT id, created_at,
       result->>'session_start'  AS session_start,
       result->'dsh_summary'     AS dsh_summary
FROM agent_task_queue
WHERE result ? 'session_start' OR result ? 'dsh_summary'
ORDER BY created_at DESC
LIMIT 20;
```

Add `AND issue_id = '<issue uuid>'` to follow one issue. To see where a seed came from, match the id in `session_start` against `dsh_summary.session_id` on the earlier run. The `session_id` and `work_dir` columns exist from `server/migrations/020_task_session.up.sql:6-7`.

## 8. Known doc drift and open items

| Where | What it says | What the code says |
|---|---|---|
| `CLI_AND_DAEMON.md:369-370` | Restart drops pending fires; re-arm on start is deferred to M-139. | Re-arm on start exists (`server/internal/daemon/daemon.go:2181-2184`, `server/internal/daemon/dsh_rearm.go:208-222`). Stale. |
| `CLI_AND_DAEMON.md:362-364` | Trigger is the last request's prompt size minus "its first request's". | It is minus the session's init prefix from `init_prefix.json`, falling back to this run's first request (`server/internal/daemon/dsh_summary.go:495-505`). Stale. |
| `server/internal/daemon/dsh_summary.go:79-80` | Per-model key is "the model id as the run reported it". | The key is the daemon-resolved model (`server/internal/daemon/daemon.go:8698-8704`, passed at `server/internal/daemon/dsh_summary.go:755`). |
| Review F5 | Cap "only logs"; no budget field on the command. | The cap rejects (`server/internal/daemon/dsh_summary.go:544-552`) and `max_tokens` exists (`server/pkg/agent/dsh.go:129-132`). Stale. |
| Review F12 | `stdin.jsonl` kept after the run. | Removed after start (`server/pkg/agent/dsh_detached.go:196-208`). Stale. |
| `CLI_AND_DAEMON.md` | Has no entry for `MULTICA_DETACHED_RUNTIME` or `MESSAGE_SINK` (grep found neither). | Both are read by the daemon (`server/pkg/agent/dsh_detached.go:90`, `server/internal/daemon/config.go:651`). |
| Detached recovery | A restarted daemon watches a surviving scope and reports its recorded outcome. | It does not restore the original live stream or input channel. |

Open items:

- **F9**: in-place compaction of the parent. Owner decision (review F9; section 6).
- **F11**: detached restart recovery uses polling; live input re-attachment is not built. The flag stays off on lane z pending the approved live check (section 5).
- **S3-fix H** (ddvnguyen/multica-x#111): pending PR; until merged, row 2 of 2.2 applies.

