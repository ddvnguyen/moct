/**
 * M-588 B4: tier-pick-audit ships a seeded, offline bash test. CI's only test
 * door is `pnpm test` (vitest), so this wrapper keeps that test inside the
 * existing gate without touching `.github/workflows/ci.yml`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST = fileURLToPath(
  new URL("../../tools/tier-pick-audit/tier-pick-audit.test.sh", import.meta.url),
);

describe("tier-pick-audit", () => {
  it("passes its seeded, offline checks", () => {
    const out = execFileSync("bash", [TEST], {
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(out).toContain("all tier-pick-audit checks passed");
  });
});
