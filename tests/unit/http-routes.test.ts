/**
 * Route-by-route parity with backend.py's table (backend.py:285-296): one test
 * per route asserting status and body keys, plus the error boundaries.
 *
 * Everything runs against a real scratch fleet.db and a real node:http server —
 * see http-harness.ts for why.
 */
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../../src/surfaces/mcp/dispatch.js";
import { URI_REQUIRED_HINT } from "../../src/surfaces/http/responses.js";
import { cleanupHarnesses, postJson, putJson, startHarness } from "./http-harness.js";

afterEach(cleanupHarnesses);

const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

describe("GET /health (backend.py:95)", () => {
  it("answers 200 with the full liveness shape on an empty state", async () => {
    const harness = await startHarness();
    const res = await harness.get("/health");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(
      [
        "build",
        "counts",
        "ok",
        "service",
        "state_root",
        "state_writable",
        "summary_exists",
        "summary_path",
        "tools",
        "version",
      ].sort(),
    );
    expect(body["ok"]).toBe(true);
    expect(body["service"]).toBe("orchestration-backend");
    expect(body["state_root"]).toBe(harness.stateDir);
    expect(typeof body["state_writable"]).toBe("boolean");
    expect(body["summary_path"]).toBe(harness.summaryFile);
    expect(body["summary_exists"]).toBe(false);
    expect(body["build"]).toEqual({ number: "dev", date: "unknown", git_sha: "unknown" });
  });

  it("counts projects, tracks, events and decisions", async () => {
    const harness = await startHarness();
    const project = (
      await json(
        await harness.request(
          "/tools/project_create",
          postJson({ name: "health-probe", repos: [] }),
        ),
      )
    )["project"] as Record<string, unknown>;
    await harness.request(
      "/tools/track_create",
      postJson({ project_id: project["id"], epic: "e", goal: "g" }),
    );
    const body = await json(await harness.get("/health"));
    const counts = body["counts"] as Record<string, unknown>;
    expect(Object.keys(counts).sort()).toEqual(["decisions", "events", "projects", "tracks"]);
    expect(counts["projects"]).toBeGreaterThanOrEqual(1);
    expect(counts["tracks"]).toBeGreaterThanOrEqual(1);
    expect(counts["events"]).toBeGreaterThanOrEqual(0);
    expect(counts["decisions"]).toBeGreaterThanOrEqual(0);
  });

  it("lists the tool names sorted, as sorted(TOOL_REGISTRY) does", async () => {
    const harness = await startHarness();
    const body = await json(await harness.get("/health"));
    const tools = body["tools"] as string[];
    expect([...tools].sort()).toEqual(tools);
    expect(new Set(tools)).toEqual(new Set<string>(TOOL_NAMES));
  });

  it("never 500s: a state failure degrades counts to {error} and still answers 200", async () => {
    const harness = await startHarness();
    // Sabotage only the counting path; /health must absorb it rather than throw.
    const original = harness.store.listProjects.bind(harness.store);
    harness.store.listProjects = async () => {
      throw new Error("counting exploded");
    };
    try {
      const res = await harness.get("/health");
      expect(res.status).toBe(200);
      const counts = (await json(res))["counts"] as Record<string, unknown>;
      expect(Object.keys(counts)).toEqual(["error"]);
      expect(String(counts["error"])).toContain("counting exploded");
    } finally {
      harness.store.listProjects = original;
    }
  });
});

