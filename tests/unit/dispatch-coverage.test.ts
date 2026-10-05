/**
 * Every advertised tool must be DISPATCHABLE.
 *
 * `fleet_usage` shipped in TOOL_NAMES and in the tools/list snapshot with no
 * `case` in dispatch.ts, so every client that discovered it got
 * `unknown tool: fleet_usage` — while the 140-case parity harness stayed green
 * and the only symptom anywhere was a repo-wide lint warning that the
 * `fleetUsage` import was unused. Both halves of that are worth pinning:
 *
 *  - the dispatch table must answer for every advertised name, and
 *  - "throws about its arguments" must be distinguishable from "has no case",
 *    because the first is correct behaviour and the second is this bug.
 *
 * This asserts the FIRST property only. Argument validation is the handlers'
 * business and is covered by the parity harness.
 */
import { describe, expect, it } from "vitest";
import { TOOL_NAMES, dispatchTool } from "../../src/surfaces/mcp/dispatch.js";
import TOOL_SNAPSHOT from "../../src/surfaces/mcp/tool-list.snapshot.json" with { type: "json" };
import { createToolRegistry } from "../../src/tools/registry.js";

interface SnapshotTool {
  name: string;
}

/** A store stub whose every method throws a marker error, so an argument or
 *  state failure is unmistakably different from "no case in the switch". */
function unreachableStore(): never {
  return new Proxy(
    {},
    {
      get: (_t, prop) => () => {
        throw new Error(`STORE_REACHED:${String(prop)}`);
      },
    },
  ) as never;
}

describe("advertised tools are dispatchable", () => {
  it("has a case for every name in TOOL_NAMES", async () => {
    const store = unreachableStore();
    const missing: string[] = [];
    for (const name of TOOL_NAMES) {
      try {
        await dispatchTool(store, name, {});
      } catch (exc) {
        const message = (exc as Error).message;
        // Reaching the store, or failing argument validation, means the case
        // exists. Only `unknown tool: <name>` means the case is missing.
        if (message === `unknown tool: ${name}`) missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it("covers every name the tools/list snapshot advertises", () => {
    const advertised = (TOOL_SNAPSHOT as unknown as SnapshotTool[]).map((t) => t.name);
    const declared = new Set<string>(TOOL_NAMES);
    const undeclared = advertised.filter((n) => !declared.has(n));
    expect(undeclared).toEqual([]);
    expect(declared.size).toBe(advertised.length);
  });

  it("answers fleet_usage with the usage contract, not the default arm", async () => {
    // Regression pin for the shipped defect: `fleet_usage` was advertised in
    // TOOL_NAMES and in the snapshot with no case in the switch, so every client
    // got `unknown tool: fleet_usage`. The handler existed and was exported —
    // only the wiring was missing.
    const store = { root: "/tmp/fleet-usage-no-such-state" } as never;
    // Mirrors Python fleet_usage_get with no snapshot on disk.
    expect(await dispatchTool(store, "fleet_usage", {})).toEqual({
      ok: true,
      snapshot: null,
      hint: "no usage reported yet; an agent with paseo access should call fleet_usage_report",
    });
  });

  it("rejects an invalid fleet_usage action the way Python does", async () => {
    const store = { root: "/tmp/fleet-usage-no-such-state" } as never;
    const result = await dispatchTool(store, "fleet_usage", { action: "nope" });
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("invalid action 'nope'");
    expect(result["hint"]).toBe("must be one of: get, report");
  });

  it("keeps the registry in step with the dispatch table", () => {
    // The seam resolves base names through this same table, so a name that is
    // registered but undispatchable would pass discovery and fail at call time.
    for (const spec of createToolRegistry([]).values()) {
      expect(TOOL_NAMES).toContain(spec.name);
    }
  });
});
