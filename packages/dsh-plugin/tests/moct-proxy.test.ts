// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "../src/index";
import { matchMoctRoute, MOCT_PREFIX, MoctProxy, resolveMoctSettings } from "../src/moct-proxy";

const TOKEN = "mul_test_token";
const WORKSPACE = "98a1c260-dc0a-469d-8f4f-27c35c5a56cb";
const OTHER_WORKSPACE = "11111111-2222-4333-8444-555555555555";
const ACTOR = "26a523af-37a5-4d83-b281-24c58109a772";
const AGENT = "bd7b7aae-88e9-4260-a7b5-301993757e59";
const RECORD = "mem_0b9f2a51-7f43-4d1a-9d3e-0f5a3c1b2d44";
const OTHER_RECORD = "mem_5c1d8e77-2a3b-4c5d-8e9f-0a1b2c3d4e5f";

interface Call {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface FixtureOptions {
  workspaces: { id: string; slug: string }[];
  role: string | null;
  membersStatus: number;
  agents: string[];
  records: Record<string, { id: string; workspaceId: string | null }>;
  workspacesStatus: number;
  health: { ok: boolean; schema: number };
}

interface Fixture {
  base: string;
  /** Every request the fake moct-be saw. */
  moct: Call[];
  /** Every request the fake multica-be saw. */
  multica: Call[];
  options: FixtureOptions;
  /** Take moct-be away, leaving the front server up. */
  stopMoct: () => Promise<void>;
}

const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => close(server)));
});

async function startFixture(overrides: Partial<FixtureOptions> = {}): Promise<Fixture> {
  const options: FixtureOptions = {
    workspaces: [
      { id: WORKSPACE, slug: "dsh-z" },
      { id: OTHER_WORKSPACE, slug: "elsewhere" },
    ],
    role: "owner",
    membersStatus: 200,
    agents: [AGENT],
    records: { [RECORD]: { id: RECORD, workspaceId: WORKSPACE } },
    workspacesStatus: 200,
    health: { ok: true, schema: 8 },
    ...overrides,
  };

  const moct: Call[] = [];
  const moctServer = createServer((req, res) => {
    readBody(req, (text) => {
      moct.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body: text });
      respondAsMoct(req, res, options, text);
    });
  });
  await listen(moctServer);

  const multicaCalls: Call[] = [];
  const multicaServer = createServer((req, res) => {
    readBody(req, (text) => {
      multicaCalls.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: text,
      });
      respondAsMultica(req, res, options);
    });
  });
  await listen(multicaServer);

  const proxy = new MoctProxy({
    moctUrl: `http://127.0.0.1:${port(moctServer)}`,
    multica: {
      serverUrl: `http://127.0.0.1:${port(multicaServer)}`,
      token: TOKEN,
      workspaceSlug: "dsh-z",
      workspaceFolder: "",
    },
  });
  const front = createServer((req, res) => {
    void proxy.handle(req, res);
  });
  await listen(front);

  return {
    base: `http://127.0.0.1:${port(front)}`,
    moct,
    multica: multicaCalls,
    options,
    stopMoct: () => close(moctServer),
  };
}

function respondAsMoct(
  req: IncomingMessage,
  res: ServerResponse,
  options: FixtureOptions,
  body: string,
): void {
  const url = new URL(req.url ?? "/", "http://moct.invalid");
  if (url.pathname === "/team/v1/health") {
    // The real route also reports its database path; nothing may relay it.
    send(res, 200, { ...options.health, dbPath: "/secret/fleet.db" });
    return;
  }
  if (url.pathname === "/team/v1/memory" && req.method === "GET") {
    send(res, 200, { results: [], total: 0, nextCursor: null });
    return;
  }
  if (url.pathname === "/team/v1/memory/usage") {
    send(res, 200, { workspaceId: url.searchParams.get("workspaceId"), capTokens: 2000, homes: [] });
    return;
  }
  if (url.pathname === "/team/v1/memory/get" && req.method === "POST") {
    const parsed = JSON.parse(body) as { ids?: string[] };
    const records = (parsed.ids ?? [])
      .map((id) => options.records[id])
      .filter((record): record is { id: string; workspaceId: string | null } => record !== undefined);
    send(res, 200, { records, missing: [] });
    return;
  }
  const byId = /^\/team\/v1\/memory\/([^/]+)\/(versions|approve|retract)$/.exec(url.pathname);
  if (byId !== null) {
    if (byId[2] === "versions") {
      send(res, 200, { versions: [] });
      return;
    }
    const parsed = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
    send(res, 200, { id: byId[1], ...parsed, status: byId[2] === "approve" ? "active" : "retracted" });
    return;
  }
  send(res, 404, { ok: false, error: "not found" });
}

