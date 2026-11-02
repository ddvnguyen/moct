import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { islandPropertyRules } from "../scripts/island-property-rules.mjs";
import { collect } from "../../../scripts/mmx-version.mjs";

// Deterministic build stamp (M-155): the Playwright specs assert the badge
// against the Settings row, so both sides need the same injected value on
// every run, whenever it runs.
const mmxBuild = collect({
  now: new Date("2026-01-01T00:00:00Z"),
  sha: "testsha",
});

/**
 * The M-116 harness dev server.
 *
 * Serves `harness/` — a fake dsh shell (app column + `[data-shell-overlay]`
 * layer + a blocking card) around the island boundary built from the
 * production `createPopupSeat`. Driven by `../island-overlays.spec.ts`;
 * not part of the shipped client bundle.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./harness", import.meta.url)),
  plugins: [react(), tailwindcss(), islandPropertyRules()],
  define: {
    __MMX_BUILD__: JSON.stringify(mmxBuild),
  },
  server: {
    // HARNESS_PORT lets a second checkout run the suite when another copy
    // already holds 4173 (strictPort keeps collisions loud by default).
    port: Number(process.env.HARNESS_PORT ?? 4173),
    strictPort: true,
    host: "127.0.0.1",
  },
});
