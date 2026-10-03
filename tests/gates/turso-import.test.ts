/**
 * Merge-safety gate (paseo#31 rule 2): @tursodatabase/database may only be
 * imported from src/store/turso-repository.ts. Everything else codes against
 * the Store interface so the domain stays testable without native prebuilds.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const PKG_DIR = path.resolve(__dirname, "..", "..");
const ALLOWED = new Set(["src/store/turso-repository.ts"]);

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
    else if (
      entry.endsWith(".ts") ||
      entry.endsWith(".mts") ||
      (entry.endsWith(".js") && !entry.endsWith(".test.js"))
    ) {
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
      // match static imports and dynamic import() of the driver package
      const hits =
        /(?:from\s+['"]|import\s*\(\s*['"])@tursodatabase\/database(?:\/[^'"]*)?['"]/.test(text);
      if (hits && !ALLOWED.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
