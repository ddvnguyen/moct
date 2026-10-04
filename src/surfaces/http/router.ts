/**
 * The REST surface — backend.py's route table (backend.py:285-296) on
 * node:http, plus the /mcp hand-off point the daemon fills in.
 *
 * Route order and status codes are the contract. The auth gate runs before
 * routing, exactly as AuthMiddleware wraps the whole Starlette app, so an
 * unauthenticated caller learns nothing about which routes exist.
 *
 * Two deliberate parity notes:
 *  - /mcp is NOT auth-protected, because backend.py's _is_protected_path does
 *    not match it. That is faithful to the service being replaced, and it is a
 *    real exposure if the daemon is ever bound off loopback: /mcp executes
 *    tools. Pinned by a test so the behaviour is a decision, not an oversight,
 *    and flagged for the owner in the B2 report. The bind default is 127.0.0.1.
 *  - An unmatched path answers Starlette's {"detail":"Not Found"} / 404 and a
 *    wrong method answers {"detail":"Method Not Allowed"} / 405, because that is
 *    what the Python service returns for the same request.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authToken, authorize } from "./auth.js";
import {
  handleConfigCreatePosition,
  handleConfigPutPosition,
  handleConfigPutTimings,
  handleConfigRead,
} from "./config.js";
import { handleHealth, handleSchema } from "./health.js";
import { handleResourcesList, handleResourcesRead } from "./resources.js";
import { sendJson, sendUnauthorized } from "./responses.js";
import { handleCallTool } from "./tools.js";
import type { Store } from "../../store/store-interface.js";

/**
 * Installed by the daemon to serve the streamable-HTTP MCP transport. Returns
 * true when it took ownership of the request; the router then touches nothing.
 */
export type McpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface HttpSurfaceOptions {
  store: Store;
  /** Bearer token; defaults to MCP_ORCH_AUTH_TOKEN. Empty disables auth. */
  token?: string;
  mcp?: McpHandler;
  log?: (message: string) => void;
}

const TOOLS_PREFIX = "/tools/";
const POSITION_ROLE_PREFIX = "/config/positions/";

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { detail: "Not Found" });
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { detail: "Method Not Allowed" });
}

export function createFleetHttpServer(options: HttpSurfaceOptions): Server {
  const { store, log } = options;
  const token = options.token ?? authToken();

  const server = createServer((req, res) => {
    void route(req, res).catch((exc: unknown) => {
      // A handler that escapes its own try/catch must not take the process
      // down: this is a long-lived daemon holding fleet.db.
      log?.(`fleet-backend: unhandled request failure: ${String(exc)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { detail: "Internal Server Error" });
      } else {
        res.end();
      }
    });
  });

  /** /resources* — split out so `route` stays readable and under the complexity cap. */
  async function routeResources(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    query: URLSearchParams,
  ): Promise<boolean> {
    if (path === "/resources" || path === "/resources/list") {
      if (method !== "GET") methodNotAllowed(res);
      else await handleResourcesList(res, store);
      return true;
    }
    if (path === "/resources/read") {
      if (method !== "GET" && method !== "POST") methodNotAllowed(res);
      else await handleResourcesRead(req, res, store, query.get("uri"));
      return true;
    }
    return false;
  }

  /** /config* */
  async function routeConfig(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
  ): Promise<boolean> {
    if (path === "/config") {
      if (method !== "GET") methodNotAllowed(res);
      else await handleConfigRead(res);
      return true;
    }
    if (path === "/config/positions") {
      if (method !== "POST") methodNotAllowed(res);
      else await handleConfigCreatePosition(req, res, store);
      return true;
    }
    if (path.startsWith(POSITION_ROLE_PREFIX)) {
      if (method !== "PUT") {
        methodNotAllowed(res);
        return true;
      }
      const role = decodeURIComponent(path.slice(POSITION_ROLE_PREFIX.length));
      // A nested segment is not a role; /config/positions is the collection.
      if (role.length === 0 || role.includes("/")) notFound(res);
      else await handleConfigPutPosition(req, res, store, role);
      return true;
    }
    if (path === "/config/timings") {
      if (method !== "PUT") methodNotAllowed(res);
      else await handleConfigPutTimings(req, res, store);
      return true;
    }
    return false;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (!authorize(path, req.headers.authorization, token).ok) {
      sendUnauthorized(res);
      return;
    }

    // /mcp first: it owns its own transport and its own body handling. The
    // match is EXACT because the Python app mounts streamable_http_app() at
    // /mcp — a Starlette mount does not answer sub-paths, so /mcp/nope is a 404
    // there and must be here. Forwarding the prefix would hand sub-paths to the
    // transport, which answers 406 for a missing Accept header.
    if (path === "/mcp") {
      if (options.mcp !== undefined && (await options.mcp(req, res))) return;
      notFound(res);
      return;
    }

    if (path === "/health") {
      if (method !== "GET") methodNotAllowed(res);
      else await handleHealth(res, store);
      return;
    }

    if (path === "/schema") {
      if (method !== "GET") methodNotAllowed(res);
      else handleSchema(res);
      return;
    }

    if (path.startsWith(TOOLS_PREFIX)) {
      if (method !== "POST") {
        methodNotAllowed(res);
        return;
      }
      const name = decodeURIComponent(path.slice(TOOLS_PREFIX.length));
      if (name.length === 0 || name.includes("/")) notFound(res);
      else await handleCallTool(req, res, store, name);
      return;
    }

    if (await routeResources(req, res, path, method, url.searchParams)) return;
    if (await routeConfig(req, res, path, method)) return;

    notFound(res);
  }

  return server;
}
