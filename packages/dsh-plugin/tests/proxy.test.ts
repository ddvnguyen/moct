// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  AUTH_COOKIE,
  MulticaProxy,
  PROXY_WS_PATH,
  resolveSettings,
  upstreamTarget,
} from "../src/proxy";

const TOKEN = "mul_test_token";

interface Fixture {
  proxy: MulticaProxy;
  base: string;
  close: () => Promise<void>;
  seen: { path?: string; headers?: Record<string, unknown>; wsHeaders?: Record<string, string | string[] | undefined> };
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function startFixture(): Promise<Fixture> {
  const seen: Fixture["seen"] = {};
  const upstreamWss = new WebSocketServer({ noServer: true });

  const upstream = createServer((req, res) => {
    seen.path = req.url;
    seen.headers = req.headers;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization }));
  });
  upstream.on("upgrade", (req, socket, head) => {
    seen.wsHeaders = req.headers;
    upstreamWss.handleUpgrade(req, socket, head, (socketConnection) => {
      upstreamWss.emit("connection", socketConnection, req);
    });
  });
  upstreamWss.on("connection", (socket) => {
    socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
  });

  await listen(upstream);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const proxy = new MulticaProxy({
    serverUrl: `http://127.0.0.1:${upstreamPort}`,
    token: TOKEN,
    workspaceSlug: "", workspaceFolder: "",
  });

  const front = createServer((req, res) => {
    void proxy.handleHttp(req, res);
  });
  front.on("upgrade", (req, socket, head) => {
    proxy.handleUpgrade(req, socket, head);
  });
  await listen(front);
  const frontPort = (front.address() as AddressInfo).port;

  const fixture: Fixture = {
    proxy,
    base: `http://127.0.0.1:${frontPort}`,
    seen,
    close: async () => {
      upstreamWss.close();
      await close(front);
      await close(upstream);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

describe("resolveSettings", () => {
  it("accepts config from the row", () => {
    const { settings, problem } = resolveSettings({
      serverUrl: "http://127.0.0.1:8080/",
      token: TOKEN,
      workspaceSlug: "demo",
    });
    expect(problem).toBeNull();
    expect(settings).toEqual({
      serverUrl: "http://127.0.0.1:8080",
      token: TOKEN,
      workspaceSlug: "demo",
      workspaceFolder: "",
    });
  });

  it("falls back to the process environment", () => {
    const { settings } = resolveSettings(
      {},
      { MULTICA_DSH_SERVER_URL: "https://multica.example", MULTICA_DSH_TOKEN: TOKEN },
    );
    expect(settings?.serverUrl).toBe("https://multica.example");
    expect(settings?.token).toBe(TOKEN);
  });

  // M-159: the "All projects" folder round-trips with the rest of the row.
  it("carries workspaceFolder with the env fallback", () => {
    const fromRow = resolveSettings({
      serverUrl: "http://127.0.0.1:8080",
      token: TOKEN,
      workspaceFolder: " /srv/demo ",
    });
    expect(fromRow.settings?.workspaceFolder).toBe("/srv/demo");
    const fromEnv = resolveSettings(
      { serverUrl: "http://x", token: TOKEN },
      { MULTICA_DSH_WORKSPACE_FOLDER: "/srv/env" },
    );
    expect(fromEnv.settings?.workspaceFolder).toBe("/srv/env");
    const without = resolveSettings({ serverUrl: "http://x", token: TOKEN });
    expect(without.settings?.workspaceFolder).toBe("");
  });

  it("names what is missing instead of throwing", () => {
    expect(resolveSettings({}).problem).toBe("serverUrl is not set");
    expect(resolveSettings({ serverUrl: "http://x" }).problem).toBe("token is not set");
    expect(resolveSettings({ serverUrl: "nope", token: TOKEN }).problem).toBe(
      "serverUrl is not a URL",
    );
  });
});

describe("upstreamTarget", () => {
  const settings = { serverUrl: "http://be", token: TOKEN, workspaceSlug: "", workspaceFolder: "" };
  it("strips the prefix and keeps the query", () => {
    expect(upstreamTarget(settings, "/multica/api/issues?limit=2")?.url.toString()).toBe(
      "http://be/api/issues?limit=2",
    );
  });
  it("refuses a path outside the prefix", () => {
    expect(upstreamTarget(settings, "/api/issues")).toBeNull();
  });
});

describe("MulticaProxy HTTP", () => {
  it("re-issues the request with the host token", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.base}/multica/api/me`, {
      headers: {
        // The browser's own credentials belong to dsh and must not travel.
        authorization: "Bearer dsh-session",
        cookie: "dsh=1",
        origin: "http://localhost:3000",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/api/me",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(fixture.seen.headers?.cookie).toBeUndefined();
    expect(fixture.seen.headers?.origin).toBeUndefined();
  });

  it("streams the upstream status and body for a missing route", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.base}/multica/does-not-exist`);
    expect(response.status).toBe(200);
    expect(fixture.seen.path).toBe("/does-not-exist");
  });

  it("answers 400 when a plain request hits the realtime path", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.base}${PROXY_WS_PATH}`);
    expect(response.status).toBe(400);
  });
});

describe("MulticaProxy WebSocket", () => {
  it("authenticates the upgrade with the host token and relays both ways", async () => {
    const fixture = await startFixture();
    const socket = new WebSocket(
      `${fixture.base.replace("http", "ws")}${PROXY_WS_PATH}?workspace_slug=demo`,
    );
    await once(socket, "open");
    socket.send("hello");
    const [reply] = await once(socket, "message");
    expect(String(reply)).toBe("echo:hello");
    expect(fixture.seen.wsHeaders?.["cookie"]).toBe(`${AUTH_COOKIE}=${TOKEN}`);
    expect(fixture.seen.wsHeaders?.["authorization"]).toBe(`Bearer ${TOKEN}`);
    socket.close();
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // Relayed sockets keep a Node server open; the fixture owns them.
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function once(socket: WebSocket, event: "open" | "message"): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    socket.once(event, (...args: unknown[]) => {
      socket.off("error", onError);
      resolve(args);
    });
    socket.once("error", onError);
  });
}
