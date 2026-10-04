import { defineConfig } from "vitest/config";

// Round-3 nit decision (documented in tests/parity/HARNESS.md): the parity
// suite (~2.5 min, two servers over stdio) stays OUT of the default PR gate so
// `vitest run` is fast. `pnpm parity` sets PARITY=1 to lift the exclusion;
// explicit file args (e.g. CI running the parity job) also bypass it.
const parityRun = process.env["PARITY"] === "1";

export default defineConfig({
  test: {
    exclude: parityRun ? ["**/node_modules/**"] : ["**/node_modules/**", "tests/parity/**"],
  },
});
