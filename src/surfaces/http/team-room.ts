/**
 * /team/v1 — the Team Room HTTP surface (contract v0.3 §2). Loopback only, no
 * auth (human decision: "no auth need for now"). Every route is additive: the
 * Python /tools, /resources and /config surfaces are untouched.
 *
 * Validation failures answer 400 with {ok:false,error}. Conflicts answer 409
 * with {ok:false,error,code}, and the code is stable so the client can branch on it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./responses.js";
import { TeamRoomStore, type OperationRecord, type SessionRunRow, type SummaryRow } from "../../team-room/store.js";
import { SCHEMA_VERSION } from "../../store/schema.js";
import { routeMemory } from "./team-memory.js";

export const TEAM_PREFIX = "/team/v1";
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_PAGE = 500;
const MAX_PAGE = 1000;
const STREAM_POLL_MS = 1000;

type Json = Record<string, unknown>;

class BadRequest extends Error {}

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest("body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequest(`${field} is required`);
  }
  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new BadRequest(`${field} must be a positive integer`);
  }
  return value;
}

function nonNegativeInt(value: unknown, field: string, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BadRequest(`${field} must be a non-negative integer`);
  }
  return value;
}

function queryInt(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BadRequest(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseOperationBody(body: unknown): { workspaceId: string; record: OperationRecord } {
  if (!isPlainObject(body)) throw new BadRequest("body must be a JSON object");
  const workspaceId = requireString(body["workspaceId"], "workspaceId");
  const record = body["record"];
  if (!isPlainObject(record)) throw new BadRequest("record must be an object");
  requirePositiveInt(record["sequence"], "record.sequence");
  requireString(record["operationId"], "record.operationId");
  requireString(record["kind"], "record.kind");
  return { workspaceId, record: record as OperationRecord };
}

function parseSessionRun(body: unknown): SessionRunRow {
  if (!isPlainObject(body)) throw new BadRequest("body must be a JSON object");
  const model = body["model"];
  if (!isPlainObject(model)) throw new BadRequest("model must be an object");
  const state = body["state"] ?? "warm";
  if (state !== "warm" && state !== "cold" && state !== "closed") {
    throw new BadRequest("state must be warm, cold or closed");
  }
  const threadRefs = body["threadRefs"] ?? [];
  if (!Array.isArray(threadRefs) || !threadRefs.every((ref) => typeof ref === "string")) {
    throw new BadRequest("threadRefs must be an array of strings");
  }
  return {
    sessionId: requireString(body["sessionId"], "sessionId"),
    memberId: requireString(body["memberId"], "memberId"),
    ...(typeof body["parentSessionId"] === "string" ? { parentSessionId: body["parentSessionId"] } : {}),
    threadRefs: threadRefs as string[],
    startedAt: requireString(body["startedAt"], "startedAt"),
    ...(typeof body["endedAt"] === "string" ? { endedAt: body["endedAt"] } : {}),
    tokensIn: nonNegativeInt(body["tokensIn"], "tokensIn"),
    tokensOut: nonNegativeInt(body["tokensOut"], "tokensOut"),
    cacheReadTokens: nonNegativeInt(body["cacheReadTokens"], "cacheReadTokens"),
    cacheWriteTokens: nonNegativeInt(body["cacheWriteTokens"], "cacheWriteTokens"),
    toolCalls: nonNegativeInt(body["toolCalls"], "toolCalls"),
    runMs: nonNegativeInt(body["runMs"], "runMs"),
    model: {
      provider: requireString(model["provider"], "model.provider"),
      model: requireString(model["model"], "model.model"),
    },
    ...(typeof body["lastAssistantAt"] === "string" ? { lastAssistantAt: body["lastAssistantAt"] } : {}),
    state,
  };
}

function parseSummary(threadRef: string, body: unknown): SummaryRow {
  if (!isPlainObject(body)) throw new BadRequest("body must be a JSON object");
  const trigger = body["trigger"];
  if (trigger !== "rolling" && trigger !== "wrapup") {
    throw new BadRequest("trigger must be rolling or wrapup");
  }
  return {
    threadRef,
    generation: requirePositiveInt(body["generation"], "generation"),
    trigger,
    text: requireString(body["text"], "text"),
    coversThroughSequence: nonNegativeInt(body["coversThroughSequence"], "coversThroughSequence"),
    tokens: nonNegativeInt(body["tokens"], "tokens"),
    model: typeof body["model"] === "string" ? body["model"] : "",
    at: requireString(body["at"], "at"),
  };
}

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof BadRequest) sendJson(res, 400, { ok: false, error: error.message });
  else sendJson(res, 500, { ok: false, error: "internal error" });
}

/** Routes under /team/v1. Returns false when the path is not a Team Room route. */
export async function routeTeam(
  req: IncomingMessage,
  res: ServerResponse,
  team: TeamRoomStore,
  url: URL,
): Promise<boolean> {
  const path = url.pathname.slice(TEAM_PREFIX.length);
  if (!url.pathname.startsWith(`${TEAM_PREFIX}/`) && url.pathname !== TEAM_PREFIX) return false;
  const method = req.method ?? "GET";
  try {
    await dispatch(req, res, team, url, path, method);
  } catch (exc) {
    fail(res, exc);
  }
  return true;
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  team: TeamRoomStore,
  url: URL,
  path: string,
  method: string,
): Promise<void> {
  if (path === "/health") {
    if (method !== "GET") return methodNotAllowed(res);
    return sendJson(res, 200, { ok: true, schema: SCHEMA_VERSION, dbPath: team.dbPath });
  }

  if (path === "/operations") {
    if (method === "POST") return postOperation(req, res, team);
    if (method === "GET") return getOperations(res, team, url.searchParams);
    return methodNotAllowed(res);
  }

  if (path === "/operations/head") {
    if (method !== "GET") return methodNotAllowed(res);
    const workspaceId = requireString(url.searchParams.get("workspaceId"), "workspaceId");
    return sendJson(res, 200, { sequence: await team.head(workspaceId) });
  }

  if (path === "/backup") {
    if (method !== "POST") return methodNotAllowed(res);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const file = await team.backup(stamp);
    return sendJson(res, 201, { ok: true, path: file });
  }

  if (path === "/stream") {
    if (method !== "GET") return methodNotAllowed(res);
    return streamOperations(req, res, team, url.searchParams);
  }

  if (path === "/session-runs") {
    if (method === "POST") {
      await team.upsertSessionRun(parseSessionRun(await readJsonBody(req)));
      return sendJson(res, 200, { ok: true });
    }
    if (method !== "GET") return methodNotAllowed(res);
    return getSessionRuns(res, team, url.searchParams);
  }

  if (path === "/usage") {
    if (method !== "GET") return methodNotAllowed(res);
    return getUsage(res, team, url.searchParams);
  }

  if (path === "/bindings") {
    if (method !== "GET") return methodNotAllowed(res);
    return getBindings(res, team, url.searchParams);
  }

  if (await routeMemory(req, res, team.memory, url, path, method, () => readJsonBody(req))) return;

  if (path.startsWith("/thread-summaries/")) {
    const threadRef = decodeURIComponent(path.slice("/thread-summaries/".length));
    if (threadRef.length === 0 || threadRef.includes("/")) return notFound(res);
    if (method === "PUT") return putSummary(req, res, team, threadRef);
    if (method !== "GET") return methodNotAllowed(res);
    const latest = await team.latestSummary(threadRef);
    if (latest === undefined) return sendJson(res, 404, { ok: false, error: "no summary" });
    return sendJson(res, 200, latest);
  }

  return notFound(res);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, error: "not found" });
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { ok: false, error: "method not allowed" });
}

