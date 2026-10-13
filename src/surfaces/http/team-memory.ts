/**
 * /team/v1/memory — team memory over HTTP (schema v8). Same loopback, no-auth
 * surface as the rest of /team/v1: the caller asserts `actor` and the reader's
 * scope, and the plugin is the trust boundary that must never let a model pick
 * its own actor, home or scope.
 *
 * Refusals answer {ok:false,code,error[,details]} with the MemoryError status;
 * the code is stable so the client can branch on it. Human-only verbs (restore,
 * purge, settings) are routes here but are not exposed as expert tools.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./responses.js";
import {
  MEMORY_HOMES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  MemoryError,
  type HomeKind,
  type MemoryActor,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
  type TeamMemoryStore,
} from "../../team-room/memory.js";

type Json = Record<string, unknown>;

function invalid(message: string): MemoryError {
  return new MemoryError(400, "INVALID_INPUT", message);
}

function asObject(body: unknown): Json {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("body must be a JSON object");
  return body as Json;
}

function optString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  return value;
}

function reqString(value: unknown, field: string): string {
  const s = optString(value, field);
  if (s === undefined || s.trim().length === 0) throw invalid(`${field} is required`);
  return s;
}

function reqVersion(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${field} must be a positive integer`);
  }
  return value;
}

function optVersion(value: unknown, field: string): number | undefined {
  return value === undefined || value === null ? undefined : reqVersion(value, field);
}

function optBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalid(`${field} must be a boolean`);
  return value;
}

function parseActor(value: unknown): MemoryActor {
  const actor = asObject(value ?? null);
  if (actor["kind"] !== "human" && actor["kind"] !== "member") throw invalid("actor.kind must be human or member");
  return { kind: actor["kind"], id: reqString(actor["id"], "actor.id") };
}

function csv(raw: string | null): string[] {
  return raw === null || raw === "" ? [] : raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseList<T extends string>(raw: string | null, allowed: readonly string[], field: string): T[] | undefined {
  const items = csv(raw);
  if (items.length === 0) return undefined;
  for (const item of items) if (!allowed.includes(item)) throw invalid(`unknown ${field} ${item}`);
  return items as T[];
}

function parseStatus(raw: string | null): MemoryStatus | "all" | undefined {
  if (raw === null || raw === "") return undefined;
  if (raw !== "all" && !(MEMORY_STATUSES as readonly string[]).includes(raw)) throw invalid(`unknown status ${raw}`);
  return raw as MemoryStatus | "all";
}

function queryNumber(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw invalid(`${name} must be a non-negative integer`);
  return n;
}

/** Reader scope from the query string: workspaceId, expertId, channels, tasks, all=1. */
function parseScope(query: URLSearchParams): MemoryScope {
  return {
    workspaceId: reqString(query.get("workspaceId"), "workspaceId"),
    expertId: reqString(query.get("expertId"), "expertId"),
    channels: csv(query.get("channels")),
    tasks: csv(query.get("tasks")),
    all: query.get("all") === "1" || query.get("all") === "true",
  };
}

const RECORD_VERBS = new Set(["widen", "approve", "retract", "restore", "purge"]);

/**
 * Handles every path under /memory. `path` is relative to /team/v1. Returns
 * false when the path is not a memory route.
 */
export async function routeMemory(
  req: IncomingMessage,
  res: ServerResponse,
  memory: TeamMemoryStore,
  url: URL,
  path: string,
  method: string,
  readBody: () => Promise<unknown>,
): Promise<boolean> {
  if (path !== "/memory" && !path.startsWith("/memory/")) return false;
  try {
    await dispatch(res, memory, url, path, method, readBody);
  } catch (exc) {
    if (!(exc instanceof MemoryError)) throw exc;
    sendJson(res, exc.status, { ok: false, code: exc.code, error: exc.message, ...(exc.details ? { details: exc.details } : {}) });
  }
  return true;
}

