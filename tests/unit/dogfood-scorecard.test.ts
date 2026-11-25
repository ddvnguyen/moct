/**
 * M-577 (M-574 A1): the dog-food scorecard ships a seeded, offline bash test.
 * CI's only test door is `pnpm test` (vitest), so this wrapper is what keeps
 * that test inside the existing gate without touching `.github/workflows/ci.yml`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST = fileURLToPath(
  new URL("../../tools/dogfood-scorecard/dogfood-scorecard.test.sh", import.meta.url),
);

describe("dogfood-scorecard", () => {
  it("passes its seeded, offline checks", () => {
    const out = execFileSync("bash", [TEST], {
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(out).toContain("all dogfood-scorecard checks passed");
  });
});
