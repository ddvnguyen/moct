/**
 * Merge-safety gate (paseo#31 rule 2): @tursodatabase/database may only be
 * imported from src/store/turso-repository.ts. Everything else codes against
 * the Store interface so the domain stays testable without native prebuilds.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
const PKG_DIR = path.resolve(__dirname, "..", "..");
// Allowlist MUST stay identical to scripts/fleet-merge-safety.mjs checkTursoImport().
// The fixture-regen script is a MANUAL op (never CI/tests); it opens a
// disposable sqlite copy, so it holds a narrow exception to the confinement rule.
const ALLOWED = new Set(["src/store/turso-repository.ts", "scripts/regenerate-fixture.mjs"]);

// Collector MUST stay identical to scripts/fleet-merge-safety.mjs collectFiles():
// extensions ts|mts|js|mjs|cjs, skipping node_modules/dist/.tmp/.fixture-tmp
// and .d.ts artifacts. The matcher MUST stay a SUBSTRING match on the
// forbidden package name (lesson:
// confinement-gates-match-the-forbidden-name-not-an-anchored-prefix): an
// anchored ^@tursodatabase/... passes ../node_modules/@tursodatabase/...
// straight through.
function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === ".tmp" ||
      entry === ".fixture-tmp"
    )
      continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (/\.(ts|mts|js|mjs|cjs)$/.test(entry)) {
      if (full.endsWith(".d.ts") || full.endsWith(".d.ts.map")) continue;
      out.push(full);
    }
  }
  return out;
}

describe("turso import gate", () => {
  it("only store/turso-repository.ts imports @tursodatabase/database", () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(PKG_DIR)) {
      const rel = path.relative(PKG_DIR, file);
      if (rel.startsWith("node_modules")) continue;
      const text = readFileSync(file, "utf-8");
      // SUBSTRING match on the forbidden name: fires on static imports,
      // dynamic import(), require(), AND node_modules-prefixed specifiers.
      const hits =
        /(?:from\s+['"]|import\s*\(\s*['"]|require\s*\(\s*['"])[^'"]*@tursodatabase\/database(?:\/[^'"]*)?['"]/.test(
        text);
      if (hits && !ALLOWED.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