async function postOperation(req: IncomingMessage, res: ServerResponse, team: TeamRoomStore): Promise<void> {
  const { workspaceId, record } = parseOperationBody(await readJsonBody(req));
  const outcome = await team.append(workspaceId, record);
  switch (outcome.status) {
    case "stored":
      return sendJson(res, 201, { workspaceId, record });
    case "replayed":
      return sendJson(res, 200, { workspaceId, record });
    case "sequence-conflict":
      return sendJson(res, 409, { ok: false, code: "SEQUENCE_CONFLICT", error: "sequence already stored" });
    case "operation-id-conflict":
      return sendJson(res, 409, {
        ok: false,
        code: "OPERATION_ID_CONFLICT",
        error: "operationId already stored with a different record",
      });
  }
}

async function getOperations(res: ServerResponse, team: TeamRoomStore, query: URLSearchParams): Promise<void> {
  const workspaceId = requireString(query.get("workspaceId"), "workspaceId");
  const afterSequence = queryInt(query, "afterSequence", 0);
  const limit = Math.min(queryInt(query, "limit", DEFAULT_PAGE) || DEFAULT_PAGE, MAX_PAGE);
  const page = await team.page(workspaceId, afterSequence, limit);
  const last = page.operations[page.operations.length - 1];
  return sendJson(res, 200, {
    workspaceId,
    operations: page.operations,
    hasMore: page.hasMore,
    nextAfterSequence: last === undefined ? afterSequence : last.sequence,
  });
}

