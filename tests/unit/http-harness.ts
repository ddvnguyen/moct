/**
 * Shared HTTP-surface test harness.
 *
 * Runs the real server against a REAL scratch fleet.db on an ephemeral port —
 * no mocked Store. The repo's testing rule is real dependencies over mocks, and
 * a fake store would hide exactly the thing this surface must get right (one
 * long-lived repository, never one per request).
 *
 * MCP_ORCH_STATE_DIR is pointed at the scratch dir for each test so the config
 * routes read and write there instead of at the repo's real orchestration state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { TursoRepository } from "../../src/store/turso-repository.js";
import { createFleetHttpServer, type HttpSurfaceOptions } from "../../src/surfaces/http/router.js";

export interface Harness {
  baseUrl: string;
  stateDir: string;
  summaryFile: string;
  store: TursoRepository;
  server: Server;
  get(path: string, init?: RequestInit): Promise<Response>;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

export async function startHarness(overrides: Partial<HttpSurfaceOptions> = {}): Promise<Harness> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "fleet-http-"));
  const previousStateDir = process.env["MCP_ORCH_STATE_DIR"];
  const previousSummary = process.env["MCP_ORCH_SUMMARY_PATH"];
  process.env["MCP_ORCH_STATE_DIR"] = stateDir;
  // Pin the summary file too, or the resource routes read the repo's real
  // orchestration.md and the assertions depend on whatever is committed there.
  const summaryFile = path.join(stateDir, "orchestration.md");
  process.env["MCP_ORCH_SUMMARY_PATH"] = summaryFile;

  const store = await TursoRepository.open(stateDir, path.join(stateDir, "fleet.db"));
  const server = createFleetHttpServer({ store, token: "", ...overrides });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const request = (target: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${baseUrl}${target}`, init);

  const harness: Harness = {
    baseUrl,
    stateDir,
    summaryFile,
    store,
    server,
    request,
    get: (target, init = {}) => request(target, { ...init, method: "GET" }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close().catch(() => undefined);
      if (previousStateDir === undefined) delete process.env["MCP_ORCH_STATE_DIR"];
      else process.env["MCP_ORCH_STATE_DIR"] = previousStateDir;
      if (previousSummary === undefined) delete process.env["MCP_ORCH_SUMMARY_PATH"];
      else process.env["MCP_ORCH_SUMMARY_PATH"] = previousSummary;
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
  cleanups.push(harness.close);
  return harness;
}

/** vitest afterEach for any file using startHarness. */
export async function cleanupHarnesses(): Promise<void> {
  while (cleanups.length > 0) {
    const close = cleanups.pop();
    await close?.();
  }
}

export function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

export function putJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { ...postJson(body, headers), method: "PUT" };
}
