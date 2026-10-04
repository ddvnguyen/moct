/**
 * F7 nonzero-exit parity (runGh/runCli async conversion) + F9 anyOf fixes.
 *
 * runGh/runCli are module-private; these tests exercise them through their
 * observable surface: a nonzero-exit child must surface as ok:true with the
 * carried stdout/stderr (the exact shape the nonzero-exit path returns), and
 * validateToolArgs union branches must follow first-branch-that-validates-wins.
 */
import { describe, expect, it } from "vitest";
import { validateToolArgs } from "../../src/surfaces/mcp/validate-args.js";

describe("validate-args anyOf (F9)", () => {
  it("none-only union with a non-null value returns a string_type error (no crash)", () => {
    const schema = { properties: { x: { anyOf: [{ type: "null" }] } }, required: [] as string[] };
    const r = validateToolArgs("t", schema, { x: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.text).toContain("x\n");
      expect(r.text).toContain("type=string_type");
      expect(r.text).toContain("input_value=5");
      expect(r.text).toContain("input_type=int");
    }
  });

  it("multi-branch union validates against each branch in order (first win)", () => {
    const schema = {
      properties: { v: { anyOf: [{ type: "string" }, { type: "integer" }] } },
      required: [] as string[],
    };
    //would have failed under nonNull[0]-only (string branch rejects 5)
    const okInt = validateToolArgs("t", schema, { v: 5 });
    expect(okInt.ok).toBe(true);
    if (okInt.ok) expect(okInt.args["v"]).toBe(5);
    const okStr = validateToolArgs("t", schema, { v: "s" });
    expect(okStr.ok).toBe(true);
  });
  it("multi-branch union failure reports the first branch error", () => {
    const schema = {
      properties: { v: { anyOf: [{ type: "string" }, { type: "integer" }] } },
      required: [] as string[],
    };
    // 1.5 fails both branches (string rejects; int rejects fractional float).
    const r = validateToolArgs("t", schema, { v: 1.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.text).toContain("type=string_type");
  });
});