describe("GET /schema (backend.py:116)", () => {
  it("returns the tool table with name, description and inputSchema", async () => {
    const harness = await startHarness();
    const res = await harness.get("/schema");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["ok"]).toBe(true);
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(TOOL_NAMES.length);
    for (const tool of tools) {
      expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
      expect(typeof tool["name"]).toBe("string");
      expect(typeof tool["description"]).toBe("string");
      expect(typeof tool["inputSchema"]).toBe("object");
    }
    expect(tools.map((t) => t["name"]).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("is not tier-filtered — it reports every tool the server knows", async () => {
    const harness = await startHarness();
    const body = await json(await harness.get("/schema"));
    const names = new Set((body["tools"] as Array<Record<string, unknown>>).map((t) => t["name"]));
    // `fleet` is orchestrator-tier only; a consult session still needs to see it
    // in /schema to know it exists.
    expect(names.has("fleet")).toBe(true);
    expect(names.size).toBe(TOOL_NAMES.length);
  });
});

describe("POST /tools/{name} (backend.py:128)", () => {
  it("runs a tool and returns its result verbatim with 200", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/tools/project_create",
      postJson({ name: "via-rest", repos: [] }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["ok"]).toBe(true);
    expect((body["project"] as Record<string, unknown>)["name"]).toBe("via-rest");
  });

  it("returns the Python 404 body for an unknown tool", async () => {
    const harness = await startHarness();
    const res = await harness.request("/tools/no_such_tool", postJson({}));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({
      ok: false,
      error: "unknown tool: no_such_tool",
      hint: "GET /schema lists tools",
    });
  });

  it("400s a body that is not a JSON object", async () => {
    const harness = await startHarness();
    const res = await harness.request("/tools/project_create", postJson([1, 2, 3]));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ ok: false, error: "body must be a JSON object" });
  });

  it("400s an unexpected keyword argument with the Python TypeError wording", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/tools/project_create",
      postJson({ name: "x", repos: [], bogus: 1 }),
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      ok: false,
      error:
        "bad arguments for project_create: project_create() got an unexpected keyword argument 'bogus'",
      hint: "GET /schema for inputSchema",
    });
  });

  it("400s a missing required argument", async () => {
    const harness = await startHarness();
    const res = await harness.request("/tools/project_create", postJson({ name: "x" }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      ok: false,
      error:
        "bad arguments for project_create: project_create() missing 1 required positional argument: 'repos'",
      hint: "GET /schema for inputSchema",
    });
  });

  it("treats an unparseable body as {} rather than a 400, as request.json() does", async () => {
    const harness = await startHarness();
    const res = await harness.request("/tools/project_create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    // body becomes {} -> missing required args -> the 400 binding path.
    expect(res.status).toBe(400);
    expect(String((await json(res))["error"])).toContain("missing 2 required positional arguments");
  });

  it("returns a tool's own ok:false body with 200, not an HTTP error", async () => {
    const harness = await startHarness();
    const res = await harness.request("/tools/track_status", postJson({ track_id: "t-missing" }));
    expect(res.status).toBe(200);
    expect((await json(res))["ok"]).toBe(false);
  });
});

describe("GET /resources and /resources/list (backend.py:156)", () => {
  it("serves the same body from both paths", async () => {
    const harness = await startHarness();
    const list = await json(await harness.get("/resources/list"));
    expect(list["ok"]).toBe(true);
    expect(await json(await harness.get("/resources"))).toEqual(list);
  });

  it("returns concrete resources for a project plus the two templates", async () => {
    const harness = await startHarness();
    const project = (
      await json(
        await harness.request("/tools/project_create", postJson({ name: "res-probe", repos: [] })),
      )
    )["project"] as Record<string, unknown>;
    const body = await json(await harness.get("/resources/list"));
    const resources = body["resources"] as Array<Record<string, unknown>>;
    const templates = body["resourceTemplates"] as Array<Record<string, unknown>>;

    expect(templates).toHaveLength(2);
    expect(Object.keys(templates[0]).sort()).toEqual([
      "description",
      "mimeType",
      "name",
      "title",
      "uriTemplate",
    ]);
    expect(templates.map((t) => t["uriTemplate"])).toEqual([
      "orchestration://project/{pid}/summary",
      "orchestration://track/{tid}",
    ]);

    const summary = resources.find(
      (r) => r["uri"] === `orchestration://project/${project["id"]}/summary`,
    );
    expect(summary).toBeDefined();
    expect(Object.keys(summary!).sort()).toEqual([
      "description",
      "mimeType",
      "name",
      "title",
      "uri",
    ]);
    expect(summary!["mimeType"]).toBe("text/markdown");
  });

  it("returns an empty resource list on an empty state", async () => {
    const harness = await startHarness();
    const body = await json(await harness.get("/resources/list"));
    expect(body["resources"]).toEqual([]);
    expect((body["resourceTemplates"] as unknown[]).length).toBe(2);
  });
});