async function dispatch(
  res: ServerResponse,
  memory: TeamMemoryStore,
  url: URL,
  path: string,
  method: string,
  readBody: () => Promise<unknown>,
): Promise<void> {
  const query = url.searchParams;

  if (path === "/memory") {
    if (method === "GET") {
      return sendJson(
        res,
        200,
        await memory.search({
          scope: parseScope(query),
          q: query.get("q") ?? undefined,
          types: parseList<MemoryType>(query.get("types"), MEMORY_TYPES, "type"),
          homes: parseList<HomeKind>(query.get("homes"), MEMORY_HOMES, "home"),
          status: parseStatus(query.get("status")),
          limit: queryNumber(query, "limit"),
          cursor: query.get("cursor"),
        }),
      );
    }
    if (method === "POST") {
      const body = asObject(await readBody());
      const home = asObject(body["home"] ?? null);
      const result = await memory.note({
        type: body["type"],
        title: body["title"],
        body: body["body"],
        attrs: body["attrs"],
        home: { kind: home["kind"], ref: home["ref"] },
        workspaceId: reqString(body["workspaceId"], "workspaceId"),
        taskRef: optString(body["taskRef"], "taskRef") ?? null,
        pinned: optBool(body["pinned"], "pinned"),
        confirmNew: optBool(body["confirmNew"], "confirmNew"),
        supersedes: optString(body["supersedes"], "supersedes") ?? null,
        supersedesVersion: optVersion(body["supersedesVersion"], "supersedesVersion"),
        actor: parseActor(body["actor"]),
      });
      // 200 when nothing was written (near matches held it back, or an unchanged upsert).
      const created = result.record !== null && result.upsert !== "unchanged";
      return sendJson(res, created ? 201 : 200, result);
    }
    return methodNotAllowed(res);
  }

  if (path === "/memory/get") {
    if (method !== "POST") return methodNotAllowed(res);
    const body = asObject(await readBody());
    const ids = body["ids"];
    if (!Array.isArray(ids)) throw invalid("ids must be a list");
    return sendJson(res, 200, await memory.getMany(ids as string[], parseScope(url.searchParams)));
  }

  if (path === "/memory/settings") {
    if (method === "GET") return sendJson(res, 200, await memory.settings());
    if (method === "PUT") {
      const body = asObject(await readBody());
      return sendJson(
        res,
        200,
        await memory.updateSettings({
          expertApproval: body["expertApproval"],
          orchestrators: body["orchestrators"],
          injectLayerTokens: body["injectLayerTokens"],
          actor: parseActor(body["actor"]),
        }),
      );
    }
    return methodNotAllowed(res);
  }

  if (path === "/memory/inject") {
    if (method !== "GET") return methodNotAllowed(res);
    return sendJson(
      res,
      200,
      await memory.inject({
        expertId: reqString(query.get("expertId"), "expertId"),
        workspaceId: reqString(query.get("workspaceId"), "workspaceId"),
        channelRef: query.get("channelRef") ?? undefined,
        taskRef: query.get("taskRef") ?? undefined,
        layerTokens: queryNumber(query, "layerTokens"),
      }),
    );
  }

  if (path === "/memory/rule-feed") {
    if (method !== "GET") return methodNotAllowed(res);
    return sendJson(res, 200, {
      versions: await memory.ruleFeed(reqString(query.get("workspaceId"), "workspaceId"), queryNumber(query, "limit")),
    });
  }

  const parts = path.slice("/memory/".length).split("/").map(decodeURIComponent);
  const id = parts[0] ?? "";
  if (id.length === 0 || parts.length > 2) return notFound(res);

  if (parts.length === 1) {
    if (method === "GET") {
      const record = await memory.get(id);
      if (record === undefined) throw new MemoryError(404, "NOT_FOUND", "no such memory record");
      return sendJson(res, 200, record);
    }
    if (method === "PATCH") {
      const body = asObject(await readBody());
      return sendJson(
        res,
        200,
        await memory.patch(id, {
          baseVersion: reqVersion(body["baseVersion"], "baseVersion"),
          actor: parseActor(body["actor"]),
          title: body["title"],
          body: body["body"],
          attrs: body["attrs"],
          pinned: body["pinned"],
          priority: body["priority"],
          reason: optString(body["reason"], "reason"),
        }),
      );
    }
    return methodNotAllowed(res);
  }

  const verb = parts[1] ?? "";
  if (verb === "versions") {
    if (method !== "GET") return methodNotAllowed(res);
    return sendJson(res, 200, { versions: await memory.versions(id) });
  }
  if (!RECORD_VERBS.has(verb)) return notFound(res);
  if (method !== "POST") return methodNotAllowed(res);
  const body = asObject(await readBody());
  const actor = parseActor(body["actor"]);
  const reason = optString(body["reason"], "reason");
  switch (verb) {
    case "widen": {
      const to = asObject(body["to"] ?? null);
      return sendJson(
        res,
        200,
        await memory.widen(id, { to: { kind: to["kind"], ref: to["ref"] }, baseVersion: reqVersion(body["baseVersion"], "baseVersion"), actor, reason }),
      );
    }
    case "approve":
      return sendJson(res, 200, await memory.approve(id, { baseVersion: reqVersion(body["baseVersion"], "baseVersion"), actor, reason }));
    case "retract":
      return sendJson(res, 200, await memory.retract(id, { baseVersion: reqVersion(body["baseVersion"], "baseVersion"), actor, reason }));
    case "restore":
      return sendJson(
        res,
        200,
        await memory.restore(id, {
          version: reqVersion(body["version"], "version"),
          baseVersion: reqVersion(body["baseVersion"], "baseVersion"),
          actor,
          reason,
        }),
      );
    default:
      return sendJson(res, 200, await memory.purge(id, { actor, reason }));
  }
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, error: "not found" });
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { ok: false, error: "method not allowed" });
}
