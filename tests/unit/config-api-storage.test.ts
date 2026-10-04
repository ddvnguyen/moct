/**
 * Config storage semantics — the file-level contract config_api.py defines:
 * nested-v2 vs flat shape preservation, the .bak of previous bytes, no side
 * effect on a rejected write, and the owner-config ledger row.
 *
 * These are the assertions a settings page would break on, and none of them are
 * visible from the HTTP response alone.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TursoRepository } from "../../src/store/turso-repository.js";
import {
  effectiveRoles,
  fleetFile,
  getConfig,
  postPosition,
  putPosition,
  putTimings,
  readFleet,
  timingsFile,
} from "../../src/surfaces/http/config-api.js";

let dir: string;
let store: TursoRepository;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-config-"));
  store = await TursoRepository.open(dir, path.join(dir, "fleet.db"));
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

const fleet = () => JSON.parse(readFileSync(fleetFile(dir), "utf-8")) as Record<string, unknown>;

describe("fleet.json reads", () => {
  it("treats an absent file as defaults, not an error", () => {
    expect(readFleet(dir)).toEqual({ data: null, problem: null });
    expect(getConfig(dir)["version"]).toBe(2);
  });

  it("reports a corrupt file as INVALID_FIELD", () => {
    writeFileSync(fleetFile(dir), "{not json", "utf-8");
    const { problem } = readFleet(dir);
    expect(problem).toContain("fleet.json is not valid JSON");
    expect((getConfig(dir)["error"] as Record<string, unknown>)["code"]).toBe("INVALID_FIELD");
  });

  it("reports a non-object document", () => {
    writeFileSync(fleetFile(dir), "[1,2,3]", "utf-8");
    expect(readFleet(dir).problem).toBe("fleet.json must contain a JSON object");
  });

  it("does not create a file on read", () => {
    getConfig(dir);
    expect(existsSync(fleetFile(dir))).toBe(false);
  });

  it("unions the built-in defaults with the roles a file adds", () => {
    writeFileSync(
      fleetFile(dir),
      JSON.stringify({ version: 2, positions: { qa: { models: [] } } }),
      "utf-8",
    );
    const positions = getConfig(dir)["positions"] as Record<string, unknown>;
    expect(Object.keys(positions).sort()).toEqual([
      "consult",
      "dev",
      "leader",
      "orchestrator",
      "qa",
      "review",
    ]);
    expect(effectiveRoles({ qa: {} }).has("qa")).toBe(true);
  });
});

describe("fleet.json writes", () => {
  it("starts a missing file as nested v2", async () => {
    const result = await postPosition(store, dir, { role: "qa", position: { models: ["omp/m"] } });
    expect(result["position"]).toBeDefined();
    expect(fleet()).toEqual({
      version: 2,
      positions: { qa: { models: ["omp/m"], init_prompt: "", instruction_mode: "extend" } },
    });
  });

  it("preserves a flat file's shape instead of nesting it", async () => {
    writeFileSync(fleetFile(dir), JSON.stringify({ dev: { models: ["omp/x"] } }), "utf-8");
    await putPosition(store, dir, "dev", { models: ["omp/y"] });
    const written = fleet();
    expect(written["positions"]).toBeUndefined();
    expect((written["dev"] as Record<string, unknown>)["models"]).toEqual(["omp/y"]);
  });

  it("copies the previous bytes to fleet.json.bak before overwriting", async () => {
    await postPosition(store, dir, { role: "qa", position: { models: ["omp/one"] } });
    const afterFirst = readFileSync(fleetFile(dir), "utf-8");
    expect(existsSync(`${fleetFile(dir)}.bak`)).toBe(false);

    await putPosition(store, dir, "qa", { models: ["omp/two"] });
    expect(readFileSync(`${fleetFile(dir)}.bak`, "utf-8")).toBe(afterFirst);
    expect(
      (fleet()["positions"] as Record<string, Record<string, unknown>>)["qa"]["models"],
    ).toEqual(["omp/two"]);
  });

  it("leaves no .bak and no ledger row when validation rejects the write", async () => {
    const before = await store.listProjects();
    const rejected = await putPosition(store, dir, "leader", { models: [], bogus: 1 });
    expect((rejected["error"] as Record<string, unknown>)["code"]).toBe("UNKNOWN_FIELD");
    expect(existsSync(fleetFile(dir))).toBe(false);
    expect(existsSync(`${fleetFile(dir)}.bak`)).toBe(false);
    expect(await store.listProjects()).toHaveLength(before.length);
  });

  it("writes with indent=2 and a trailing newline, like json.dumps(indent=2)", async () => {
    await postPosition(store, dir, { role: "qa", position: { models: [] } });
    const raw = readFileSync(fleetFile(dir), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "version": 2');
  });

  it("appends one owner-config decision row per accepted write", async () => {
    await postPosition(store, dir, { role: "qa", position: { models: ["omp/m"] } });
    const projects = await store.listProjects();
    const ledger = projects.find((p) => p.slug === "owner-config-ledger");
    expect(ledger).toBeDefined();
    const decisions = await store.readDecisions(ledger!.id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!["decision"]).toBe(
      "fleet.json: position 'qa' created (models=1, instruction_mode=extend)",
    );
    expect(decisions[0]!["rationale"]).toBe("owner config API created /config/positions/qa");
    expect(decisions[0]!["source"]).toBe("owner-config");
    expect(decisions[0]!["track_id"]).toBeNull();
  });

  it("reuses one ledger project across writes", async () => {
    await postPosition(store, dir, { role: "qa", position: { models: [] } });
    await putPosition(store, dir, "qa", { models: [] });
    const ledger = (await store.listProjects()).filter((p) => p.slug === "owner-config-ledger");
    expect(ledger).toHaveLength(1);
    expect(await store.readDecisions(ledger[0]!.id)).toHaveLength(2);
  });

  it("404-equivalent result for an unknown role names the known roles sorted", async () => {
    const result = await putPosition(store, dir, "ghost", { models: [] });
    expect((result["error"] as Record<string, unknown>)["code"]).toBe("POSITION_NOT_FOUND");
    expect((result["error"] as Record<string, unknown>)["message"]).toBe(
      "unknown position: ghost (known: consult, dev, leader, orchestrator, review)",
    );
  });

  it("lets a newly created role be addressed afterwards", async () => {
    await postPosition(store, dir, { role: "qa", position: { models: [] } });
    const updated = await putPosition(store, dir, "qa", { models: ["omp/later"] });
    expect((updated["position"] as Record<string, unknown>)["models"]).toEqual(["omp/later"]);
  });
});

describe("timings.json writes", () => {
  const valid = {
    checkup_cron: "*/8 * * * *",
    deep_tick_cron: "0 */6 * * *",
    timezone: "UTC",
    usage_max_age_s: 600,
  };

  it("writes the file and backs up the previous bytes from the second write on", async () => {
    const result = await putTimings(store, dir, valid);
    expect(result["timings"]).toEqual(valid);
    expect(existsSync(timingsFile(dir))).toBe(true);
    expect(existsSync(`${timingsFile(dir)}.bak`)).toBe(false);

    const afterFirst = readFileSync(timingsFile(dir), "utf-8");
    await putTimings(store, dir, { ...valid, usage_max_age_s: 1200 });
    expect(readFileSync(`${timingsFile(dir)}.bak`, "utf-8")).toBe(afterFirst);
  });

  it("records only the changed keys in the ledger summary", async () => {
    await putTimings(store, dir, valid);
    await putTimings(store, dir, { ...valid, usage_max_age_s: 1200 });
    const ledger = (await store.listProjects()).find((p) => p.slug === "owner-config-ledger")!;
    const summaries = (await store.readDecisions(ledger.id)).map((d) => String(d["decision"]));
    // Order-independent on purpose: readDecisions sorts by ts ASC, id ASC, and ts
    // is millisecond-precision while id is random hex, so two writes landing in
    // the same millisecond come back in arbitrary order. That is a property of
    // the M1 store, not of this surface; assert membership, not position.
    expect(summaries).toContain("timings.json: usage_max_age_s: 600 -> 1200");
    expect(
      summaries.some((s) =>
        s.includes("timings.json: checkup_cron: '*/6 * * * *' -> '*/8 * * * *'"),
      ),
    ).toBe(true);
    expect(summaries).toHaveLength(2);
  });

  it("writes nothing when the body is rejected", async () => {
    const rejected = await putTimings(store, dir, { ...valid, timezone: "Mars/Olympus" });
    expect((rejected["error"] as Record<string, unknown>)["code"]).toBe("INVALID_TIMING");
    expect(existsSync(timingsFile(dir))).toBe(false);
  });
});