describe("GET|POST /resources/read (backend.py:171)", () => {
  it("reads a project summary over GET with the meta the Python reader builds", async () => {
    const harness = await startHarness();
    const project = (
      await json(
        await harness.request("/tools/project_create", postJson({ name: "read-probe", repos: [] })),
      )
    )["project"] as Record<string, unknown>;
    writeFileSync(harness.summaryFile, "---\ntitle: t\n---\n# Summary\n\nbody text\n", "utf-8");

    const uri = `orchestration://project/${project["id"]}/summary`;
    const res = await harness.get(`/resources/read?uri=${encodeURIComponent(uri)}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["ok"]).toBe(true);
    expect(body["uri"]).toBe(uri);
    expect(body["mimeType"]).toBe("text/markdown");
    expect(String(body["text"])).toContain("body text");
    const contents = body["contents"] as Array<Record<string, unknown>>;
    expect(contents).toHaveLength(1);
    expect(Object.keys(contents[0]).sort()).toEqual(["mimeType", "text", "uri"]);
    const meta = body["meta"] as Record<string, unknown>;
    expect(meta["project_id"]).toBe(project["id"]);
    expect(meta["exists"]).toBe(true);
    expect(typeof meta["size"]).toBe("number");
    // Python's stat.st_mtime is seconds, not milliseconds.
    expect(meta["mtime"]).toBeLessThan(1e12);
    expect(typeof meta["tokens_estimate"]).toBe("number");
  });

  it("accepts the same read over POST {uri}", async () => {
    const harness = await startHarness();
    writeFileSync(harness.summaryFile, "# hi\n", "utf-8");
    const uri = "orchestration://project/p-abc123/summary";
    const overPost = await json(await harness.request("/resources/read", postJson({ uri })));
    expect(overPost["ok"]).toBe(false);
    expect(String(overPost["error"])).toContain("project not found");
  });

  it("400s when the uri is missing, with the Python hint", async () => {
    const harness = await startHarness();
    const res = await harness.request("/resources/read", postJson({}));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      ok: false,
      error: "uri is required",
      hint: URI_REQUIRED_HINT,
    });
  });

  it("400s an unknown uri — 'unknown resource uri' has no 'not found' in it", async () => {
    const harness = await startHarness();
    const res = await harness.get("/resources/read?uri=orchestration%3A%2F%2Fnope");
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      ok: false,
      error: "unknown resource uri: orchestration://nope",
      hint: "expected orchestration://project/{pid}/summary or orchestration://track/{tid}",
    });
  });

  it("404s a project that does not exist, because the message says 'not found'", async () => {
    const harness = await startHarness();
    const res = await harness.get(
      "/resources/read?uri=orchestration%3A%2F%2Fproject%2Fp-missingxyz%2Fsummary",
    );
    expect(res.status).toBe(404);
    expect(String((await json(res))["error"])).toContain("project not found");
  });

  it("404s a missing summary file for a project that does exist", async () => {
    const harness = await startHarness();
    const project = (
      await json(
        await harness.request("/tools/project_create", postJson({ name: "nosummary", repos: [] })),
      )
    )["project"] as Record<string, unknown>;
    const uri = `orchestration://project/${project["id"]}/summary`;
    const res = await harness.get(`/resources/read?uri=${encodeURIComponent(uri)}`);
    expect(res.status).toBe(404);
    expect(String((await json(res))["error"])).toContain("summary not found at");
  });

  it("404s an unknown track through the track reader", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/resources/read",
      postJson({ uri: "orchestration://track/t-missing" }),
    );
    expect(res.status).toBe(404);
    expect((await json(res))["ok"]).toBe(false);
  });
});

