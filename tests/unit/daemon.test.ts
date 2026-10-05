/**
 * Daemon boot + shutdown.
 *
 * The regression this guards is the one already paid for in blood on this
 * package: a dependency default that is not bound leaves `this` undefined at
 * call time, kills the entrypoint, and every other test stays green. So these
 * tests boot a REAL daemon against a REAL scratch fleet.db and drive it over a
 * real socket — and the signal path is exercised with injected handlers, the
 * same shape shutdown-wiring.test.ts uses.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registeredTools } from "../../src/tools/registry.js";
import { startDaemon, resolveEnv, type DaemonHandle } from "../../src/daemon.js";
import { TursoRepository } from "../../src/store/turso-repository.js";

const dirs: string[] = [];
const handles: DaemonHandle[] = [];

afterEach(async () => {
  while (handles.length > 0)
    await handles
      .pop()!
      .close()
      .catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function bootDaemon(overrides: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-daemon-"));
  dirs.push(dir);
  const store = await TursoRepository.open(dir, path.join(dir, "fleet.db"));
  const exit = vi.fn();
  const signals: Record<string, () => void> = {};
  const daemon = await startDaemon({
    store,
    host: "127.0.0.1",
    port: 0,
    deps: {
      exit,
      registerSignal: (signal, handler) => {
        signals[signal] = handler;
      },
    },
    ...overrides,
  });
  handles.push(daemon);
  return { daemon, store, exit, signals, dir };
}

describe("resolveEnv", () => {
  it("defaults to the Python service's address so a cutover keeps the port", () => {
    expect(resolveEnv({})).toMatchObject({ host: "127.0.0.1", port: 8099 });
  });

  it("honours the documented env vars", () => {
    const env = resolveEnv({
      ORCHESTRATION_BIND: "0.0.0.0",
      ORCHESTRATION_PORT: "9123",
      FLEET_DB_PATH: "/tmp/x/fleet.db",
    });
    expect(env).toMatchObject({ host: "0.0.0.0", port: 9123, dbPath: "/tmp/x/fleet.db" });
  });

  it("ignores MCP_ORCH_DB_PATH, which points at the live Python ledger", () => {
    const env = resolveEnv({ MCP_ORCH_DB_PATH: "/live/orchestration.sqlite" });
    expect(env.dbPath.endsWith("orchestration.sqlite")).toBe(false);
    expect(env.dbPath.endsWith("fleet.db")).toBe(true);
  });

  it("falls back to 8099 rather than NaN on an unparseable port", () => {
    expect(resolveEnv({ ORCHESTRATION_PORT: "not-a-port" }).port).toBe(8099);
  });
});

describe("daemon boot", () => {
  it("opens the store once and serves both REST surfaces over a real socket", async () => {
    const { daemon } = await bootDaemon();

    const health = await fetch(`${daemon.url}/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as Record<string, unknown>)["service"]).toBe(
      "orchestration-backend",
    );

    const schema = await fetch(`${daemon.url}/schema`);
    expect(schema.status).toBe(200);
    const tools = ((await schema.json()) as { tools: unknown[] }).tools;
    // Registry-sized, not a literal 26: /schema advertises the base snapshot PLUS
    // registered domains (Lane T adds team/team_join/team_resolve).
    expect(tools.length).toBe(registeredTools().size);
  });

  it("reports the port actually bound when asked for 0", async () => {
    const { daemon } = await bootDaemon();
    expect(daemon.port).toBeGreaterThan(0);
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);
  });

  it("keeps serving many sequential requests from the one open store", async () => {
    // The lock is the whole reason this is a daemon: a per-request repository
    // would re-open fleet.db on every call. Twenty calls, one store.
    const { daemon, store } = await bootDaemon();
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`${daemon.url}/tools/project_create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `p-${i}`, repos: [] }),
      });
      expect(res.status).toBe(200);
    }
    const projects = await store.listProjects();
    expect(projects.filter((p) => p.name.startsWith("p-"))).toHaveLength(20);
  });

  it("does not open fleet.db or bind a port merely by being imported", async () => {
    // The entrypoint guard: importing daemon.ts must be inert. If main() ran on
    // import it would grab a port here and every suite would collide.
    const before = process._getActiveHandles().length;
    await import("../../src/daemon.js");
    expect(process._getActiveHandles().length).toBe(before);
  });
});

describe("daemon shutdown", () => {
  it("closes the listener and the store exactly once on SIGTERM, then exits 0", async () => {
    const { daemon, store, exit, signals } = await bootDaemon();
    const closeSpy = vi.spyOn(store, "close");

    signals["SIGTERM"]!();
    // wireShutdown's close is fire-and-forget; give the chain room to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    await expect(fetch(`${daemon.url}/health`)).rejects.toBeDefined();
  });

  it("closes the store exactly once even if both signals arrive", async () => {
    const { store, signals } = await bootDaemon();
    const closeSpy = vi.spyOn(store, "close");
    signals["SIGTERM"]!();
    signals["SIGINT"]!();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(closeSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("is idempotent when close() is called directly twice", async () => {
    const { daemon, store } = await bootDaemon();
    const closeSpy = vi.spyOn(store, "close");
    await daemon.close();
    await daemon.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("streamable /mcp", () => {
  async function initialize(daemon: DaemonHandle) {
    return fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "smoke", version: "0.0.0" },
        },
      }),
    });
  }

  it("completes an initialize handshake and reports the server identity", async () => {
    const { daemon } = await bootDaemon();
    const res = await initialize(daemon);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const payload = raw.startsWith("event:")
      ? raw
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim()
      : raw;
    const message = JSON.parse(payload!) as {
      result: {
        serverInfo: { name: string; version: string };
        capabilities: Record<string, unknown>;
      };
    };
    expect(message.result.serverInfo.name).toBe("orchestration");
    expect(message.result.capabilities["tools"]).toBeDefined();
  });

  it("lists the session's tier-filtered tools, a subset of what /schema advertises", async () => {
    const { daemon } = await bootDaemon();
    await initialize(daemon);
    const res = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const payload = raw.startsWith("event:")
      ? raw
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim()
      : raw;
    const message = JSON.parse(payload!) as { result: { tools: Array<{ name: string }> } };
    const names = message.result.tools.map((t) => t.name).sort();

    // The two surfaces answer DIFFERENT questions on purpose: tools/list is
    // what this session may call (tier-filtered by MCP_ORCH_TIER resolution),
    // while /schema is the full catalogue a thin stdio client browses. So
    // tools/list must be a SUBSET, never equal — pinning equality here would
    // quietly re-introduce the filtering bug the unfiltered accessor prevents.
    const schema = (await (await fetch(`${daemon.url}/schema`)).json()) as {
      tools: Array<{ name: string }>;
    };
    const schemaNames = schema.tools.map((t) => t.name);
    expect(schemaNames).toHaveLength(registeredTools().size);
    for (const name of names) expect(schemaNames).toContain(name);
    // worker_evaluate is TOOL_UTILITY, so it is outside the default leader tier.
    expect(names).not.toContain("worker_evaluate");
    expect(schemaNames).toContain("worker_evaluate");
  });

  it("answers a malformed JSON body with a JSON-RPC parse error, not a crash", async () => {
    const { daemon } = await bootDaemon();
    const res = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const message = (await res.json()) as { error: { code: number } };
    expect(message.error.code).toBe(-32700);
    // The daemon must still be alive afterwards.
    expect((await fetch(`${daemon.url}/health`)).status).toBe(200);
  });

  it("404s an unknown /mcp sub-path instead of swallowing it", async () => {
    const { daemon } = await bootDaemon();
    const res = await fetch(`${daemon.url}/mcp/nope`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
