# moct

MOCT fleet/orchestration backend (HTTP surfaces on 127.0.0.1 plus a stdio MCP server) and the
deploy pipeline that ships it.

- **Deploy and rollback runbook**: [docs/deploy-runbook.md](docs/deploy-runbook.md) - what the
  deploy does step by step, how rollback behaves with and without a previous release, the
  `current` symlink entrypoint rule, and the commands that verify a live deploy by hand.
- **Tool schemas**: [docs/schema.md](docs/schema.md).

## Layout

```
src/daemon.ts        HTTP daemon entrypoint      src/mcp.ts   stdio MCP entrypoint
src/entrypoint.ts    the ONE entrypoint guard (realpath, shared by both entrypoints)
scripts/deploy/      the deploy script (package, rehearse, back up, switch, smoke, rollback)
.github/workflows/   moct-x-deploy (Pipeline 1, live) and moct-prod-deploy (Pipeline 3, skeleton)
```
