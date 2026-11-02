import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "./ws.js";

/**
 * The /multica transport.
 *
 * The island is a browser surface on the dsh origin, and multica-be is a
 * different origin with a bearer credential the browser must not hold. This
 * proxy is the seam: every request under `/multica` and the one WebSocket at
 * `/multica/ws` are re-issued from the host with the personal access token
 * attached, so the browser sees one same origin, no CORS preflight, and no
 * credential it could exfiltrate.
 *
 * Two details are worth knowing before changing it:
 *
 * - Incoming `authorization`, `cookie`, `origin` and `referer` are dropped. The
 *   browser's own credentials belong to dsh, not to Multica, and forwarding a
 *   dsh origin would make multica-be decide CORS for a request that is no
 *   longer cross-origin.
 * - Browsers cannot set headers on a WebSocket upgrade, and the realtime server
 *   authenticates an upgrade from its `Cookie` header or from a first
 *   `{"type":"auth"}` frame. multica-be accepts a personal access token in
 *   `multica_auth` (the same resolver the frame path uses), so the upgrade is
 *   re-issued with that cookie and the island never sends a credential at all.
 */

/** Path prefix that dsh reserves for this plugin. */
export const PROXY_PREFIX = "/multica";
/** The single WebSocket path behind the prefix. */
export const PROXY_WS_PATH = "/multica/ws";
/** The cookie multica-be reads a personal access token from. */
export const AUTH_COOKIE = "multica_auth";

export interface MulticaProxySettings {
  /** multica-be origin, e.g. `http://127.0.0.1:8080`. */
  serverUrl: string;
  /** Personal access token issued by multica-be. */
  token: string;
  /** Workspace the island opens; empty selects the first readable one. */
  workspaceSlug: string;
  /**
   * Default dsh workspace folder for "All projects" (M-159).
   *
   * A project's folder comes from the project's `local_directory` resource
   * instead; this is only the folder the Files/Terminal buttons address when
   * no project is selected. Empty means none: the buttons say what is missing.
   */
  workspaceFolder: string;
}

/** Headers that describe one hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Browser credentials and origin hints that must not reach multica-be. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "origin",
  "referer",
  "host",
]);

/**
 * Validate plugin config into usable settings.
 *
 * A missing server URL or token is a configuration problem, not a crash: the
 * row still activates so the island can show why nothing loaded, and every
 * proxied request answers 503 with the reason.
 */
export function resolveSettings(
  config: unknown,
  env: Record<string, string | undefined> = process.env,
): { settings: MulticaProxySettings | null; problem: string | null } {
  const raw = (config ?? {}) as Record<string, unknown>;
  const serverUrl =
    typeof raw.serverUrl === "string" && raw.serverUrl.trim() !== ""
      ? raw.serverUrl.trim()
      : (env.MULTICA_DSH_SERVER_URL ?? "").trim();
  const token =
    typeof raw.token === "string" && raw.token.trim() !== ""
      ? raw.token.trim()
      : (env.MULTICA_DSH_TOKEN ?? "").trim();

  if (serverUrl === "") return { settings: null, problem: "serverUrl is not set" };
  if (token === "") return { settings: null, problem: "token is not set" };
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { settings: null, problem: "serverUrl must be http or https" };
    }
    return {
      settings: {
        serverUrl: serverUrl.replace(/\/+$/, ""),
        token,
        workspaceSlug:
          typeof raw.workspaceSlug === "string" ? raw.workspaceSlug.trim() : "",
        workspaceFolder:
          typeof raw.workspaceFolder === "string"
            ? raw.workspaceFolder.trim()
            : (env.MULTICA_DSH_WORKSPACE_FOLDER ?? "").trim(),
      },
      problem: null,
    };
  } catch {
    return { settings: null, problem: "serverUrl is not a URL" };
  }
}

/** One forwarded request's upstream target, or null when the path is invalid. */
export function upstreamTarget(
  settings: MulticaProxySettings,
  requestUrl: string,
  prefix: string = PROXY_PREFIX,
): { url: URL; rest: string } | null {
  const parsed = new URL(requestUrl, "http://dsh.invalid");
  if (parsed.pathname !== prefix && !parsed.pathname.startsWith(`${prefix}/`)) {
    return null;
  }
  const rest = parsed.pathname.slice(prefix.length) || "/";
  return { url: new URL(`${settings.serverUrl}${rest}${parsed.search}`), rest };
}

