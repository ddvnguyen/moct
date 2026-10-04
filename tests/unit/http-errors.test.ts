/**
 * The last-resort error boundary — backend.py:148-149 and 200-201.
 *
 * Reachable only in principle: every one of the 26 tools catches its own
 * failures and answers {ok:false}, so POST /tools/{name} cannot currently
 * produce a 500 from a bad argument. That is worth pinning rather than leaving
 * to chance — if a future tool starts throwing, the 500 must still carry the
 * Python shape, not a bare Internal Server Error.
 */
import { describe, expect, it } from "vitest";
import { excRepr } from "../../src/domain/models.js";
import { sendUnexpected, sendUnexpectedNoHint } from "../../src/surfaces/http/responses.js";

interface Captured {
  status?: number;
  headers?: Record<string, unknown>;
  body?: string;
  ended: boolean;
}

/** Minimal ServerResponse stand-in: these senders only use writeHead/end. */
function fakeRes(): Captured & {
  writeHead(s: number, h: Record<string, unknown>): void;
  end(b?: string): void;
} {
  const captured: Captured = { ended: false };
  return Object.assign(captured, {
    writeHead(status: number, headers: Record<string, unknown>) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body?: string) {
      captured.body = body;
      captured.ended = true;
    },
  });
}

describe("500 rendering", () => {
  it("renders an unexpected tool failure as the Python body", () => {
    const res = fakeRes();
    sendUnexpected(res, new Error("kaboom"));
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body!) as Record<string, unknown>;
    expect(body).toEqual({
      ok: false,
      error: "unexpected: Error('kaboom')",
      hint: "check backend/journal/logs",
    });
  });

  it("omits the hint for the resources reader, which has none", () => {
    const res = fakeRes();
    sendUnexpectedNoHint(res, new TypeError("bad"));
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body!) as Record<string, unknown>;
    expect(body).toEqual({ ok: false, error: "unexpected: TypeError('bad')" });
    expect("hint" in body).toBe(false);
  });

  it("uses the exception's own class name, not a hardcoded Error", () => {
    expect(excRepr(new RangeError("out"))).toBe("RangeError('out')");
  });

  it("renders a thrown non-Error as Error(...)", () => {
    expect(excRepr("just a string")).toBe("Error('just a string')");
  });
});