describe("GET /config (backend.py:242)", () => {
  it("serves defaults with version 2 when no fleet.json exists, and creates nothing", async () => {
    const harness = await startHarness();
    const res = await harness.get("/config");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual([
      "leader_docs",
      "positions",
      "scaffold",
      "timings",
      "version",
    ]);
    expect(body["version"]).toBe(2);
    const positions = body["positions"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(positions).sort()).toEqual([
      "consult",
      "dev",
      "leader",
      "orchestrator",
      "review",
    ]);
    expect(positions["leader"]["instruction_mode"]).toBe("extend");
    expect(positions["leader"]["init_prompt"]).toBe("");
    expect((body["scaffold"] as Record<string, string>)["spawn_template"]).toContain("[#Engineer]");
    expect((body["leader_docs"] as unknown[]).length).toBe(2);
    expect(body["timings"]).toMatchObject({
      checkup_cron: "*/6 * * * *",
      deep_tick_cron: "*/30 * * * *",
      usage_max_age_s: 900,
    });
  });
});

describe("POST /config/positions (backend.py:260)", () => {
  it("creates a position and echoes it", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/positions",
      postJson({ role: "qa", position: { models: ["omp/m1"] } }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const position = body["position"] as Record<string, unknown>;
    expect(position["models"]).toEqual(["omp/m1"]);
    expect(position["instruction_mode"]).toBe("extend");
    expect(position["init_prompt"]).toBe("");
  });

  it("409s a role that already exists, listing nothing extra", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/positions",
      postJson({ role: "review", position: { models: [] } }),
    );
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({
      error: { code: "POSITION_EXISTS", message: "position 'review' already exists" },
    });
  });

  it("400s an invalid role name", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/positions",
      postJson({ role: "Bad Name!", position: { models: [] } }),
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: {
        code: "INVALID_ROLE",
        message: "invalid role name 'Bad Name!' (must match ^[a-z][a-z0-9_-]{0,31}$)",
      },
    });
  });

  it("400s a missing role", async () => {
    const harness = await startHarness();
    const res = await harness.request("/config/positions", postJson({ position: { models: [] } }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: { code: "INVALID_FIELD", message: "role is required (a non-empty string)" },
    });
  });

  it("400s a body that is not valid JSON", async () => {
    const harness = await startHarness();
    const res = await harness.request("/config/positions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: { code: "INVALID_FIELD", message: "body must be valid JSON" },
    });
  });
});

describe("PUT /config/positions/{role} (backend.py:249)", () => {
  it("replaces a default position", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/positions/leader",
      putJson({ models: ["omp/new"], instruction_mode: "replace" }),
    );
    expect(res.status).toBe(200);
    expect((await json(res))["position"]).toMatchObject({
      models: ["omp/new"],
      instruction_mode: "replace",
    });
  });

  it("404s an unknown role and lists the known ones sorted", async () => {
    const harness = await startHarness();
    const res = await harness.request("/config/positions/ghost", putJson({ models: [] }));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({
      error: {
        code: "POSITION_NOT_FOUND",
        message: "unknown position: ghost (known: consult, dev, leader, orchestrator, review)",
      },
    });
  });

  it("400s an unknown position field, naming them sorted", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/positions/leader",
      putJson({ models: [], zeta: 1, alpha: 2 }),
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: { code: "UNKNOWN_FIELD", message: "unknown position field(s): alpha, zeta" },
    });
  });

  it("400s a position with no models", async () => {
    const harness = await startHarness();
    const res = await harness.request("/config/positions/leader", putJson({ note: "x" }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: { code: "INVALID_FIELD", message: "position.models is required" },
    });
  });

  it("400s a bad instruction_mode", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/positions/leader",
      putJson({ models: [], instruction_mode: "nope" }),
    );
    expect(res.status).toBe(400);
    const failure = (await json(res))["error"] as Record<string, unknown>;
    expect(failure["code"]).toBe("INVALID_FIELD");
    expect(failure["message"]).toBe("instruction_mode must be 'extend' or 'replace', got 'nope'");
  });

  it("400s an out-of-range wakes_per_life", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/positions/leader",
      putJson({ models: [], wakes_per_life: 99999 }),
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: {
        code: "INVALID_FIELD",
        message: "wakes_per_life must be an int in 1..10000, got 99999",
      },
    });
  });

  it("400s an unknown model field", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/positions/leader",
      putJson({ models: [{ model: "omp/m", nope: 1 }] }),
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: { code: "UNKNOWN_FIELD", message: "models[0]: unknown model field(s): nope" },
    });
  });

  it("400s an unknown harness, naming the known ones in order", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/positions/leader",
      putJson({ models: [{ model: "omp/m", harness: "paseo" }] }),
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: {
        code: "INVALID_HARNESS",
        message: "models[0]: unknown harness 'paseo' (known: omp, opencode, pi, dsh, claude)",
      },
    });
  });

  it("accepts an explicit null for a cleared optional model field", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/positions/leader",
      putJson({ models: [{ model: "omp/m", mode: null }] }),
    );
    expect(res.status).toBe(200);
  });
});

