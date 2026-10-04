/**
 * GET /health and GET /schema — backend.py:95-125.
 *
 * /health is liveness and MUST NOT 500: if the state layer throws while counting,
 * Python substitutes counts = {"error": repr(exc)} and still answers 200
 * (backend.py:100-102). Keep that — a probe that 500s during a state hiccup is
 * how a restart loop starts.
 */
import { constants as fsConstants, accessSync, existsSync } from "node:fs";
import * as path from "node:path";
import type { ServerResponse } from "node:http";
import { stateRoot, summaryPath } from "../../domain/config.js";
import { excRepr } from "../../domain/models.js";
import type { Store } from "../../store/store-interface.js";
import { TOOL_NAMES } from "../mcp/dispatch.js";
import { listAllTools } from "../mcp/server.js";
import { sendJson } from "./responses.js";

/**
 * backend.py serves __version__ = "0.1.0" from mcp_orchestration/__init__.py.
 * The TS daemon reports its own package version instead: the value is what is
 * actually serving /health, and a probe that reports the Python version would
 * misattribute the running process. Shape and key set are identical.
 */
export const BACKEND_VERSION = "0.9.2";

/** build_info.py's source-checkout fallback; CI rewrites those three literals. */
export const BUILD_INFO: Record<string, unknown> = {
  number: "dev",
  date: "unknown",
  git_sha: "unknown",
};

/** backend.py:98 — os.access(root, W_OK), falling back to the parent when absent. */
function stateWritable(root: string): boolean {
  try {
    accessSync(root, fsConstants.W_OK);
    return true;
  } catch {
    try {
      accessSync(path.dirname(root), fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/** backend.py:42-49. Never throws — the caller turns a throw into counts = {error}. */
async function counts(store: Store): Promise<Record<string, unknown>> {
  const projects = await store.listProjects();
  const tracks = await store.listTracks();
  let events = 0;
  let decisions = 0;
  for (const project of projects) {
    events += (await store.readEvents(project.id)).length;
    decisions += (await store.readDecisions(project.id)).length;
  }
  return { projects: projects.length, tracks: tracks.length, events, decisions };
}

export async function handleHealth(res: ServerResponse, store: Store): Promise<void> {
  const root = stateRoot();
  const md = summaryPath();
  let counted: Record<string, unknown>;
  try {
    counted = await counts(store);
  } catch (exc) {
    // health must never 500 on state weirdness
    counted = { error: excRepr(exc) };
  }
  sendJson(res, 200, {
    ok: true,
    service: "orchestration-backend",
    version: BACKEND_VERSION,
    state_root: root,
    state_writable: stateWritable(root),
    summary_path: md,
    summary_exists: existsSync(md),
    tools: [...TOOL_NAMES].sort(),
    counts: counted,
    build: BUILD_INFO,
  });
}

export function handleSchema(res: ServerResponse): void {
  const tools = listAllTools().map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    inputSchema: tool.inputSchema,
  }));
  sendJson(res, 200, { ok: true, tools });
}