function respondAsMultica(req: IncomingMessage, res: ServerResponse, options: FixtureOptions): void {
  const url = req.url ?? "/";
  if (url === "/api/workspaces") {
    if (options.workspacesStatus !== 200) {
      send(res, options.workspacesStatus, { error: "boom" });
      return;
    }
    send(res, 200, options.workspaces);
    return;
  }
  if (url === "/api/me") {
    send(res, 200, { id: ACTOR });
    return;
  }
  if (url.startsWith("/api/workspaces/") && url.endsWith("/members")) {
    if (options.membersStatus !== 200) {
      send(res, options.membersStatus, { error: "no members" });
      return;
    }
    send(res, 200, [{ user_id: ACTOR, role: options.role }]);
    return;
  }
  if (url.startsWith("/api/agents/")) {
    const id = url.slice("/api/agents/".length);
    if (options.agents.includes(id)) send(res, 200, { id });
    else send(res, 404, { error: "not found" });
    return;
  }
  send(res, 404, { error: "not found" });
}

describe("matchMoctRoute", () => {
  it("names the seven routes and nothing else", () => {
    expect(matchMoctRoute("GET", "/status").route).toEqual({ kind: "status" });
    expect(matchMoctRoute("GET", "/team/v1/memory").route).toEqual({ kind: "list" });
    expect(matchMoctRoute("POST", "/team/v1/memory/get").route).toEqual({ kind: "get" });
    expect(matchMoctRoute("GET", "/team/v1/memory/usage").route).toEqual({ kind: "usage" });
    expect(matchMoctRoute("GET", `/team/v1/memory/${RECORD}/versions`).route).toEqual({
      kind: "versions",
      id: RECORD,
    });
    expect(matchMoctRoute("POST", `/team/v1/memory/${RECORD}/approve`).route).toEqual({
      kind: "approve",
      id: RECORD,
    });
    expect(matchMoctRoute("POST", `/team/v1/memory/${RECORD}/retract`).route).toEqual({
      kind: "retract",
      id: RECORD,
    });
  });

  it("refuses every other moct-be route", () => {
    for (const [method, path] of [
      ["POST", "/team/v1/memory"],
      ["PATCH", `/team/v1/memory/${RECORD}`],
      ["POST", `/team/v1/memory/${RECORD}/purge`],
      ["POST", `/team/v1/memory/${RECORD}/widen`],
      ["POST", `/team/v1/memory/${RECORD}/restore`],
      ["GET", "/team/v1/memory/rule-feed"],
      ["GET", "/team/v1/memory/inject"],
      ["GET", "/team/v1/memory/settings"],
      ["GET", "/team/v1/health"],
      ["GET", "/"],
    ] as const) {
      expect(matchMoctRoute(method, path).reason, `${method} ${path}`).toBe("not-found");
    }
  });

  it("answers 405 for an allowed path with the wrong method", () => {
    expect(matchMoctRoute("DELETE", "/team/v1/memory/usage").reason).toBe("method-not-allowed");
    expect(matchMoctRoute("GET", `/team/v1/memory/${RECORD}/approve`).reason).toBe(
      "method-not-allowed",
    );
    // POST /memory is the excluded note route, so it is absent rather than 405.
    expect(matchMoctRoute("POST", "/team/v1/memory").reason).toBe("not-found");
  });

  it("refuses an id that is not one opaque segment", () => {
    expect(matchMoctRoute("GET", "/team/v1/memory/../etc/versions").reason).toBe("not-found");
    expect(matchMoctRoute("GET", "/team/v1/memory/a%2Fb/versions").reason).toBe("not-found");
    expect(matchMoctRoute("GET", `/team/v1/memory/${"x".repeat(65)}/versions`).reason).toBe(
      "not-found",
    );
  });
});

