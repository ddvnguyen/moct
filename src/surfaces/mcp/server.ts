/**
 * MCP stdio server — the M1 surface: the 26 tools with names + input schemas
 * identical to Python (served verbatim from the checked-in tools/list
 * snapshot; only tier filtering happens at runtime).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { sessionTierTools } from "../../domain/config.js";
import { excRepr } from "../../domain/models.js";
import type { Store } from "../../store/store-interface.js";
import { runTool } from "../../tools/registry.js";
import { validateToolArgs, type ToolSchema } from "./validate-args.js";
import TOOL_SNAPSHOT from "./tool-list.snapshot.json" with { type: "json" };

export const SERVER_NAME = "orchestration";
export const SERVER_VERSION = "1.30.0";
export const SERVER_INSTRUCTIONS =
  "Leader orchestration contract as enforced state transitions: projects/tracks, " +
  "leader contract-signing (one leader per track, fleet model governance), " +
  "6/24-min heartbeat specs, lossless decision ledger, history queries, " +
  "token-fitted handoff packs, and the cheap-builder + zero-trust-verified " +
  "orchestration.md summary pipeline. See mcp-orchestration/docs/DESIGN.md.";

interface SnapshotTool {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  _meta?: Record<string, unknown>;
}

const SNAPSHOT = TOOL_SNAPSHOT as unknown as SnapshotTool[];

export function listToolsForSession(): SnapshotTool[] {
  const allowed = sessionTierTools();
  return SNAPSHOT.filter((t) => allowed === null || allowed.has(t.name));
}

/**
 * The UNFILTERED tool table.
 *
 * backend.py's /schema reads `mcp._tool_manager.list_tools()` — every tool the
 * server knows — not the tier-filtered session view. A thin stdio client uses
 * /schema to discover what it may call, so tier filtering here would hide tools
 * the caller is entitled to. Kept separate from listToolsForSession for that
 * reason; do not merge them.
 */
export function listAllTools(): readonly SnapshotTool[] {
  return SNAPSHOT;
}

export function createFleetMcpServer(store: Store): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        experimental: {},
        prompts: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        tools: { listChanged: false },
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolsForSession().map((t) => {
      const entry: Record<string, unknown> = {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      };
      if (t._meta !== undefined) entry["_meta"] = t._meta;
      return entry;
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = String(request.params?.name ?? "");
    const entry = SNAPSHOT.find((t) => t.name === name);
    if (!entry) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    const rawArgs = (request.params?.arguments ?? {}) as Record<string, unknown>;
    const checked = validateToolArgs(name, entry.inputSchema, rawArgs);
    if (!checked.ok) {
      return { content: [{ type: "text", text: checked.text }], isError: true };
    }
    try {
      const result = await runTool(store, name, checked.args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
    } catch (exc) {
      const failure = {
        ok: false,
        error: `unexpected: ${excRepr(exc)}`,
        hint: "report this to the project lead",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(failure, null, 2) }],
        isError: false,
      };
    }
  });

  // M1 serves tools only; prompts/resources are advertised for initialize
  // parity and served empty (MCP resources land in M2).
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  return server;
}
