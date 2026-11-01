# Freebuff Desktop accounts (M-153)

An agent on a freebuff-desktop runtime can run against a chosen Freebuff
Desktop account, any enabled account, or none. Accounts are per workspace.

## Concepts

- **Account**: a per-workspace record describing one Freebuff Desktop login.
  Fields: `id`, `provider` (`freebuff-desktop`), `label` (unique per
  workspace), `endpoint` (http(s) URL of the desktop server), `credential_ref`,
  `enabled`.
- **credential_ref**: never a secret. A name the daemon resolves on its own
  machine (a state directory, token file path, ...). Multica stores only the
  reference; it is returned to workspace owners and admins only.
- **Account mode** on an agent (`account_mode` / `account_id`):
  - `default`: no account; the runtime's own configuration applies.
  - `specific`: one named account. `account_id` is required.
  - `any`: any enabled account; the server picks one per run.

  Accounts need a freebuff-desktop runtime (a custom runtime profile with
  `protocol_family=codebuddy`). The server rejects any other runtime with 400,
  and switching an agent to such a runtime in the UI resets the account to
  `default`. An account must belong to the agent's workspace, be enabled and
  have provider `freebuff-desktop`.
- **Lease**: each account runs one task at a time. At claim time
  (`ClaimTaskForRuntime`) a task whose account is busy (another task `running`
  or `dispatched` on it) stays queued instead of being claimed. For `any` the
  task waits only while *every* enabled account is busy; otherwise the least
  busy account is chosen and recorded on the task (`agent_task_queue.account_id`).
  A `specific` account that was deleted or disabled fails the task with
  `account_unavailable`. If the lease lookup itself errors, the claim proceeds
  (a bridge-side single-run lock is the backstop).

## API

Base `/api/workspaces/{workspaceId}`. Members read; owners and admins write.

| Method | Path | Notes |
|---|---|---|
| GET | `/accounts` | list; `credential_ref` only for owner/admin |
| POST | `/accounts` | `{label, endpoint?, credential_ref?, enabled?}`; 400 on empty label / non-http(s) endpoint / unknown provider, 409 on duplicate label |
| PATCH/PUT | `/accounts/{accountId}` | partial update; label may not be emptied |
| DELETE | `/accounts/{accountId}` | agents bound to it are demoted to `default` in the same transaction |

Agent create/update accept `account_mode` and `account_id`. An update that
mentions neither leaves the account alone; moving off `specific` clears the id.

Model discovery: `POST /runtimes/{id}/models?account=default|all|<accountId>`.
`all` unions the models of every enabled account. Catalogs are cached per
runtime and scope (bare `runtimeID` for default, `runtimeID:<scope>` otherwise).

## Model discovery contract

The server sends the daemon the account list (id, label, endpoint,
credential_ref) with the model-list request. The daemon runs discovery once per
account with that account's env (`FREEBUFF_DESKTOP_URL`,
`FREEBUFF_DESKTOP_CREDENTIAL_REF`) set on the subprocess only, via
`agent.Command.Env`; it never mutates its own process env. For a freebuff-desktop
command (binary name starting `freebuff-desktop`, or `FREEBUFF_DESKTOP_URL` in
the env) discovery runs `<bridge> --list-models --json` instead of ACP.

Each model in the union carries `account_ids` / `account_labels`; the picker
shows models for the selected scope. One account failing does not hide the
others; only when every account fails is an error returned, naming them.

## Run-time env contract

For `specific`/`any` the daemon injects `FREEBUFF_DESKTOP_URL` and
`FREEBUFF_DESKTOP_CREDENTIAL_REF` under the agent's `custom_env` (custom_env
wins on collision).

## Bridge contract (freebuff fork, `freebuff-desktop-bridge.mjs`)