describe("resolveMoctSettings", () => {
  const multica = { serverUrl: "http://127.0.0.1:4390", token: TOKEN, workspaceSlug: "dsh-z", workspaceFolder: "" };

  it("reads the row, then the environment", () => {
    expect(resolveMoctSettings({ moctUrl: "http://127.0.0.1:8310/" }, multica, {}).settings).toEqual({
      moctUrl: "http://127.0.0.1:8310",
      multica,
    });
    expect(
      resolveMoctSettings({}, multica, { MOCT_BASE_URL: "http://127.0.0.1:8310" }).settings?.moctUrl,
    ).toBe("http://127.0.0.1:8310");
  });

  it("names what is missing or unsafe", () => {
    expect(resolveMoctSettings({}, multica, {}).problem).toBe("moctUrl is not set");
    expect(resolveMoctSettings({ moctUrl: "nope" }, multica, {}).problem).toBe(
      "moctUrl is not a URL",
    );
    expect(resolveMoctSettings({ moctUrl: "ftp://127.0.0.1" }, multica, {}).problem).toBe(
      "moctUrl must be http or https",
    );
    expect(resolveMoctSettings({ moctUrl: "http://moct.example.com" }, multica, {}).problem).toBe(
      "moctUrl must name a loopback or private host",
    );
    expect(resolveMoctSettings({ moctUrl: "http://127.0.0.1:8310" }, null, {}).problem).toBe(
      "multica is not configured",
    );
  });
});

describe("MoctProxy allow-list", () => {
  it("forwards an allowed read once, with the exact rewritten path", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory?status=pending`);
    expect(response.status).toBe(200);
    expect(fixture.moct).toHaveLength(1);
    const url = new URL(fixture.moct[0]!.url, "http://moct.invalid");
    expect(url.pathname).toBe("/team/v1/memory");
    expect(url.searchParams.get("status")).toBe("pending");
  });

  it("answers 404 for an excluded route without calling moct-be", async () => {
    const fixture = await startFixture();
    for (const [method, path] of [
      ["POST", "/team/v1/memory"],
      ["POST", `/team/v1/memory/${RECORD}/purge`],
      ["GET", "/team/v1/memory/settings"],
      ["GET", "/team/v1/health"],
    ] as const) {
      const response = await fetch(`${fixture.base}${MOCT_PREFIX}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(fixture.moct).toHaveLength(0);
  });

  it("answers 405 for an allowed path with the wrong method", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory/usage`, {
      method: "DELETE",
    });
    expect(response.status).toBe(405);
    expect(fixture.moct).toHaveLength(0);
  });
});

describe("MoctProxy workspace injection", () => {
  it("replaces every client-supplied scope value on a read", async () => {
    const fixture = await startFixture();
    // The filter vocabulary the Memory page (S2-D) builds its queries from:
    // q, types, homes, status, limit and cursor are the reader's; every scope
    // value around them is the host's.
    await fetch(
      `${fixture.base}${MOCT_PREFIX}/team/v1/memory?workspaceId=multica:ws:${OTHER_WORKSPACE}` +
        `&expertId=multica:agent:${OTHER_WORKSPACE}&all=0&q=suite&types=decision&homes=expert&status=all` +
        `&limit=99&attrs=x&cursor=abc`,
    );
    const url = new URL(fixture.moct[0]!.url, "http://moct.invalid");
    expect(url.searchParams.getAll("workspaceId")).toEqual([`multica:ws:${WORKSPACE}`]);
    expect(url.searchParams.getAll("expertId")).toEqual([`multica:user:${ACTOR}`]);
    expect(url.searchParams.getAll("all")).toEqual(["1"]);
    expect(url.searchParams.get("q")).toBe("suite");
    expect(url.searchParams.get("types")).toBe("decision");
    expect(url.searchParams.get("homes")).toBe("expert");
    expect(url.searchParams.get("status")).toBe("all");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("cursor")).toBe("abc");
    expect(url.searchParams.has("attrs")).toBe(false);
  });

  it("rewrites the body of a get and drops what it does not own", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory/get`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [RECORD],
        workspaceId: `multica:ws:${OTHER_WORKSPACE}`,
        expertId: "multica:agent:evil",
        actor: { kind: "human", id: "multica:user:someone" },
      }),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(fixture.moct[0]!.body)).toEqual({ ids: [RECORD] });
    const url = new URL(fixture.moct[0]!.url, "http://moct.invalid");
    expect(url.searchParams.get("workspaceId")).toBe(`multica:ws:${WORKSPACE}`);
  });

  it("ignores a client X-Workspace-ID instead of honouring it", async () => {
    const fixture = await startFixture();
    await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory`, {
      headers: { "x-workspace-id": OTHER_WORKSPACE },
    });
    const url = new URL(fixture.moct[0]!.url, "http://moct.invalid");
    expect(url.searchParams.get("workspaceId")).toBe(`multica:ws:${WORKSPACE}`);
    expect(fixture.moct[0]!.url).not.toContain(OTHER_WORKSPACE);
  });

  it("fails closed when the configured slug is not readable", async () => {
    const fixture = await startFixture({ workspaces: [{ id: OTHER_WORKSPACE, slug: "elsewhere" }] });
    const response = await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory`);
    expect(response.status).toBe(503);
    expect(fixture.moct).toHaveLength(0);
  });

  it("answers 503 when multica cannot name a workspace", async () => {
    const fixture = await startFixture({ workspaces: [] });
    const response = await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory`);
    expect(response.status).toBe(503);
    expect(fixture.moct).toHaveLength(0);
  });

  it("scopes an agent page to that agent when it is in the workspace", async () => {
    const fixture = await startFixture();
    await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory?expertAgentId=${AGENT}`);
    const url = new URL(fixture.moct[0]!.url, "http://moct.invalid");
    expect(url.searchParams.get("expertId")).toBe(`multica:agent:${AGENT}`);
    expect(url.searchParams.get("all")).toBe("1");
  });

  it("refuses an agent that the workspace does not have", async () => {
    const fixture = await startFixture({ agents: [] });
    const response = await fetch(
      `${fixture.base}${MOCT_PREFIX}/team/v1/memory?expertAgentId=${AGENT}`,
    );
    expect(response.status).toBe(403);
    expect(fixture.moct).toHaveLength(0);
  });
});