/**
 * SSE of appended records after afterSequence. Polls the head once a second
 * (contract §2: the plugin may poll head instead). Ends when the client goes away.
 */
async function streamOperations(
  req: IncomingMessage,
  res: ServerResponse,
  team: TeamRoomStore,
  query: URLSearchParams,
): Promise<void> {
  const workspaceId = requireString(query.get("workspaceId"), "workspaceId");
  let cursor = queryInt(query, "afterSequence", 0);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  req.on("close", () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
  });
  const tick = async (): Promise<void> => {
    if (closed) return;
    try {
      let page = await team.page(workspaceId, cursor, MAX_PAGE);
      while (page.operations.length > 0 && !closed) {
        for (const record of page.operations) {
          res.write(`id: ${record.sequence}\nevent: operation\ndata: ${JSON.stringify(record)}\n\n`);
          cursor = record.sequence;
        }
        page = page.hasMore ? await team.page(workspaceId, cursor, MAX_PAGE) : { operations: [], hasMore: false };
      }
    } catch {
      res.write("event: error\ndata: {}\n\n");
    }
    if (!closed) timer = setTimeout(() => void tick(), STREAM_POLL_MS);
  };
  await tick();
}

async function getSessionRuns(res: ServerResponse, team: TeamRoomStore, query: URLSearchParams): Promise<void> {
  const memberId = query.get("memberId");
  const threadRef = query.get("threadRef");
  if ((memberId === null) === (threadRef === null)) {
    throw new BadRequest("pass exactly one of memberId or threadRef");
  }
  const runs =
    memberId !== null ? await team.sessionRunsForMember(memberId) : await team.sessionRunsForThread(threadRef as string);
  return sendJson(res, 200, { runs });
}

const USAGE_GROUPS = ["member", "day", "session", "total"] as const;

/** An ISO instant, so the comparison against endedAt is a string compare that means the same thing. */
function isoInstant(value: string | null, field: string): string | undefined {
  if (value === null || value === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequest(`${field} must be an ISO date or instant`);
  }
  return value;
}

async function getUsage(res: ServerResponse, team: TeamRoomStore, query: URLSearchParams): Promise<void> {
  const workspaceId = requireString(query.get("workspaceId"), "workspaceId");
  const groupBy = query.get("groupBy") ?? "member";
  if (!(USAGE_GROUPS as readonly string[]).includes(groupBy)) {
    throw new BadRequest(`groupBy must be one of ${USAGE_GROUPS.join(", ")}`);
  }
  const memberId = query.get("memberId");
  const since = isoInstant(query.get("since"), "since");
  const until = isoInstant(query.get("until"), "until");
  const rows = await team.usage({
    workspaceId,
    groupBy: groupBy as (typeof USAGE_GROUPS)[number],
    ...(memberId !== null && memberId !== "" ? { memberId } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  });
  return sendJson(res, 200, { workspaceId, groupBy, rows });
}

async function getBindings(res: ServerResponse, team: TeamRoomStore, query: URLSearchParams): Promise<void> {
  const workspaceId = requireString(query.get("workspaceId"), "workspaceId");
  const memberId = query.get("memberId");
  const threadRef = query.get("threadRef");
  if ((memberId === null) === (threadRef === null)) {
    throw new BadRequest("pass exactly one of memberId or threadRef");
  }
  const bindings = await team.bindings(workspaceId, threadRef !== null ? { threadRef } : { memberId: memberId as string });
  return sendJson(res, 200, { workspaceId, bindings });
}

async function putSummary(req: IncomingMessage, res: ServerResponse, team: TeamRoomStore, threadRef: string): Promise<void> {
  const summary = parseSummary(threadRef, await readJsonBody(req));
  const outcome = await team.putSummary(summary);
  switch (outcome.status) {
    case "stored":
      return sendJson(res, 201, summary);
    case "replayed":
      return sendJson(res, 200, summary);
    case "generation-stale":
      return sendJson(res, 409, { ok: false, code: "GENERATION_STALE", latest: outcome.latest, error: "generation is older than the latest" });
    case "generation-conflict":
      return sendJson(res, 409, { ok: false, code: "GENERATION_CONFLICT", error: "generation already stored with different content" });
  }
}
