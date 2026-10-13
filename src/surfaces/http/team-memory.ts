/**
 * /team/v1/memory — team memory over HTTP (schema v8). Same loopback, no-auth
 * surface as the rest of /team/v1: the caller asserts `actor`, and the plugin is
 * the trust boundary that must never let a model pick its own actor or scope.
 *
 * Refusals answer {ok:false,code,error} with the MemoryError status; the code is
 * stable so the client can branch on it. Human-only verbs (restore, purge,
 * settings) are routes here but are not exposed as expert tools.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./responses.js";
import {
  MEMORY_LAYERS,
  MEMORY_STATUSES,
  MemoryError,
  type MemoryActor,
  type MemoryLayer,
  type MemoryListQuery,
  type MemoryStatus,
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

function parseActor(value: unknown): MemoryActor {
  const actor = asObject(value ?? null);
  if (actor["kind"] !== "human" && actor["kind"] !== "member") throw invalid("actor.kind must be human or member");
  return { kind: actor["kind"], id: reqString(actor["id"], "actor.id") };
}

function parseLayers(raw: string | null): MemoryLayer[] | undefined {
  if (raw === null || raw === "") return undefined;
  const layers = raw.split(",").map((l) => l.trim());
  for (const layer of layers) {
    if (!(MEMORY_LAYERS as readonly string[]).includes(layer)) throw invalid(`unknown layer ${layer}`);
  }
  return layers as MemoryLayer[];
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

function scopeQuery(query: URLSearchParams): Pick<MemoryListQuery, "memberId" | "workspaceId" | "channelRef" | "threadRef"> {
  return {
    memberId: query.get("memberId") ?? undefined,
    workspaceId: query.get("workspaceId") ?? undefined,
    channelRef: query.get("channelRef") ?? undefined,
    threadRef: query.get("threadRef") ?? undefined,
  };
}

const ENTRY_VERBS = new Set(["promote", "approve", "retract", "restore", "purge"]);

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
    sendJson(res, exc.status, { ok: false, code: exc.code, error: exc.message });
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
      const entries = await memory.list({
        ...scopeQuery(query),
        layers: parseLayers(query.get("layers")),
        q: query.get("q") ?? undefined,
        status: parseStatus(query.get("status")),
        limit: queryNumber(query, "limit"),
        cite: query.get("cite") === "1" || query.get("cite") === "true",
      });
      return sendJson(res, 200, { entries });
    }
    if (method === "POST") {
      const body = asObject(await readBody());
      const layer = reqString(body["layer"], "layer");
      if (!(MEMORY_LAYERS as readonly string[]).includes(layer)) throw invalid(`unknown layer ${layer}`);
      if (body["pinned"] !== undefined && typeof body["pinned"] !== "boolean") throw invalid("pinned must be a boolean");
      const entry = await memory.create({
        layer: layer as MemoryLayer,
        memberId: optString(body["memberId"], "memberId"),
        workspaceId: optString(body["workspaceId"], "workspaceId"),
        channelRef: optString(body["channelRef"], "channelRef"),
        threadRef: optString(body["threadRef"], "threadRef"),
        originWorkspaceId: optString(body["originWorkspaceId"], "originWorkspaceId"),
        content: body["content"],
        pinned: body["pinned"] as boolean | undefined,
        actor: parseActor(body["actor"]),
      });
      return sendJson(res, 201, entry);
    }
    return methodNotAllowed(res);
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
          firstMateMembers: body["firstMateMembers"],
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
        memberId: reqString(query.get("memberId"), "memberId"),
        workspaceId: reqString(query.get("workspaceId"), "workspaceId"),
        channelRef: query.get("channelRef") ?? undefined,
        threadRef: query.get("threadRef") ?? undefined,
        layerTokens: queryNumber(query, "layerTokens"),
      }),
    );
  }

  if (path === "/memory/task-closed") {
    if (method !== "POST") return methodNotAllowed(res);
    const body = asObject(await readBody());
    const expired = await memory.taskClosed({
      workspaceId: reqString(body["workspaceId"], "workspaceId"),
      channelRef: reqString(body["channelRef"], "channelRef"),
      threadRef: reqString(body["threadRef"], "threadRef"),
      actor: parseActor(body["actor"]),
    });
    return sendJson(res, 200, { ok: true, expired });
  }

  const parts = path.slice("/memory/".length).split("/").map(decodeURIComponent);
  const id = parts[0] ?? "";
  if (id.length === 0 || parts.length > 2) return notFound(res);

  if (parts.length === 1) {
    if (method === "GET") {
      const entry = await memory.get(id);
      if (entry === undefined) throw new MemoryError(404, "NOT_FOUND", "no such memory entry");
      return sendJson(res, 200, entry);
    }
    if (method === "PATCH") {
      const body = asObject(await readBody());
      if (body["pinned"] !== undefined && typeof body["pinned"] !== "boolean") throw invalid("pinned must be a boolean");
      const entry = await memory.patch(id, {
        baseVersion: reqVersion(body["baseVersion"], "baseVersion"),
        actor: parseActor(body["actor"]),
        content: body["content"],
        pinned: body["pinned"] as boolean | undefined,
        reason: optString(body["reason"], "reason"),
      });
      return sendJson(res, 200, entry);
    }
    return methodNotAllowed(res);
  }

  const verb = parts[1] ?? "";
  if (verb === "versions") {
    if (method !== "GET") return methodNotAllowed(res);
    if ((await memory.get(id)) === undefined) throw new MemoryError(404, "NOT_FOUND", "no such memory entry");
    return sendJson(res, 200, { versions: await memory.versions(id) });
  }
  if (!ENTRY_VERBS.has(verb)) return notFound(res);
  if (method !== "POST") return methodNotAllowed(res);
  const body = asObject(await readBody());
  const actor = parseActor(body["actor"]);
  const reason = optString(body["reason"], "reason");
  switch (verb) {
    case "promote":
      return sendJson(
        res,
        201,
        await memory.promote(id, { to: body["to"], baseVersion: reqVersion(body["baseVersion"], "baseVersion"), actor, reason }),
      );
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
