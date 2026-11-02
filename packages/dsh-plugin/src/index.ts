import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { DshHostContext } from "./dsh.js";
import { MoctProxy, MOCT_PREFIX, resolveMoctSettings } from "./moct-proxy.js";
import {
  MulticaProxy,
  PROXY_PREFIX,
  PROXY_WS_PATH,
  resolveSettings,
  sendJson,
} from "./proxy.js";

/**
 * Host face of the Multica panel.
 *
 * It owns one thing: the `/multica` transport the browser island calls. The
 * island itself is the package's `./client` export, which dsh discovers through
 * the `dsh.client` declaration in `package.json`; this half exists so the
 * Multica credential never leaves the dsh process.
 *
 * A row that is missing its server URL or token still activates: the routes
 * answer 503 with the reason, and `/multica/config` carries that reason to the
 * island, instead of the plugin failing and taking the rail row down with it.
 */
export const inject = ["webServer", "connection"];

/** Same path the island reads; kept here so the two faces cannot drift. */
export const CONFIG_PATH = `${PROXY_PREFIX}/config`;

export function apply(ctx: DshHostContext, config?: unknown): void {
  const { settings, problem } = resolveSettings(config);
  const proxy = settings === null ? null : new MulticaProxy(settings);
  // The memory seam is a second transport, configured independently: a lane
  // without a moct-be loses the memory surfaces, not the board.
  const moct = resolveMoctSettings(config, settings);
  const moctProxy = moct.settings === null ? null : new MoctProxy(moct.settings);

  const refusal = (req: IncomingMessage): number | undefined =>
    ctx.connection?.requestRejection(req);

  ctx.effect(() => {
    const offConfig = ctx.webServer.register({
      kind: "exact",
      path: CONFIG_PATH,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        const rejected = refusal(req);
        if (rejected !== undefined) {
          sendJson(res, rejected, { error: "not this dsh session" });
          return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        // Nothing secret here: the island needs the workspace and the realtime
        // path, and the token it must never see.
        sendJson(res, 200, {
          wsPath: PROXY_WS_PATH,
          workspaceSlug: settings?.workspaceSlug ?? "",
          // The "All projects" default folder (M-159); a project addresses its
          // own local_directory resource instead. Not a credential.
          workspaceFolder: settings?.workspaceFolder ?? "",
          problem,
        });
      },
    });

    const offHttp = ctx.webServer.register({
      kind: "prefix",
      path: PROXY_PREFIX,
      handler: async (req, res) => {
        const rejected = refusal(req);
        if (rejected !== undefined) {
          sendJson(res, rejected, { error: "not this dsh session" });
          return;
        }
        if (proxy === null) {
          sendJson(res, 503, { error: problem ?? "multica is not configured" });
          return;
        }
        await proxy.handleHttp(req, res);
      },
    });

    const offUpgrade = ctx.webServer.registerUpgrade({
      path: PROXY_WS_PATH,
      handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const rejected = refusal(req);
        if (rejected !== undefined) {
          socket.write(`HTTP/1.1 ${rejected} Rejected\r\nconnection: close\r\n\r\n`);
          socket.destroy();
          return;
        }
        if (proxy === null) {
          socket.write(
            `HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ error: problem ?? "multica is not configured" })}`,
          );
          socket.destroy();
          return;
        }
        proxy.handleUpgrade(req, socket, head);
      },
    });

    const offMoct = ctx.webServer.register({
      kind: "prefix",
      path: MOCT_PREFIX,
      handler: async (req, res) => {
        const rejected = refusal(req);
        if (rejected !== undefined) {
          sendJson(res, rejected, { error: "not this dsh session" });
          return;
        }
        if (moctProxy === null) {
          sendJson(res, 503, { error: moct.problem ?? "moct is not configured" });
          return;
        }
        await moctProxy.handle(req, res);
      },
    });

    return () => {
      offConfig();
      offHttp();
      offUpgrade();
      offMoct();
    };
  }, "multica: /multica and /moct transports");
}
