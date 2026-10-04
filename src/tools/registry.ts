/**
 * Tool registry seam — the ONE place a tool domain is registered, and the one
 * place a tool name resolves to an implementation.
 *
 * Two layers, resolved base-first, then domains:
 *
 *   1. Base layer — the 26 MCP tools. It WRAPS the existing dispatch switch
 *      (surfaces/mcp/dispatch.ts) rather than reimplementing it: `run` delegates
 *      to `dispatchTool`, and name/description/inputSchema come from the
 *      checked-in tools/list snapshot. The switch stays the single
 *      implementation, so the control structure the parity harness guards is
 *      never retyped. dispatch.ts does not import this module, so the seam
 *      costs that file nothing — it stays untouched by every domain after this.
 *   2. Domain layer — additive ToolDomains from TOOL_DOMAINS below. Adding a
 *      domain means editing that one list: no switch edit, no snapshot edit.
 *
 * Unknown names keep the switch's own error text, byte-for-byte:
 * `unknown tool: ${name}`.
 */
import { dispatchTool, TOOL_NAMES } from "../surfaces/mcp/dispatch.js";
import SNAPSHOT from "../surfaces/mcp/tool-list.snapshot.json" with { type: "json" };
import type { Store } from "../store/store-interface.js";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(
    store: Store,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface ToolDomain {
  /** Provenance label for collision diagnostics. Not part of the wire name. */
  namespace: string;
  tools: readonly ToolSpec[];
}

/**
 * THE registration point. A domain is added by appending one entry here — this
 * list is the only file a new domain has to touch to become dispatchable.
 *
 * Empty in production: the 26 base tools are the whole advertised surface until
 * a domain lands here (tools/list serves the snapshot, so a registered domain
 * also needs its schema published — see listToolsForSession).
 */
export const TOOL_DOMAINS: readonly ToolDomain[] = [];

/**
 * Flatten domains into a name-keyed registry.
 *
 * Keyed by the wire name, not by namespace: consumers (the MCP surface, the B2
 * HTTP surface) address tools by the same plain names, and ToolSpec carries no
 * qualified name to rebuild a namespaced key from. `namespace` is provenance
 * for diagnostics.
 *
 * Duplicate names within the domain set are a build-time error rather than
 * last-wins, so a colliding domain fails at registration instead of silently
 * shipping a dead tool.
 */
export function buildRegistry(domains: readonly ToolDomain[]): ReadonlyMap<string, ToolSpec> {
  const registry = new Map<string, ToolSpec>();
  const owner = new Map<string, string>();
  for (const domain of domains) {
    for (const tool of domain.tools) {
      const claimed = owner.get(tool.name);
      if (claimed !== undefined) {
        throw new Error(
          `duplicate tool: ${tool.name} is registered by both domain "${claimed}" and domain "${domain.namespace}"`,
        );
      }
      owner.set(tool.name, domain.namespace);
      registry.set(tool.name, tool);
    }
  }
  return registry;
}

interface SnapshotEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function snapshotEntries(): readonly SnapshotEntry[] {
  return SNAPSHOT as unknown as readonly SnapshotEntry[];
}

/**
 * The 26 base tools as ToolSpec entries, driven by TOOL_NAMES (exactly the set
 * dispatchTool can handle) with metadata read from the snapshot. A base tool
 * with no snapshot entry is a broken checkout, not something to paper over with
 * an invented schema — so it throws with the regeneration command.
 */
function baseTools(): readonly ToolSpec[] {
  const byName = new Map(snapshotEntries().map((entry) => [entry.name, entry]));
  return TOOL_NAMES.map((name) => {
    const entry = byName.get(name);
    if (entry === undefined) {
      throw new Error(
        `base tool "${name}" has no tools/list snapshot entry — run \`npm run snapshot:schemas\` to regenerate`,
      );
    }
    return {
      name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      run: (store: Store, args: Record<string, unknown>) => dispatchTool(store, name, args),
    };
  });
}

let cached: ReadonlyMap<string, ToolSpec> | null = null;

/**
 * The base layer plus the given domains, base first. Base-first is what makes
 * the wrapper safe to add: a domain can extend the surface but never displace
 * one of the 26 tools the snapshot advertises.
 *
 * Exported so a caller (or a test) can resolve against a specific domain set
 * through the exact production resolution path, instead of only ever being
 * able to observe the production TOOL_DOMAINS.
 */
export function createToolRegistry(domains: readonly ToolDomain[]): ReadonlyMap<string, ToolSpec> {
  const merged = new Map<string, ToolSpec>();
  for (const tool of baseTools()) merged.set(tool.name, tool);
  for (const [name, tool] of buildRegistry(domains)) {
    if (merged.has(name)) {
      throw new Error(
        `domain tool "${name}" collides with a base tool — base tools resolve first, so rename the domain tool`,
      );
    }
    merged.set(name, tool);
  }
  return merged;
}

/**
 * Built on first use, not at module load: importing this module (a test, a
 * script, the B2 surface) should not cost the snapshot walk or a dispatch
 * import-graph load until a tool is actually resolved.
 */
function toolRegistry(): ReadonlyMap<string, ToolSpec> {
  if (cached !== null) return cached;
  cached = createToolRegistry(TOOL_DOMAINS);
  return cached;
}

export function resolveTool(name: string): ToolSpec | undefined {
  return toolRegistry().get(name);
}

/**
 * Dispatch against an explicit registry. Unknown names keep the switch's own
 * error text, byte-for-byte.
 */
export function runToolFrom(
  registry: ReadonlyMap<string, ToolSpec>,
  store: Store,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> | Record<string, unknown> {
  const spec = registry.get(name);
  if (spec === undefined) throw new Error(`unknown tool: ${name}`);
  return spec.run(store, args);
}

/**
 * The dispatch entry point every surface calls. Base tools land in the
 * untouched switch; domain tools land in their own `run`.
 */
export function runTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> | Record<string, unknown> {
  return runToolFrom(toolRegistry(), store, name, args);
}