describe("MoctProxy by-id guards", () => {
  it("refuses a record the workspace cannot see, before any verb", async () => {
    const fixture = await startFixture({ records: {} });
    const response = await fetch(
      `${fixture.base}${MOCT_PREFIX}/team/v1/memory/${OTHER_RECORD}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseVersion: 1 }),
      },
    );
    expect(response.status).toBe(404);
    expect(fixture.moct.map((call) => new URL(call.url, "http://moct.invalid").pathname)).toEqual([
      "/team/v1/memory/get",
    ]);
  });

  it("serves versions for a record the workspace can see", async () => {
    const fixture = await startFixture();
    const response = await fetch(
      `${fixture.base}${MOCT_PREFIX}/team/v1/memory/${RECORD}/versions`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ versions: [] });
  });

  it("refuses to approve a record that belongs to no workspace", async () => {
    const fixture = await startFixture({
      records: { [RECORD]: { id: RECORD, workspaceId: null } },
    });
    const response = await fetch(
      `${fixture.base}${MOCT_PREFIX}/team/v1/memory/${RECORD}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseVersion: 2 }),
      },
    );
    expect(response.status).toBe(403);
    // The scoped lookup only; no verb was forwarded.
    expect(fixture.moct).toHaveLength(1);
  });

  it("approves with the host's actor and only the fields moct needs", async () => {
    const fixture = await startFixture();
    const response = await fetch(
      `${fixture.base}${MOCT_PREFIX}/team/v1/memory/${RECORD}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseVersion: 3,
          reason: "published by the owner",
          actor: { kind: "human", id: "multica:user:someone-else" },
          workspaceId: `multica:ws:${OTHER_WORKSPACE}`,
        }),
      },
    );
    expect(response.status).toBe(200);
    const write = fixture.moct[1]!;
    expect(new URL(write.url, "http://moct.invalid").pathname).toBe(
      `/team/v1/memory/${RECORD}/approve`,
    );
    expect(JSON.parse(write.body)).toEqual({
      baseVersion: 3,
      actor: { kind: "human", id: `multica:user:${ACTOR}` },
      reason: "published by the owner",
    });
  });

  it("gates a write on the workspace role", async () => {
    const fixture = await startFixture({ role: "member" });
    const response = await fetch(
      `${fixture.base}${MOCT_PREFIX}/team/v1/memory/${RECORD}/retract`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseVersion: 1 }),
      },
    );
    expect(response.status).toBe(403);
    expect(fixture.moct).toHaveLength(1);
  });

  it("records the gap when the role cannot be read at all", async () => {
    const fixture = await startFixture({ membersStatus: 500 });
    const response = await fetch(
      `${fixture.base}${MOCT_PREFIX}/team/v1/memory/${RECORD}/retract`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseVersion: 1 }),
      },
    );
    expect(response.status).toBe(200);
    expect(fixture.moct).toHaveLength(2);
  });

  it("refuses a write whose baseVersion is not the one shown", async () => {
    const fixture = await startFixture();
    const response = await fetch(
      `${fixture.base}${MOCT_PREFIX}/team/v1/memory/${RECORD}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseVersion: "3" }),
      },
    );
    expect(response.status).toBe(400);
    expect(fixture.moct).toHaveLength(1);
  });
});