- Reads `FREEBUFF_DESKTOP_URL` (fallback `FB_URL`, default
  `http://localhost:4320`) and `FREEBUFF_DESKTOP_CREDENTIAL_REF` (fallback
  `FB_HOME`) as its state directory. Without a reference the state lives in
  `FREEBUFF_DESKTOP_STATE_DIR`, else `./.freebuff-desktop`; there are no fixed
  host paths.
- `--list-models --json` prints `{models, supported}` after checking
  `GET /api/auth/status` on that account's endpoint. An unreachable or
  signed-out account exits non-zero with a reason, so it shows up as a failed
  account instead of advertising a model it cannot run. Freebuff Desktop picks
  the model itself, so the list is the single entry `freebuff-desktop`.
- Otherwise it drives the desktop HTTP API and emits codebuddy stream-json on
  stdout, exit 0 on success.
- **Task context (M-199):** the bridge prepends `CODEBUDDY.md` only when it
  creates a thread, including after an expired or invalid resume. The bridge's
  per-run shim keeps the task-scoped Multica identity available to the agent.
- **Session rotation (M-199):** a known or resumed thread is reused only when
  the desktop API reports its creation time as less than four hours ago. A
  stale thread or one with an unknown creation time is abandoned. The bridge
  does not scan project threads for idle conversations. It stores the thread
  ID in account-local `state.json`; state writes are atomic (`renameSync`).
- **System instruction (M-199):** references `CODEBUDDY.md` only, never
  `AGENTS.md`.
- Fork PR: https://github.com/ddvnguyen/freebuff/pull/1 (the `proxy.ts` hunks
  in it are the upstream sync that main was behind on, not bridge changes).

## UI

- Runtime page, for a freebuff-desktop runtime: an **Accounts** card lists the
  workspace's accounts (everyone) and lets owners/admins add, enable/disable
  and delete them.
- Agent create dialog and agent inspector: an **Account** field (runtime
  default / each enabled account / any account), shown only for runtimes that
  can run accounts and once an account exists. The same choice scopes the model
  picker.

## Runtime profile setup

Create a runtime profile with `protocol_family=codebuddy` whose command is the
bridge (or `MULTICA_FREEBUFF_DESKTOP_PATH`). No Go registry change is needed.

## Deploy and upgrade runbook

1. Merge the PR into `multica-moct` (Claude Architect approval + CI green).
2. Open the stack PR `multica-moct → master`; the Owner approves it and the
   deploy.
3. Update the deployed Freebuff Desktop to the slimmer Linux build
   (commit `7807c228ed488496a7bc468aace868368fd605fa` (v0.0.196), ~121 MB RSS vs ~400 MB
   for the previous build). It drops the cloud-account-management endpoints
   Multica never used and keeps everything the bridge needs. Run headless under
   Bun: `FREEBUFF_WEB_SERVER=1 FREEBUFF_WEB_HOST=127.0.0.1 FREEBUFF_WEB_NO_AUTH=1
   bun orchestrator.js`. The Electron binary is ARM64; the orchestrator is
   plain Bun JS and runs on x86_64.
4. Install the reviewed bridge source from
   https://github.com/ddvnguyen/freebuff/pull/5 on the configured
   `freebuff-desktop` path; record the source commit and verify
   `--list-models --json` before deployment.
5. Deploy via `ddvnguyen/moct` `dsh-lane-deploy.yml` from `stable`.
6. Smoke test: add two accounts on the runtime page, bind one agent to each
   and one to `any`; check the model picker per account and one run per agent;
   with one account busy, a second task for it stays queued.

## Known limits

- Discovery runs account by account (sequentially), so `all` takes the sum of
  the per-account times.
- The lease is a check at claim time, not a held lock: two claims for the same
  idle account in the same instant can both pass it. The bridge's own
  single-run handling is the backstop.
- DB-backed handler tests (CRUD authz, validation, lease) run in CI only.
- Memory: each account needs its own orchestrator process. Budget ~0.5 GB per
  account on the daemon host with the previous build, ~0.15 GB with the slimmer
  build. Remove idle accounts to free their process; `any`-mode agents do not
  need every account live.
