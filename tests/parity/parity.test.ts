/**
 * MCP parity harness (paseo#31 M1 deliverable 5): boots the Python MCP server
 * (temp DB from the fixture) AND the TS MCP server (temp fleet.db from the
 * same fixture), runs the same-input case catalog spanning all 26 tools over
 * MCP stdio, applies normalization, and produces a pass/fail report with
 * diffs. Deterministic: sequential execution, sorted keys, no wall-clock
 * dependence (ages compare with +/-1s tolerance; everything else exact).
 */
import { describe, expect, it } from "vitest";
import { buildCases, summaryContent, type Case } from "./cases.js";
import { canonical, diffNormalized, normalizeSide } from "./normalize.js";
import { setupParity, teardownParity, type ParityWorld } from "./setup.js";

function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as Record<string, unknown>))) {
      throw new Error(`extract path missing: ${path}`);
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function toolText(res: Record<string, unknown>): string {
  const result = res["result"] as Record<string, unknown>;
  const content = result["content"] as { type: string; text: string }[];
  return content[0].text;
}

function resolveArgs(
  args: Record<string, unknown>,
  ctx: Record<string, string>,
  summaries: { content: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.startsWith("$")) {
      if (v === "$summary") {
        out[k] = summaries.content;
      } else {
        const name = v.slice(1);
        if (!(name in ctx)) throw new Error(`unresolved ctx var: ${v}`);
        out[k] = ctx[name];
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

interface CaseOutcome {
  name: string;
  pass: boolean;
  diffs: { path: string; a: unknown; b: unknown }[];
  error?: string;
}

async function runCase(
  world: ParityWorld,
  c: Case,
  pyCtx: Record<string, string>,
  tsCtx: Record<string, string>,
  tmpPrefixes: [string, string],
): Promise<CaseOutcome> {
  const summaries = {
    content: "",
  };
  void summaries;
  try {
    if (c.special === "init") {
      // initialize was captured at boot; re-run for an exact compare
      const pyInit = await world.py.initialize();
      const tsInit = await world.ts.initialize();
      const a = normalizeSide(pyInit, { tmpPrefixes: [tmpPrefixes[0]] });
      const b = normalizeSide(tsInit, { tmpPrefixes: [tmpPrefixes[1]] });
      const diffs = diffNormalized(a, b);
      return { name: c.name, pass: diffs.length === 0, diffs };
    }
    if (c.special === "tools-list") {
      const pyList = await world.py.listTools();
      const tsList = await world.ts.listTools();
      const a = normalizeSide(pyList, { tmpPrefixes: [tmpPrefixes[0]] });
      const b = normalizeSide(tsList, { tmpPrefixes: [tmpPrefixes[1]] });
      const diffs = diffNormalized(a, b);
      return { name: c.name, pass: diffs.length === 0, diffs };
    }
    if (c.special === "unknown-tool") {
      const pyRes = await world.py.callTool("definitely_not_a_tool", {});
      const tsRes = await world.ts.callTool("definitely_not_a_tool", {});
      const a = normalizeSide(pyRes, { tmpPrefixes: [tmpPrefixes[0]] });
      const b = normalizeSide(tsRes, { tmpPrefixes: [tmpPrefixes[1]] });
      const diffs = diffNormalized(a, b);
      return { name: c.name, pass: diffs.length === 0, diffs };
    }
    const tool = c.tool!;
    // per-server summary content (ids spliced before send, normalized after)
    const buildFor = (_ctx: Record<string, string>): Record<string, unknown> =>
      resolveArgs(c.args ?? {}, _ctx, { content: summaryContent(_ctx) });
    const pyArgs = buildFor(pyCtx);
    const tsArgs = buildFor(tsCtx);
    const pyRes = await world.py.callTool(tool, pyArgs);
    const tsRes = await world.ts.callTool(tool, tsArgs);
    const pyText = toolText(pyRes);
    const tsText = toolText(tsRes);
    const pyIsError = (pyRes["result"] as Record<string, unknown>)["isError"] ?? false;
    const tsIsError = (tsRes["result"] as Record<string, unknown>)["isError"] ?? false;
    if (pyIsError !== tsIsError) {
      return {
        name: c.name,
        pass: false,
        diffs: [{ path: "$.isError", a: pyIsError, b: tsIsError }],
      };
    }
    let pyJson: unknown;
    let tsJson: unknown;
    try {
      pyJson = JSON.parse(pyText);
    } catch {
      pyJson = null;
    }
    try {
      tsJson = JSON.parse(tsText);
    } catch {
      tsJson = null;
    }
    if ((pyJson === null) !== (tsJson === null)) {
      return {
        name: c.name,
        pass: false,
        diffs: [{ path: "$.text", a: pyText.slice(0, 500), b: tsText.slice(0, 500) }],
      };
    }
    if (pyJson === null) {
      // both non-JSON text (validation errors): compare exactly
      const pass = pyText === tsText;
      return {
        name: c.name,
        pass,
        diffs: pass ? [] : [{ path: "$.text", a: pyText, b: tsText }],
      };
    }
    const a = normalizeSide(pyJson, { tmpPrefixes: [tmpPrefixes[0]] });
    const b = normalizeSide(tsJson, { tmpPrefixes: [tmpPrefixes[1]] });
    const diffs = diffNormalized(a, b);
    if (!diffs.length && c.extract) {
      for (const e of c.extract) {
        const pv = getPath(pyJson, e.path);
        const tv = getPath(tsJson, e.path);
        if (typeof pv !== "string" || typeof tv !== "string") {
          throw new Error(`extract ${e.path} not a string`);
        }
        pyCtx[e.var] = pv;
        tsCtx[e.var] = tv;
      }
    }
    return { name: c.name, pass: diffs.length === 0, diffs };
  } catch (exc) {
    return { name: c.name, pass: false, diffs: [], error: (exc as Error).message };
  }
}

async function runSuite(world: ParityWorld, cases: Case[]): Promise<CaseOutcome[]> {
  const pyCtx: Record<string, string> = {};
  const tsCtx: Record<string, string> = {};
  const prefixes: [string, string] = [world.pyDir, world.tsDir];
  const outcomes: CaseOutcome[] = [];
  for (const c of cases) {
    outcomes.push(await runCase(world, c, pyCtx, tsCtx, prefixes));
  }
  return outcomes;
}

function report(outcomes: CaseOutcome[]): string {
  const failed = outcomes.filter((o) => !o.pass);
  const lines = [`parity: ${outcomes.length - failed.length}/${outcomes.length} cases pass`];
  for (const f of failed.slice(0, 10)) {
    lines.push(`FAIL ${f.name}${f.error ? ` (harness error: ${f.error})` : ""}`);
    for (const d of f.diffs.slice(0, 8)) {
      const a = canonical(d.a).slice(0, 300);
      const b = canonical(d.b).slice(0, 300);
      lines.push(`  ${d.path}\n    py: ${a}\n    ts: ${b}`);
    }
  }
  if (failed.length > 10) lines.push(`... and ${failed.length - 10} more failures`);
  return lines.join("\n");
}

describe("mcp parity (python vs fleet-backend over stdio)", () => {
  it("same inputs -> identical outputs across the case catalog", async () => {
    const world = await setupParity("all");
    try {
      const cases = buildCases({
        projectId: world.fixtureProjectId,
        trackId: world.fixtureTrackId,
      });
      const outcomes = await runSuite(world, cases);
      console.log(report(outcomes));
      expect(outcomes.length).toBeGreaterThanOrEqual(100);
      const failed = outcomes.filter((o) => !o.pass);
      expect(failed.map((f) => f.name)).toEqual([]);
    } finally {
      await teardownParity(world);
    }
  }, 600000);

  it("default tier listing matches", async () => {
    // listing-only: unseeded DBs keep this fast; tools/list never reads the DB
    const world = await setupParity(null, { seed: false });
    try {
      const pyList = await world.py.listTools();
      const tsList = await world.ts.listTools();
      const a = normalizeSide(pyList, { tmpPrefixes: [world.pyDir] });
      const b = normalizeSide(tsList, { tmpPrefixes: [world.tsDir] });
      const diffs = diffNormalized(a, b);
      if (diffs.length) console.log(canonical(diffs).slice(0, 2000));
      expect(diffs).toEqual([]);
      // default tier is the leader surface (10 tools)
      const tools = (tsList["result"] as Record<string, unknown>)["tools"] as unknown[];
      expect(tools.length).toBe(10);
    } finally {
      await teardownParity(world);
    }
  }, 120000);
});
