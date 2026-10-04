import { defineConfig } from "vitest/config";

// Round-3 nit decision (documented in tests/parity/HARNESS.md): the parity
// suite (~5 min, two servers over stdio) stays OUT of the default PR gate so
// `vitest run` is fast — there is exactly one door, `pnpm parity`, which sets
// PARITY=1 to lift the exclusion (exclude also filters explicit file args).
// .parity-pin/ (the read-only pinned-baseline extract) is NEVER a test root:
// the extract carries upstream *.test.ts files (bun:test) that must not run.
const parityRun = process.env["PARITY"] === "1";

export default defineConfig({
  test: {
    exclude: parityRun
      ? ["**/node_modules/**", "**/.parity-pin/**"]
      : ["**/node_modules/**", "tests/parity/**", "**/.parity-pin/**"],
  },
});
