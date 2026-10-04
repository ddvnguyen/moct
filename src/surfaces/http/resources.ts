/**
 * /resources/list, /resources and /resources/read — a port of resources.py,
 * wired the way backend.py:156-207 wires it.
 *
 * Two details that a docstring-first reading gets wrong:
 *  1. the success bodies carry MORE than {ok,contents,meta} — the project reader
 *     also returns top-level `uri`/`mimeType`/`text`, and the track reader also
 *     returns `data`. Clients read those, so they are reproduced verbatim.
 *  2. backend.py maps a failure to 404 by looking for "not found" (lowercased) in
 *     the error message, else 400. That substring test is the actual status
 *     rule, which is why "project not found: ..." and "summary not found at ..."
 *     are 404 while "unknown resource uri: ..." is 400.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { estimateTokens, summaryPath } from "../../domain/config.js";
import type { Store } from "../../store/store-interface.js";
import { trackStatus } from "../../domain/tools/reporting.js";
import { excRepr } from "../../domain/models.js";
import { sendUriRequired, sendUnexpectedNoHint } from "./responses.js";

const RE_PROJECT_SUMMARY = /^orchestration:\/\/project\/(p-[a-z0-9]+)\/summary$/;
const RE_TRACK = /^orchestration:\/\/track\/(t-[a-z0-9]+)$/;

/** resources.py:30-41. */
export function parseUri(uri: string): { kind: "project_summary" | "track"; id: string } | null {
  const summary = RE_PROJECT_SUMMARY.exec(uri);
  if (summary) return { kind: "project_summary", id: summary[1] };
  const track = RE_TRACK.exec(uri);
  if (track) return { kind: "track", id: track[1] };
  return null;
}

/** resources.py:48-102. */
async function readProjectSummary(
  store: Store,
  projectId: string,
): Promise<Record<string, unknown>> {
  const uri = `orchestration://project/${projectId}/summary`;
  try {
    await store.getProject(projectId);
  } catch (exc) {
    return {
      ok: false,
      error: `project not found: ${projectId}: ${excRepr(exc)}`,
      hint: "list projects via track_list or check pid",
    };
  }
  const mdPath = summaryPath();
  const meta: Record<string, unknown> = {
    project_id: projectId,
    path: mdPath,
    uri,
    exists: existsSync(mdPath),
  };
  if (!existsSync(mdPath)) {
    return {
      ok: false,
      error: `summary not found at ${mdPath}`,
      hint: "run validate_and_commit first",
      meta,
      uri,
    };
  }
  let text: string;
  try {
    text = readFileSync(mdPath, "utf8");
  } catch (exc) {
    return { ok: false, error: `failed to read summary: ${excRepr(exc)}`, uri, meta };
  }
  try {
    const stat = statSync(mdPath);
    meta["size"] = stat.size;
    // Python's stat.st_mtime is seconds; stat.mtimeMs is milliseconds.
    meta["mtime"] = stat.mtimeMs / 1000;
    meta["tokens_estimate"] = estimateTokens(text);
    if (text.startsWith("---")) {
      const end = text.indexOf("\n---", 3);
      if (end !== -1) meta["frontmatter_bytes"] = end + 4;
    }
  } catch {
    // resources.py:92-93 — stat enrichment is best-effort and swallowed.
  }
  return {
    ok: true,
    uri,
    mimeType: "text/markdown",
    text,
    meta,
    contents: [{ uri, mimeType: "text/markdown", text }],
  };
}

/** resources.py:105-132. */
async function readTrackStatus(store: Store, trackId: string): Promise<Record<string, unknown>> {
  const uri = `orchestration://track/${trackId}`;
  const result = (await trackStatus(store, trackId)) as Record<string, unknown>;
  if (result["ok"] !== true) {
    result["uri"] = uri;
    if (!("hint" in result)) result["hint"] = "list tracks with track_list";
    return result;
  }
  const jsonText = JSON.stringify(result, null, 2);
  return {
    ok: true,
    uri,
    mimeType: "application/json",
    text: jsonText,
    data: result,
    contents: [{ uri, mimeType: "application/json", text: jsonText }],
  };
}

/** resources.py:135-146. */
export async function readResource(store: Store, uri: string): Promise<Record<string, unknown>> {
  const parsed = parseUri(uri);
  if (parsed === null) {
    return {
      ok: false,
      error: `unknown resource uri: ${uri}`,
      hint: "expected orchestration://project/{pid}/summary or orchestration://track/{tid}",
    };
  }
  if (parsed.kind === "project_summary") return readProjectSummary(store, parsed.id);
  return readTrackStatus(store, parsed.id);
}

/** resources.py:153-184 — projects first, then tracks. */
export async function listResources(store: Store): Promise<Record<string, unknown>[]> {
  const resources: Record<string, unknown>[] = [];
  let projects: Awaited<ReturnType<Store["listProjects"]>> = [];
  try {
    projects = await store.listProjects();
  } catch {
    projects = [];
  }
  for (const project of projects) {
    const uri = `orchestration://project/${project.id}/summary`;
    resources.push({
      uri,
      name: `project-${project.id}-summary`,
      title: `Project ${project.id} summary`,
      description: `Current summary.md bytes + meta for project ${project.id} (${project.name})`,
      mimeType: "text/markdown",
    });
  }
  let tracks: Awaited<ReturnType<Store["listTracks"]>> = [];
  try {
    tracks = await store.listTracks();
  } catch {
    tracks = [];
  }
  for (const track of tracks) {
    const uri = `orchestration://track/${track.id}`;
    resources.push({
      uri,
      name: `track-${track.id}`,
      title: `Track ${track.id}`,
      description: `Track status dict as JSON for ${track.id} (epic: ${track.epic})`,
      mimeType: "application/json",
    });
  }
  return resources;
}

/** resources.py:187-204 — a fixed table, no store access. */
export function listResourceTemplates(): Record<string, unknown>[] {
  return [
    {
      uriTemplate: "orchestration://project/{pid}/summary",
      name: "project-summary",
      title: "Project summary",
      description: "Renders current summary.md bytes + meta for project {pid}",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: "orchestration://track/{tid}",
      name: "track-status",
      title: "Track status",
      description: "Track status dict as JSON for track {tid}",
      mimeType: "application/json",
    },
  ];
}

export async function handleResourcesList(res: ServerResponse, store: Store): Promise<void> {
  try {
    const resources = await listResources(store);
    const resourceTemplates = listResourceTemplates();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, resources, resourceTemplates }));
  } catch (exc) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `failed to list resources: ${excRepr(exc)}` }));
  }
}

/** backend.py:171-207. */
export async function handleResourcesRead(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  queryUri: string | null,
): Promise<void> {
  let uri: string | null = queryUri;
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: unknown = {};
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw.length === 0 ? {} : JSON.parse(raw);
    } catch {
      body = {};
    }
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const fromBody = record["uri"] || record["uriTemplate"];
      uri = typeof fromBody === "string" ? fromBody : null;
    } else {
      uri = null;
    }
  }
  if (!uri || typeof uri !== "string") {
    sendUriRequired(res);
    return;
  }
  let result: Record<string, unknown>;
  try {
    result = await readResource(store, uri);
  } catch (exc) {
    sendUnexpectedNoHint(res, exc);
    return;
  }
  if (result["ok"] !== true) {
    const message = String(result["error"] ?? "").toLowerCase();
    const status = message.includes("not found") ? 404 : 400;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(result));
}
