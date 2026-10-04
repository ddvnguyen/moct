/**
 * POST /tools/{name} — backend.py:128-149.
 *
 * Deliberately does NOT run validateToolArgs. Python's REST layer calls
 * `fn(_store(), **body)` with no schema check, so the ONLY 400s it can produce
 * come from CPython argument binding (an unexpected keyword argument, or a
 * missing required one). A wrong *type* slips through binding and surfaces as
 * the 500 instead. Validating the schema here would answer 400 where the
 * authoritative service answers 500, so the binding rules are reproduced
 * exactly and nothing more.
 *
 * Dispatch goes through the T0 registry seam, not the switch: resolveTool owns
 * the 404 lookup and runTool owns the call, so a registered domain tool is
 * reachable over REST without editing anything here.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../../store/store-interface.js";
import { resolveTool, runTool } from "../../tools/registry.js";
import {
  sendBadArguments,
  sendBodyNotObject,
  sendUnexpected,
  sendUnknownTool,
} from "./responses.js";

interface SchemaView {
  properties?: Record<string, unknown>;
  required?: string[];
}

/**
 * The CPython TypeError text a bad `fn(**body)` call would raise, or null when
 * the call binds cleanly.
 */
export function bindingError(
  name: string,
  schema: SchemaView,
  args: Record<string, unknown>,
): string | null {
  const known = Object.keys(schema.properties ?? {});
  for (const key of Object.keys(args)) {
    if (!known.includes(key)) return `${name}() got an unexpected keyword argument '${key}'`;
  }
  const missing = (schema.required ?? []).filter((key) => !(key in args));
  if (missing.length === 0) return null;
  if (missing.length === 1)
    return `${name}() missing 1 required positional argument: '${missing[0]}'`;
  const quoted = missing.map((key) => `'${key}'`);
  const listed =
    missing.length === 2
      ? `${quoted[0]} and ${quoted[1]}`
      : `${quoted.slice(0, -1).join(", ")}, and ${quoted[missing.length - 1]}`;
  return `${name}() missing ${missing.length} required positional arguments: ${listed}`;
}

/** Reads the body the way backend.py does: a parse failure yields {}, never a 400. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function handleCallTool(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  name: string,
): Promise<void> {
  const spec = resolveTool(name);
  if (spec === undefined) {
    sendUnknownTool(res, name);
    return;
  }
  const body = await readBody(req);
  if (!isPlainObject(body)) {
    sendBodyNotObject(res);
    return;
  }
  const bindError = bindingError(name, spec.inputSchema as SchemaView, body);
  if (bindError !== null) {
    sendBadArguments(res, name, bindError);
    return;
  }
  try {
    const result = await runTool(store, name, body);
    // A tool result is returned verbatim, status 200 — including ok:false bodies.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result ?? null));
  } catch (exc) {
    sendUnexpected(res, exc);
  }
}
