/**
 * Auth parity for the REST surface — backend.py:56-92.
 *
 * Every assertion here is a contract with mcp_orchestration/tests/test_auth.py,
 * which asserts the same 401 body, the same protected routes and the same open
 * /health. The one behaviour NOT copied from the Python tests is the constant-
 * time path: test_auth.py cannot observe timing, so it is pinned here by
 * asserting that a length-mismatched token is rejected without throwing.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  UNAUTHORIZED_ERROR,
  UNAUTHORIZED_HINT,
  authorize,
  authToken,
  constantTimeEquals,
  isProtectedPath,
} from "../../src/surfaces/http/auth.js";
import { cleanupHarnesses, postJson, startHarness } from "./http-harness.js";

afterEach(cleanupHarnesses);

const TOKEN = "s3cret-token";

describe("protected-path predicate (backend.py:60-70)", () => {
  it("protects /schema exactly and by prefix", () => {
    expect(isProtectedPath("/schema")).toBe(true);
    expect(isProtectedPath("/schema/anything")).toBe(true);
  });

  it("protects /tools and /resources exactly and by prefix", () => {
    for (const path of [
      "/tools",
      "/tools/track_status",
      "/resources",
      "/resources/list",
      "/resources/read",
    ]) {
      expect(isProtectedPath(path)).toBe(true);
    }
  });

  it("leaves /health and /health/* open", () => {
    expect(isProtectedPath("/health")).toBe(false);
    expect(isProtectedPath("/health/deep")).toBe(false);
  });

  it("does not match a longer word that merely starts with a protected segment", () => {
    // `/schemax` and `/toolsy` are not the protected routes; treating them as
    // protected would lock down paths the Python service leaves open.
    expect(isProtectedPath("/schemax")).toBe(false);
    expect(isProtectedPath("/toolsy")).toBe(false);
    expect(isProtectedPath("/resourcesy")).toBe(false);
  });

  it("leaves /config open, matching _is_protected_path", () => {
    expect(isProtectedPath("/config")).toBe(false);
    expect(isProtectedPath("/config/timings")).toBe(false);
  });

  it("leaves /mcp open — backend.py does not protect it (pinned, see report)", () => {
    expect(isProtectedPath("/mcp")).toBe(false);
  });
});

describe("auth_token()", () => {
  it("treats an absent or blank token as auth disabled", () => {
    expect(authToken({})).toBe("");
    expect(authToken({ MCP_ORCH_AUTH_TOKEN: "" })).toBe("");
    expect(authToken({ MCP_ORCH_AUTH_TOKEN: "   " })).toBe("");
  });

  it("trims the token, as the Python helper does", () => {
    expect(authToken({ MCP_ORCH_AUTH_TOKEN: `  ${TOKEN} ` })).toBe(TOKEN);
  });
});

describe("constantTimeEquals", () => {
  it("accepts an exact match and rejects a mismatch", () => {
    expect(constantTimeEquals(TOKEN, TOKEN)).toBe(true);
    expect(constantTimeEquals("wrong", TOKEN)).toBe(false);
  });

  it("rejects a length mismatch without throwing (timingSafeEqual requires equal lengths)", () => {
    // The naive implementation throws RangeError here, which would surface as a
    // 500 on every wrong-length token — and leak the expected length besides.
    expect(constantTimeEquals("a", "a-much-longer-token")).toBe(false);
    expect(constantTimeEquals("a-much-longer-token", "a")).toBe(false);
    expect(constantTimeEquals("", TOKEN)).toBe(false);
  });
});

describe("authorize()", () => {
  it("passes everything through when no token is configured", () => {
    expect(authorize("/schema", undefined, "").ok).toBe(true);
  });

  it("requires the exact Bearer header on a protected path", () => {
    expect(authorize("/schema", `Bearer ${TOKEN}`, TOKEN).ok).toBe(true);
    expect(authorize("/schema", `Bearer wrong`, TOKEN).ok).toBe(false);
    expect(authorize("/schema", TOKEN, TOKEN).ok).toBe(false);
    expect(authorize("/schema", undefined, TOKEN).ok).toBe(false);
  });

  it("does not require a header on an unprotected path", () => {
    expect(authorize("/health", undefined, TOKEN).ok).toBe(true);
  });
});

describe("401 over the wire", () => {
  it("returns the exact Python 401 body on every protected route", async () => {
    const harness = await startHarness({ token: TOKEN });
    const cases: Array<[string, RequestInit]> = [
      ["/schema", { method: "GET" }],
      ["/tools/track_status", postJson({ track_id: "t-missing" })],
      ["/resources/list", { method: "GET" }],
      ["/resources/read", postJson({ uri: "orchestration://track/t-missing" })],
    ];
    for (const [path, init] of cases) {
      const res = await harness.request(path, init);
      expect(res.status, `${path} without a token`).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        ok: false,
        error: UNAUTHORIZED_ERROR,
        hint: UNAUTHORIZED_HINT,
      });
    }
  });

  it("rejects a wrong token with the same body", async () => {
    const harness = await startHarness({ token: TOKEN });
    const res = await harness.get("/schema", { headers: { Authorization: "Bearer WRONG_TOKEN" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      ok: false,
      error: UNAUTHORIZED_ERROR,
      hint: UNAUTHORIZED_HINT,
    });
  });

  it("serves /health unauthenticated even with a token configured", async () => {
    const harness = await startHarness({ token: TOKEN });
    for (const headers of [{}, { Authorization: "Bearer WRONG_TOKEN" }]) {
      const res = await harness.get("/health", { headers });
      expect(res.status).toBe(200);
      expect(((await res.json()) as Record<string, unknown>)["ok"]).toBe(true);
    }
  });

  it("protects /schema and lets the correct token through", async () => {
    const harness = await startHarness({ token: TOKEN });
    const res = await harness.get("/schema", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(Array.isArray(body["tools"])).toBe(true);
  });

  it("serves everything unauthenticated when the token is empty", async () => {
    const harness = await startHarness({ token: "" });
    for (const path of ["/health", "/schema", "/resources/list", "/config"]) {
      const res = await harness.get(path);
      expect(res.status, `${path} with auth disabled`).toBe(200);
    }
  });

  it("checks auth before routing, so a wrong method on a protected path is still 401", async () => {
    const harness = await startHarness({ token: TOKEN });
    // POST /schema is a 405 once auth passes. Getting 401 instead proves the
    // gate runs ahead of the route table, as AuthMiddleware wraps the app.
    const res = await harness.request("/schema", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("404s an unknown path with auth disabled, like the Python router", async () => {
    const harness = await startHarness({ token: "" });
    const res = await harness.get("/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "Not Found" });
  });
});
