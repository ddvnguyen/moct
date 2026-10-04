/**
 * Wire shapes for the REST surface. Every status code and error string here is
 * transcribed from backend.py — a thin stdio client parses these, so the strings
 * are a contract, not presentation.
 */
import type { ServerResponse } from "node:http";
import { excRepr } from "../../domain/models.js";
import { UNAUTHORIZED_ERROR, UNAUTHORIZED_HINT } from "./auth.js";

export const UNKNOWN_TOOL_HINT = "GET /schema lists tools";
export const BAD_ARGUMENTS_HINT = "GET /schema for inputSchema";
/** backend.py:149 spells this "check backend/journal/logs". */
export const UNEXPECTED_HINT = "check backend/journal/logs";
export const URI_REQUIRED_HINT =
  "POST {uri: 'orchestration://project/{pid}/summary'} or GET ?uri=...";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** backend.py:72-77. Flat {ok,error,hint} — NOT the {error:{code,message}} config shape. */
export function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, { ok: false, error: UNAUTHORIZED_ERROR, hint: UNAUTHORIZED_HINT });
}

/** backend.py:132-133. */
export function sendUnknownTool(res: ServerResponse, name: string): void {
  sendJson(res, 404, { ok: false, error: `unknown tool: ${name}`, hint: UNKNOWN_TOOL_HINT });
}

/** backend.py:139-140. */
export function sendBodyNotObject(res: ServerResponse): void {
  sendJson(res, 400, { ok: false, error: "body must be a JSON object" });
}

/** backend.py:145-146 — raised by Python's TypeError on a bad kwarg / missing arg. */
export function sendBadArguments(res: ServerResponse, name: string, detail: string): void {
  sendJson(res, 400, {
    ok: false,
    error: `bad arguments for ${name}: ${detail}`,
    hint: BAD_ARGUMENTS_HINT,
  });
}

/** backend.py:148-149 — last-resort boundary, same as the stdio server's. */
export function sendUnexpected(res: ServerResponse, exc: unknown, hint = UNEXPECTED_HINT): void {
  sendJson(res, 500, { ok: false, error: `unexpected: ${excRepr(exc)}`, hint });
}

/** backend.py:200-201 — resources_read's 500 carries NO hint. */
export function sendUnexpectedNoHint(res: ServerResponse, exc: unknown): void {
  sendJson(res, 500, { ok: false, error: `unexpected: ${excRepr(exc)}` });
}

/** backend.py:193-196. */
export function sendUriRequired(res: ServerResponse): void {
  sendJson(res, 400, { ok: false, error: "uri is required", hint: URI_REQUIRED_HINT });
}

/** backend.py:216-224 — {error:{code,message}} with the position-lookup status map. */
const CONFIG_STATUS: Record<string, number> = { POSITION_NOT_FOUND: 404, POSITION_EXISTS: 409 };

export function sendConfigResult(res: ServerResponse, result: Record<string, unknown>): void {
  const error = result["error"];
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const code = String((error as Record<string, unknown>)["code"] ?? "INVALID_FIELD");
    sendJson(res, CONFIG_STATUS[code] ?? 400, result);
    return;
  }
  sendJson(res, 200, result);
}

/** backend.py:227-231. */
export function sendConfigCrash(res: ServerResponse, exc: unknown): void {
  sendJson(res, 500, { error: { code: "INTERNAL", message: `unexpected: ${excRepr(exc)}` } });
}

/** backend.py:237-240 — reached when request.json() raises. */
export function sendConfigBadJson(res: ServerResponse): void {
  sendJson(res, 400, { error: { code: "INVALID_FIELD", message: "body must be valid JSON" } });
}
