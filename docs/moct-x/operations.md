# Operations

Verified against `multica-moct` at `ac8a04078`. Consult
[the lane runbook](../../deploy/dsh-z/README.md) for prerequisites and current
operator procedure; deployment changes a live lane.

Lane z is the proving deployment described by `deploy/dsh-z/README.md:1-23`.
The repository records its own backend, MOCT and daemon configuration in
`deploy/dsh-z/dsh-z.env`; production dsh-x is outside the scope of that script.
The lane deploy command is:

```sh
bash deploy/dsh-z/deploy.sh
```

The script builds releases, migrates, installs units and performs health checks
(`deploy/dsh-z/deploy.sh:118,207,262,599-603`). The lane helper strips
`MULTICA_*` environment variables before invoking the CLI
(`deploy/dsh-z/lane-cli.sh:5-14`); use it for lane CLI operations.

## Configuration and health

Names only: `DATABASE_URL`, `MULTICA_BIND_HOST` configure the server
(`server/cmd/server/main.go:375,395`); `MOCT_BASE_URL` and `MESSAGE_SINK`
configure daemon memory and transcript behavior (`server/internal/daemon/config.go:644-653`).
`MULTICA_DSH_SERVER_URL` and `MULTICA_DSH_TOKEN` are proxy fallbacks
(`packages/dsh-plugin/src/proxy.ts:90-94`). Lane secrets and other settings
are named in `deploy/dsh-z/dsh-z.env` and the deploy script; do not publish values.

The Multica server exposes `/health`, `/readyz` and `/healthz`
(`server/cmd/server/router.go:1447-1449`). The deploy checks the Multica
health endpoints and MOCT `/team/v1/health` (`deploy/dsh-z/deploy.sh:599-603`).

## Common failures

- **Missing memory:** inspect the init-context memory reason and daemon log;
  malformed URL or inject errors leave the run without memory
  (`server/internal/daemon/moct_memory.go:82-106`).
- **Plugin installation fails or affects another lane:** the lane runbook
  describes the historical postinstall cross-lane hazard and the profile's
  pnpm shim (`deploy/dsh-z/README.md:68-84`). The repo pins pnpm 10.28.2
  (`package.json:38`); the runbook records a web profile built with pnpm 12.14.0
  (`deploy/dsh-z/README.md:78-84`). Follow the runbook rather than sharing a
  profile's installation with another lane.
- **Backend is not ready:** deploy waits for readiness and prints its unit's
  journal tail on failure (`deploy/dsh-z/deploy.sh:324-329`).
- **Wrong lane:** use the lane CLI wrapper and inspect its target before any
  state-changing operation (`deploy/dsh-z/lane-cli.sh:5-14`).

## Unverified

- Live lane state, credentials, production topology and current profile package
  manager version were not inspected. The deployment command was not run.
- CI behavior and external services were not re-exercised for this document.
