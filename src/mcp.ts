/**
 * fleet-backend MCP stdio entrypoint — `node dist/mcp.js`.
 *
 * Env:
 *   FLEET_DB_PATH            path to fleet.db (default: ./fleet.db in cwd)
 *   MCP_ORCH_STATE_DIR       state dir (default: <repo>/orchestration/state/mcp via domain/config.ts stateRoot())
 *   MCP_ORCH_SUMMARY_PATH    orchestration.md destination (default: <repo>/orchestration.md)
 *   MCP_ORCH_LESSONS_DIR     lessons dir (default: <repo>/lessons)
 *   MCP_ORCH_REFERENCES_DIR  references dir (default: <repo>/references)
 *   FLEET_REPO_ROOT          repo root for orchestrator prompt/cwd resolution
 *   FLEET_FORBIDDEN_DB_PATHS comma-separated DB paths this process must never
 *                            open (parity harness sets the live ledger path)
 *
 * NOTE: MCP_ORCH_DB_PATH is deliberately IGNORED — the TS backend opens only
 * FLEET_DB_PATH, so it can never be pointed at the live Python ledger by env.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "node:path";
import { stateRoot } from "./domain/config.js";
import { createFleetMcpServer } from "./surfaces/mcp/server.js";
import { TursoRepository } from "./store/turso-repository.js";

function forbiddenDbPaths(): string[] {
  const raw = process.env["FLEET_FORBIDDEN_DB_PATHS"] || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => path.resolve(s));
}

async function main(): Promise<void> {
  const dbPath = path.resolve(process.env["FLEET_DB_PATH"] || path.join(process.cwd(), "fleet.db"));
  // Single default: domain/config.ts stateRoot() (MCP_ORCH_STATE_DIR override
  // wins, else <repo root>/orchestration/state/mcp). mcp.ts holds no parallel fallback.
  const stateDir = stateRoot();
  const forbidden = forbiddenDbPaths();
  if (forbidden.includes(dbPath)) {
    console.error(
      `fleet-backend: FATAL: FLEET_DB_PATH resolves to a forbidden database: ${dbPath}`,
    );
    process.exit(2);
  }
  const store = await TursoRepository.open(stateDir, dbPath);
  const server = createFleetMcpServer(store);
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    try {
      await store.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  await server.connect(transport);
  console.error(`fleet-backend: serving MCP stdio (db=${dbPath} state=${stateDir})`);
}

main().catch((exc) => {
  console.error(`fleet-backend: fatal: ${(exc as Error).message}`);
  process.exit(1);
});
