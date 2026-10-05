/**
 * Bearer auth for the REST surface — a direct port of backend.py:56-92.
 *
 * Protected: /schema (exact + prefix), /tools*, /resources*. Open: /health and
 * /health/*. /config is deliberately NOT protected: backend.py comments that it
 * "has the same auth posture as /health", and _is_protected_path does not match
 * it. Keep that asymmetry or the settings page breaks when a token is set.
 *
 * An empty MCP_ORCH_AUTH_TOKEN disables auth entirely (backend.py:82-83), which
 * is the backwards-compatible default.
 */
import { timingSafeEqual } from "node:crypto";

const HEALTH_PREFIX = "/health";
const PROTECTED_PREFIXES = ["/tools", "/resources"] as const;

export const UNAUTHORIZED_ERROR = "unauthorized: missing or invalid Authorization header";
export const UNAUTHORIZED_HINT =
  "set Authorization: Bearer <MCP_ORCH_AUTH_TOKEN> (env MCP_ORCH_AUTH_TOKEN on server)";

/** backend.py:60-70. */
export function isProtectedPath(path: string): boolean {
  if (path === HEALTH_PREFIX || path.startsWith(`${HEALTH_PREFIX}/`)) return false;
  // /schema exact or prefix; /tools* and /resources* are protected
  if (path === "/schema" || path.startsWith("/schema/")) return true;
  for (const prefix of PROTECTED_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** backend.py:auth_token() — trimmed, empty means "auth disabled". */
export function authToken(env: NodeJS.ProcessEnv = process.env): string {
  return (env["MCP_ORCH_AUTH_TOKEN"] ?? "").trim();
}

/**
 * hmac.compare_digest equivalent. timingSafeEqual throws on a length mismatch,
 * so a mismatched length cannot be fed to it directly — and returning early
 * there would leak the expected length through response timing. Compare the
 * received value against an equal-length filler instead: the mismatch path
 * still pays for one full constant-time pass and reveals nothing.
 */
export function constantTimeEquals(received: string, expected: string): boolean {
  const receivedBuf = Buffer.from(received, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (receivedBuf.length !== expectedBuf.length) {
    timingSafeEqual(receivedBuf, Buffer.alloc(receivedBuf.length, 0));
    return false;
  }
  return timingSafeEqual(receivedBuf, expectedBuf);
}

export interface AuthVerdict {
  ok: boolean;
}

/**
 * backend.py:80-92. Returns ok:true when the request may proceed. `authorization`
 * is the raw header value (already lower-cased by node:http), or undefined when
 * the client sent none.
 */
export function authorize(
  path: string,
  authorization: string | undefined,
  token: string,
): AuthVerdict {
  if (!token) return { ok: true };
  if (!isProtectedPath(path)) return { ok: true };
  const expected = `Bearer ${token}`;
  return { ok: constantTimeEquals(authorization ?? "", expected) };
}