describe("MoctProxy request hygiene", () => {
  it("requires a JSON content type on writes", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory/get`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "ids=a",
    });
    expect(response.status).toBe(415);
    expect(fixture.moct).toHaveLength(0);
  });

  it("refuses a cross-origin request", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory`, {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(fixture.moct).toHaveLength(0);
  });

  it("answers status without moct-be's filesystem path", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.base}${MOCT_PREFIX}/status`);
    expect(await response.json()).toEqual({ ok: true, schema: 8, reachable: true });
    const text = await (await fetch(`${fixture.base}${MOCT_PREFIX}/status`)).text();
    expect(text).not.toContain("fleet.db");
  });

  it("reports moct-be as unreachable instead of failing the status route", async () => {
    const fixture = await startFixture();
    await fixture.stopMoct();
    const response = await fetch(`${fixture.base}${MOCT_PREFIX}/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, schema: null, reachable: false });
  });
});

describe("MoctProxy identity cache", () => {
  it("resolves the workspace once for many requests", async () => {
    const fixture = await startFixture();
    await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory`);
    await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory`);
    expect(fixture.multica.filter((call) => call.url === "/api/workspaces")).toHaveLength(1);
  });

  it("re-reads after the TTL and keeps the last good identity when that fails", async () => {
    const fixture = await startFixture();
    await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory`);

    const later = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory`);
    expect(fixture.multica.filter((call) => call.url === "/api/workspaces")).toHaveLength(2);

    fixture.options.workspacesStatus = 500;
    vi.spyOn(Date, "now").mockReturnValue(later + 61_000);
    const response = await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory`);
    expect(response.status).toBe(200);
    const url = new URL(fixture.moct.at(-1)!.url, "http://moct.invalid");
    expect(url.searchParams.get("workspaceId")).toBe(`multica:ws:${WORKSPACE}`);
  });

  it("fails closed when the cached workspace stops being readable", async () => {
    const fixture = await startFixture();
    await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory`);

    fixture.options.workspaces = [{ id: OTHER_WORKSPACE, slug: "elsewhere" }];
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    const response = await fetch(`${fixture.base}${MOCT_PREFIX}/team/v1/memory`);
    expect(response.status).toBe(503);
    expect(fixture.moct).toHaveLength(1);
  });
});

describe("plugin registration", () => {
  interface Route {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => unknown;
  }

  async function mountPrefix(
    rejection: number | undefined,
    config: Record<string, unknown>,
  ): Promise<{ base: string; moctCalls: string[] }> {
    const routes: Route[] = [];
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      webServer: {
        register: (route: Route) => {
          routes.push(route);
          return () => {};
        },
        registerUpgrade: () => () => {},
      },
      connection: { requestRejection: () => rejection },
    };
    const moctCalls: string[] = [];
    const moctServer = createServer((req, res) => {
      moctCalls.push(req.url ?? "/");
      send(res, 200, { ok: true, schema: 8 });
    });
    await listen(moctServer);

    apply(ctx as never, {
      serverUrl: "http://127.0.0.1:1",
      token: TOKEN,
      workspaceSlug: "dsh-z",
      ...config,
      ...(config["moctUrl"] === undefined
        ? {}
        : { moctUrl: `http://127.0.0.1:${port(moctServer)}` }),
    });

    const route = routes.find((candidate) => candidate.path === MOCT_PREFIX);
    expect(route).toBeDefined();
    const server = createServer((req, res) => void route!.handler(req, res));
    await listen(server);
    return { base: `http://127.0.0.1:${port(server)}`, moctCalls };
  }

  it("answers 403 on /moct when the dsh session gate refuses the request", async () => {
    const { base, moctCalls } = await mountPrefix(403, { moctUrl: "set" });
    const response = await fetch(`${base}${MOCT_PREFIX}/status`);
    expect(response.status).toBe(403);
    expect(moctCalls).toHaveLength(0);
  });

  it("answers 503 with the reason when moctUrl is not configured", async () => {
    vi.stubEnv("MOCT_BASE_URL", "");
    const { base } = await mountPrefix(undefined, {});
    const response = await fetch(`${base}${MOCT_PREFIX}/status`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "moctUrl is not set" });
  });
});

// --- fixture plumbing -------------------------------------------------------

function readBody(req: IncomingMessage, done: (text: string) => void): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function listen(server: Server): Promise<void> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
