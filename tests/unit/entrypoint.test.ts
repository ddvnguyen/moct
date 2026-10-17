/**
 * The entrypoint guard, and the symlink shape that broke it.
 *
 * Regression: run 39010151404, the first real MOCT-X switch. The unit's
 * ExecStart is `node <root>/current/dist/daemon.js` where `current` is a symlink
 * to the release directory. Node resolves that symlink when it builds
 * import.meta.url, so the literal argv[1] comparison was false, main() never
 * ran, and the daemon exited 0 with no listener and no output - 30s of silence
 * that only the unit's journal could explain, and it explained nothing.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isEntrypoint } from "../../src/entrypoint.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A real entry file plus a symlinked directory that reaches the same file. */
function entryPair(): { dir: string; real: string; linked: string; other: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-entrypoint-"));
  dirs.push(dir);
  const real = path.join(dir, "daemon.js");
  writeFileSync(real, "// the entry module\n");
  const other = path.join(dir, "mcp.js");
  writeFileSync(other, "// another module\n");
  symlinkSync(dir, path.join(dir, "current"));
  return { dir, real, linked: path.join(dir, "current", "daemon.js"), other };
}

describe("isEntrypoint", () => {
  it("matches the literal path", () => {
    const { real } = entryPair();
    expect(isEntrypoint(pathToFileURL(real).href, real)).toBe(true);
  });

  it("matches when the entry is reached through a symlinked directory (the unit's shape)", () => {
    const { real, linked } = entryPair();
    // import.meta.url is built from the REAL path even though argv[1] is the link.
    expect(isEntrypoint(pathToFileURL(real).href, linked)).toBe(true);
  });

  it("matches a relative path, the shape the deploy rehearsal uses", () => {
    const { real } = entryPair();
    expect(isEntrypoint(pathToFileURL(real).href, path.relative(process.cwd(), real))).toBe(true);
  });

  it("rejects a different module, linked or not", () => {
    const { real, linked, other } = entryPair();
    expect(isEntrypoint(pathToFileURL(other).href, real)).toBe(false);
    expect(isEntrypoint(pathToFileURL(other).href, linked)).toBe(false);
  });

  it("rejects a missing argv[1]", () => {
    expect(isEntrypoint("file:///x/daemon.js", undefined)).toBe(false);
  });

  it("falls back to the literal comparison when the path no longer resolves", () => {
    const { dir } = entryPair();
    const gone = path.join(dir, "deleted.js");
    expect(isEntrypoint(pathToFileURL(gone).href, gone)).toBe(true);
  });
});