describe("PUT /config/timings (backend.py:270)", () => {
  const valid = {
    checkup_cron: "*/8 * * * *",
    deep_tick_cron: "0 */6 * * *",
    timezone: "Asia/Ho_Chi_Minh",
    usage_max_age_s: 600,
  };

  it("replaces the timings and echoes them in TIMINGS_KEYS order", async () => {
    const harness = await startHarness();
    const res = await harness.request("/config/timings", putJson(valid));
    expect(res.status).toBe(200);
    const timings = (await json(res))["timings"] as Record<string, unknown>;
    expect(Object.keys(timings)).toEqual([
      "checkup_cron",
      "deep_tick_cron",
      "timezone",
      "usage_max_age_s",
    ]);
    expect(timings["checkup_cron"]).toBe("*/8 * * * *");
    // The read path must now observe the write.
    const config = await json(await harness.get("/config"));
    expect((config["timings"] as Record<string, unknown>)["usage_max_age_s"]).toBe(600);
  });

  it("400s a missing key, listing them in TIMINGS_KEYS order", async () => {
    const harness = await startHarness();
    const res = await harness.request("/config/timings", putJson({ checkup_cron: "* * * * *" }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: {
        code: "INVALID_FIELD",
        message: "missing timing field(s): deep_tick_cron, timezone, usage_max_age_s",
      },
    });
  });

  it("400s an unknown key", async () => {
    const harness = await startHarness();
    const res = await harness.request("/config/timings", putJson({ ...valid, nope: 1 }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: { code: "UNKNOWN_FIELD", message: "unknown timing field(s): nope" },
    });
  });

  it("400s a malformed cron, prefixed with the field name", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/timings",
      putJson({ ...valid, checkup_cron: "not a cron" }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_CRON");
    expect(
      String((body["error"] as Record<string, unknown>)["message"]).startsWith("checkup_cron: "),
    ).toBe(true);
  });

  it("400s an unknown timezone", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/timings",
      putJson({ ...valid, timezone: "Mars/Olympus" }),
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: { code: "INVALID_TIMING", message: "unknown timezone 'Mars/Olympus'" },
    });
  });

  it("400s an out-of-range usage_max_age_s with one message for type and range", async () => {
    const harness = await startHarness();
    const res = await harness.request(
      "/config/timings",
      putJson({ ...valid, usage_max_age_s: 30 }),
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: {
        code: "INVALID_TIMING",
        message: "usage_max_age_s must be an int between 60 and 86400, got 30",
      },
    });
  });
});

describe("router edge cases", () => {
  it("404s an unmatched path with Starlette's body", async () => {
    const harness = await startHarness();
    const res = await harness.get("/nope");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ detail: "Not Found" });
  });

  it("405s a known path with the wrong method", async () => {
    const harness = await startHarness();
    const res = await harness.request("/health", { method: "POST" });
    expect(res.status).toBe(405);
    expect(await json(res)).toEqual({ detail: "Method Not Allowed" });
  });

  it("does not treat /tools/ with an empty name as a tool call", async () => {
    const harness = await startHarness();
    const res = await harness.request("/tools/", postJson({}));
    expect(res.status).toBe(404);
  });

  it("404s a nested tool path rather than dispatching a slashed name", async () => {
    const harness = await startHarness();
    const res = await harness.request("/tools/fleet/recommend", postJson({}));
    expect(res.status).toBe(404);
  });
});
