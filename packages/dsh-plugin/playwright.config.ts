import { defineConfig } from "@playwright/test";

/**
 * The island harness suite.
 *
 * The specs under `e2e/` drive the island in a real Chromium against harness
 * pages: shadow-DOM hit-testing (M-116), the keep-alive island's relayout
 * (M-130), and the MOCT memory page's picker and layout (M-124). jsdom has no
 * layout and delivers no pointer events, so none of the three can be told
 * apart there. The dev server is the harness vite config; nothing else must
 * be running.
 */
const port = Number(process.env.HARNESS_PORT ?? 4173);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
  },
  webServer: {
    command: "pnpm exec vite --config e2e/vite.harness.config.ts",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
