/**
 * M-588 B1b: the sweep ships a seeded, offline bash test (TAP-style, 60 cases).
 * CI's only test door is `pnpm test` (vitest), so this wrapper keeps that test
 * inside the existing gate without touching `.github/workflows/ci.yml`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST = fileURLToPath(
  new URL("../../tools/orch-sweep/orch-sweep.test.sh", import.meta.url),
);

describe("orch-sweep", () => {
  it("passes its seeded, offline checks", () => {
    const out = execFileSync("bash", [TEST], {
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(out).toContain("# passed=60 failed=0");
  });
});
