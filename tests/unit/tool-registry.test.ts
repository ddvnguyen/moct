/**
 * Tool registry seam — a domain must be addable by editing TOOL_DOMAINS alone,
 * and the base layer must not have quietly lost any of the 26 tools it wraps.
 */
import { describe, expect, it } from "vitest";
import { TOOL_NAMES, dispatchTool } from "../../src/surfaces/mcp/dispatch.js";
import SNAPSHOT from "../../src/surfaces/mcp/tool-list.snapshot.json" with { type: "json" };
import type { Store } from "../../src/store/store-interface.js";
import {
  TOOL_DOMAINS,
  buildRegistry,
  createToolRegistry,
  resolveTool,
  runTool,
  runToolFrom,
  type ToolDomain,
  type ToolSpec,
} from "../../src/tools/registry.js";

// The synthetic tool never touches the store, so a stub is honest here: the
// assertion is about name resolution, not about store behaviour.
const STUB_STORE = {} as Store;

const FAKE_NAME = "synthetic_probe_echo";

function fakeSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name: FAKE_NAME,
    description: "Synthetic seam probe",
    inputSchema: { type: "object", properties: {} },
    run: (_store, args) => ({ echoed: args["value"] ?? null }),
    ...overrides,
  };
}

function syntheticDomain(tools: readonly ToolSpec[] = [fakeSpec()]): ToolDomain {
  return { namespace: "synthetic", tools };
}

describe("base layer wraps the existing switch", () => {
  it("keeps the snapshot and the switch's TOOL_NAMES in lockstep", () => {
    // The base ToolSpec metadata is read from the snapshot while reachability
    // comes from TOOL_NAMES. If the two drift, a base tool either loses its
    // schema or becomes unreachable — fail here rather than at first dispatch.
    const snapshotNames = (SNAPSHOT as unknown as { name: string }[]).map((t) => t.name);
    expect(snapshotNames).toEqual([...TOOL_NAMES]);
  });

  it("resolves all 26 base tools with snapshot metadata", () => {
    const registry = createToolRegistry([]);
    for (const name of TOOL_NAMES) {
      const spec = registry.get(name);
      expect(spec, `base tool ${name} must resolve`).toBeDefined();
      expect(spec?.name).toBe(name);
      expect(typeof spec?.description).toBe("string");
      expect(spec?.inputSchema).toBeTypeOf("object");
    }
    expect(registry.size).toBe(TOOL_NAMES.length);
  });

  it("routes a base tool through the untouched switch", async () => {
    // leader_runbook takes no store access, so the wrapper's delegation to
    // dispatchTool is observable without a database.
    const viaSeam = await runTool(STUB_STORE, "leader_runbook", {});
    const viaSwitch = await dispatchTool(STUB_STORE, "leader_runbook", {});
    expect(viaSeam).toEqual(viaSwitch);
  });

  it("keeps the unknown-tool error byte-for-byte", () => {
    expect(() => runTool(STUB_STORE, "not_a_tool", {})).toThrow("unknown tool: not_a_tool");
    try {
      runTool(STUB_STORE, "not_a_tool", {});
      expect.unreachable("runTool must throw for an unknown tool");
    } catch (err) {
      expect((err as Error).message).toBe("unknown tool: not_a_tool");
    }
  });
});

describe("domain registration seam", () => {
  it("resolves and runs a synthetic domain tool through the production path", async () => {
    const registry = createToolRegistry([syntheticDomain()]);

    const spec = registry.get(FAKE_NAME);
    expect(spec).toBeDefined();
    expect(spec?.description).toBe("Synthetic seam probe");

    const result = await runToolFrom(registry, STUB_STORE, FAKE_NAME, { value: "ping" });
    expect(result).toEqual({ echoed: "ping" });
  });

  it("leaves the synthetic tool out of the production registration", () => {
    // The whole point of the seam: production ships no synthetic tool, and the
    // seam never mutated the base layer to make room for one.
    expect(resolveTool(FAKE_NAME)).toBeUndefined();
    expect([...createToolRegistry(TOOL_DOMAINS).keys()]).toEqual([...TOOL_NAMES]);
    expect(() => runTool(STUB_STORE, FAKE_NAME, { value: "ping" })).toThrow(
      `unknown tool: ${FAKE_NAME}`,
    );
  });

  it("is unaffected by which domains are registered", async () => {
    const withDomain = createToolRegistry([syntheticDomain()]);
    // Adding a domain must not perturb base resolution.
    expect([...withDomain.keys()].slice(0, TOOL_NAMES.length)).toEqual([...TOOL_NAMES]);
    expect(withDomain.size).toBe(TOOL_NAMES.length + 1);
  });

  it("gives base tools precedence and rejects a domain that would shadow one", () => {
    const shadowing: ToolDomain = {
      namespace: "synthetic",
      tools: [fakeSpec({ name: "leader_runbook" })],
    };
    expect(() => createToolRegistry([shadowing])).toThrow(/collides with a base tool/);
  });

  it("rejects duplicate names across domains", () => {
    const other: ToolDomain = { namespace: "other", tools: [fakeSpec()] };
    expect(() => buildRegistry([syntheticDomain(), other])).toThrow(
      /duplicate tool: synthetic_probe_echo/,
    );
  });

  it("flattens domains by wire name, ignoring namespace", () => {
    const registry = buildRegistry([syntheticDomain()]);
    expect([...registry.keys()]).toEqual([FAKE_NAME]);
    expect(registry.get(FAKE_NAME)?.description).toBe("Synthetic seam probe");
  });
});
