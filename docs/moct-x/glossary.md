# Glossary

Verified against `multica-moct` at `ac8a04078`; external deployment facts are
identified in the linked pages.

| Term | Meaning |
|---|---|
| Work plane | Multica's issues, tasks, agents and related state; see [architecture](architecture.md). |
| Memory plane | MOCT memory records accessed by the HTTP seam; see [seam](seam.md). |
| Seam | The client, daemon hooks and MCP server connecting a task to MOCT (`server/internal/moct/`, `server/internal/daemon/moct_memory.go`, `server/internal/moctmcp/`). |
| Lane | A deployment environment; lane z's provisioner is documented in [operations](operations.md). |
| Island | The separate React tree mounted in dsh's shadow root (`packages/dsh-plugin/src/client/island.ts:82,139`). |
| Decision | A projection of source-owned question, plan, native question or status wait (`server/pkg/db/queries/decisions.sql:38-55`). |
| Ref | A prefixed cross-service identifier (`server/internal/moct/refs.go:7-27`). |

## Unverified

- Live lane and MOCT service behavior were not exercised; see the linked pages.
