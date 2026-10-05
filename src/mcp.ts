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
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { stateRoot } from "./domain/config.js";
import { createFleetMcpServer } from "./surfaces/mcp/server.js";
import { TursoRepository } from "./store/turso-repository.js";

/**
 * DB paths this process must never open. Shared with daemon.ts so both
 * entrypoints enforce ONE guard — a second copy would be a second rule, and
 * the one that drifts is the one nobody reads.
 */
export function forbiddenDbPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["FLEET_FORBIDDEN_DB_PATHS"] || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => path.resolve(s));
}

export interface ShutdownTarget {
  close(): Promise<void>;
}

export interface ShutdownDeps {
  /** Exit hook; defaults to process.exit. */
  exit?: (code: number) => void;
  /** Signal registration hook; defaults to process.on. */
  registerSignal?: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
}

/**
 * Wire every shutdown path to one closer: stdin-EOF (transport.onclose),
 * SIGTERM, SIGINT. Extracted from main() so the wiring is unit-testable — a
 * literal assignment inside an auto-executing entrypoint is untested by
 * construction, and a dropped line then fails silently.
 */
export function wireShutdown(
  transport: { onclose?: (() => void) | null },
  store: ShutdownTarget,
  deps: ShutdownDeps = {},
): void {
  // bind(): these are process/EventEmitter methods — passing them unbound means
  // `this` is undefined at call time and Node throws on `this._events`.
  const exit = deps.exit ?? process.exit.bind(process);
  const registerSignal = deps.registerSignal ?? process.on.bind(process);
  const shutdown = async () => {
    try {
      await store.close();
    } catch {
      /* best-effort: a failed close must not strand the process */
    }
    exit(0);
  };
  registerSignal("SIGTERM", () => void shutdown());
  registerSignal("SIGINT", () => void shutdown());
  // stdin-EOF: the host closed the pipe — exit promptly instead of lingering
  // with fleet.db held open (Turso lock release is async via store.close()).
  // The MCP SDK Transport contract (sdk 1.29) exposes `onclose?: () => void`
  // and no addEventListener, so the rule below is a false positive here.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onclose = () => void shutdown();
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
  wireShutdown(transport, store);
  await server.connect(transport);
  console.error(`fleet-backend: serving MCP stdio (db=${dbPath} state=${stateDir})`);
}

// Run only when this module IS the entrypoint. Importing it (tests, harnesses)
// must not open fleet.db, grab stdio, or install process handlers as a side effect.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((exc) => {
    console.error(`fleet-backend: fatal: ${(exc as Error).message}`);
    process.exit(1);
  });
}
