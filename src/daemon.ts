/**
 * fleet-backend daemon — `node dist/daemon.js`.
 *
 * ONE process opens fleet.db ONCE and serves both surfaces: the REST table from
 * backend.py and a streamable-HTTP MCP endpoint at /mcp. This is not an
 * optimisation, it is a correctness requirement:
 *
 *   Turso 0.7.2 takes an EXCLUSIVE per-process lock on the database file. A
 *   second process opening the same fleet.db fails with
 *   "Locking error: Failed locking file". So a per-session stdio fleet-backend
 *   works for exactly one session and is fatal for many, which is why every
 *   harness must talk to a daemon instead of spawning its own.
 *
 * Env:
 *   FLEET_DB_PATH            fleet.db path (default ./fleet.db in cwd)
 *   MCP_ORCH_STATE_DIR       state dir (default domain/config.ts stateRoot())
 *   MCP_ORCH_AUTH_TOKEN      bearer token for the protected REST routes; empty
 *                            disables auth (backwards compatible)
 *   ORCHESTRATION_BIND       listen address (default 127.0.0.1)
 *   ORCHESTRATION_PORT       listen port (default 8099)
 *   FLEET_FORBIDDEN_DB_PATHS comma-separated DB paths this process must never
 *                            open (same guard the stdio entrypoint uses)
 *
 * NOTE: MCP_ORCH_DB_PATH is deliberately IGNORED, exactly as in mcp.ts. The
 * Python service sets it to the live orchestration.sqlite; honouring it here
 * would aim the TS backend at the authoritative ledger. This process opens only
 * FLEET_DB_PATH, so no env value can point it at the live database.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { stateRoot } from "./domain/config.js";
import { forbiddenDbPaths, wireShutdown, type ShutdownDeps } from "./mcp.js";
import { TursoRepository } from "./store/turso-repository.js";
import type { Store } from "./store/store-interface.js";
import { createFleetMcpServer } from "./surfaces/mcp/server.js";
import { createFleetHttpServer, type McpHandler } from "./surfaces/http/router.js";

export interface DaemonEnv {
  host: string;
  port: number;
  dbPath: string;
  stateDir: string;
}

/** backend.py:281-284 — same defaults, so a cutover keeps the same address. */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): DaemonEnv {
  const rawPort = env["ORCHESTRATION_PORT"];
  const parsed = rawPort === undefined || rawPort === "" ? 8099 : Number.parseInt(rawPort, 10);
  return {
    host: env["ORCHESTRATION_BIND"] || "127.0.0.1",
    port: Number.isInteger(parsed) ? parsed : 8099,
    dbPath: path.resolve(env["FLEET_DB_PATH"] || path.join(process.cwd(), "fleet.db")),
    stateDir: stateRoot(),
  };
}

export interface DaemonOptions {
  /** Already-open store. The daemon NEVER opens one per request. */
  store: Store & { close(): Promise<void> };
  host?: string;
  port?: number;
  token?: string;
  deps?: ShutdownDeps;
  log?: (message: string) => void;
}

export interface DaemonHandle {
  server: Server;
  port: number;
  url: string;
  /** Closes the listener then the store, exactly once. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * The /mcp hand-off.
 *
 * STATELESS: sessionIdGenerator is undefined, so every request gets its own
 * transport and no session table exists to leak. That is a deliberate
 * divergence from FastMCP's stateful default: a stateful daemon needs a session
 * map with TTL eviction, and an unbounded one is a memory leak under the unit's
 * MemoryMax=512M. Stateless costs server-initiated notifications, which this
 * backend does not use. The store is shared across all of them — that is the
 * point of the daemon.
 */
export function createMcpHandler(store: Store, log?: (message: string) => void): McpHandler {
  return async (req, res) => {
    const server = createFleetMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Close both when the client hangs up. Without this, every abandoned SSE
    // stream pins a transport for the life of the daemon.
    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    try {
      if (req.method === "POST") {
        // node:http does not parse bodies and this transport does not read the
        // Node stream once converted, so the JSON-RPC message is parsed here.
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          parsed = raw.length === 0 ? undefined : JSON.parse(raw);
        } catch (exc) {
          // JSON-RPC parse error, per the spec's -32700.
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32700, message: `Parse error: ${(exc as Error).message}` },
              id: null,
            }),
          );
          return true;
        }
        await transport.handleRequest(req, res, parsed);
        return true;
      }
      await transport.handleRequest(req, res);
      return true;
    } catch (exc) {
      log?.(`fleet-backend: /mcp request failed: ${String(exc)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          }),
        );
      } else {
        res.end();
      }
      return true;
    }
  };
}

/**
 * Boot the listener. Split from main() so a test can start a real daemon on an
 * ephemeral port — an auto-executing entrypoint is untested by construction, and
 * a dropped line in it then fails silently in production.
 */
export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const { store, deps = {}, log } = options;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8099;

  const server = createFleetHttpServer({
    store,
    token: options.token,
    mcp: createMcpHandler(store, log),
    log,
  });

  // Idempotent: wireShutdown can be reached by SIGTERM and SIGINT, and the
  // store must be closed exactly once.
  let closed: Promise<void> | null = null;
  const closeAll = (): Promise<void> => {
    closed ??= (async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    })();
    return closed;
  };

  // Reuse the stdio entrypoint's shutdown wiring rather than writing a second
  // one: same signal set, same bound defaults, same exit code, one place to
  // reason about. The transport shim carries no onclose — this process has no
  // stdio pipe to lose — so stdin-EOF cannot strand it.
  wireShutdown({}, { close: closeAll }, deps);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const actual = (server.address() as AddressInfo).port;
  return {
    server,
    port: actual,
    url: `http://${host}:${actual}`,
    close: closeAll,
  };
}

async function main(): Promise<void> {
  const env = resolveEnv();
  const forbidden = forbiddenDbPaths();
  if (forbidden.includes(env.dbPath)) {
    console.error(
      `fleet-backend: FATAL: FLEET_DB_PATH resolves to a forbidden database: ${env.dbPath}`,
    );
    process.exit(2);
  }
  // The one and only open. A request never constructs a repository.
  const store = await TursoRepository.open(env.stateDir, env.dbPath);
  const daemon = await startDaemon({
    store,
    host: env.host,
    port: env.port,
    log: (message) => console.error(message),
  });
  console.error(
    `fleet-backend: daemon listening on ${daemon.url} (db=${env.dbPath} state=${env.stateDir})`,
  );
}

// Run only when this module IS the entrypoint. Importing it (tests, harnesses)
// must not open fleet.db or grab a port as a side effect.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((exc) => {
    console.error(`fleet-backend: fatal: ${(exc as Error).message}`);
    process.exit(1);
  });
}
