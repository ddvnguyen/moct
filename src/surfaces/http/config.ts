/**
 * /config routes — backend.py:233-277.
 *
 * backend.py re-reads state_root() per request rather than caching it, so a
 * daemon picks up an MCP_ORCH_STATE_DIR change only by restarting. Matched
 * here by resolving the state dir per request too: the config file is the
 * owner's, and a cached path would silently write the wrong file.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { stateRoot } from "../../domain/config.js";
import type { Store } from "../../store/store-interface.js";
import { getConfig, postPosition, putPosition, putTimings } from "./config-api.js";
import { sendConfigBadJson, sendConfigCrash, sendConfigResult } from "./responses.js";

/** backend.py:233-240 — a parse failure is the only reason this 400 exists. */
async function readConfigBody(req: IncomingMessage): Promise<{ body: unknown; bad: boolean }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    return { body: raw.length === 0 ? null : JSON.parse(raw), bad: false };
  } catch {
    return { body: null, bad: true };
  }
}

export async function handleConfigRead(res: ServerResponse): Promise<void> {
  try {
    sendConfigResult(res, getConfig(stateRoot()));
  } catch (exc) {
    sendConfigCrash(res, exc);
  }
}

export async function handleConfigPutPosition(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  role: string,
): Promise<void> {
  try {
    const { body, bad } = await readConfigBody(req);
    if (bad) {
      sendConfigBadJson(res);
      return;
    }
    sendConfigResult(res, await putPosition(store, stateRoot(), role, body));
  } catch (exc) {
    sendConfigCrash(res, exc);
  }
}

export async function handleConfigCreatePosition(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<void> {
  try {
    const { body, bad } = await readConfigBody(req);
    if (bad) {
      sendConfigBadJson(res);
      return;
    }
    sendConfigResult(res, await postPosition(store, stateRoot(), body));
  } catch (exc) {
    sendConfigCrash(res, exc);
  }
}

export async function handleConfigPutTimings(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<void> {
  try {
    const { body, bad } = await readConfigBody(req);
    if (bad) {
      sendConfigBadJson(res);
      return;
    }
    sendConfigResult(res, await putTimings(store, stateRoot(), body));
  } catch (exc) {
    sendConfigCrash(res, exc);
  }
}