/** A proxy instance bound to one configuration. */
export class MulticaProxy {
  private readonly settings: MulticaProxySettings;
  private readonly sockets = new WebSocketServer({ noServer: true });

  constructor(settings: MulticaProxySettings) {
    this.settings = settings;
  }

  /** Forward one HTTP request under the prefix. */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = upstreamTarget(this.settings, req.url ?? "/");
    if (target === null) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (target.url.pathname === "/ws") {
      // The realtime channel is an upgrade route; a plain request cannot be
      // relayed to it, and answering 400 is clearer than a hung upstream.
      sendJson(res, 400, { error: "use the websocket route" });
      return;
    }
    if (target.rest === "/" || target.rest === "") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    const headers = forwardableRequestHeaders(req.headers);
    headers.authorization = `Bearer ${this.settings.token}`;
    if (req.headers["content-type"] !== undefined) {
      headers["content-type"] = req.headers["content-type"];
    }

    await new Promise<void>((resolve) => {
      const upstream = requestUpstream(target.url, req.method ?? "GET", headers);
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      upstream.on("response", (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, forwardableResponseHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
        upstreamRes.on("end", finish);
        upstreamRes.on("error", () => {
          res.destroy();
          finish();
        });
      });
      upstream.on("error", (error: NodeJS.ErrnoException) => {
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: `multica-be is unreachable (${error.code ?? error.message})`,
          });
        } else {
          res.destroy();
        }
        finish();
      });
      // A closed browser response aborts the upstream request instead of
      // letting it run to completion against multica-be.
      res.on("close", () => {
        upstream.destroy();
        finish();
      });
      req.pipe(upstream);
    });
  }

  /** Relay one browser WebSocket to multica-be, rewriting the auth frame. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = upstreamTarget(this.settings, req.url ?? "/");
    if (target === null || target.rest !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    this.sockets.handleUpgrade(req, socket, head, (client) => {
      this.bridge(client, target.url);
    });
  }

  private bridge(client: WebSocket, target: URL): void {
    // The browser addresses the workspace; no credential of its own goes up.
    target.searchParams.delete("token");
    const upstream = new WebSocket(target, {
      headers: {
        authorization: `Bearer ${this.settings.token}`,
        cookie: `${AUTH_COOKIE}=${this.settings.token}`,
      },
    });

    const queued: Buffer[] = [];
    let upstreamOpen = false;

    // Only codes a peer may receive can be echoed; 1005/1006/1015 describe a
    // local condition and `ws` throws if they are sent.
    const closeBoth = (code?: number, reason?: string): void => {
      const sendable =
        code !== undefined && code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006
          ? code
          : undefined;
      for (const socket of [client, upstream]) {
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          if (sendable === undefined) socket.close();
          else socket.close(sendable, reason);
        }
      }
    };

    client.on("message", (data, isBinary) => {
      if (upstreamOpen) upstream.send(data, { binary: isBinary });
      else queued.push(isBinary ? (data as Buffer) : Buffer.from(data.toString()));
    });

    upstream.on("open", () => {
      upstreamOpen = true;
      for (const frame of queued) upstream.send(frame);
      queued.length = 0;
    });

    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    upstream.on("close", (code, reason) => closeBoth(code, reason.toString()));
    upstream.on("error", () => closeBoth(1011, "multica-be unreachable"));
    client.on("close", (code, reason) => closeBoth(code, reason.toString()));
    client.on("error", () => closeBoth(1011, "client closed"));
  }
}

function requestUpstream(url: URL, method: string, headers: Record<string, string | string[]>) {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port === "" ? undefined : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method,
    headers,
  });
}

function forwardableRequestHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || DROPPED_REQUEST_HEADERS.has(lower)) continue;
    result[lower] = value;
  }
  return result;
}

function forwardableResponseHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    // The upstream body is streamed as-is, so its declared length stands and
    // Node re-frames it; nothing else about the hop survives.
    result[lower] = value;
  }
  return result;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}
