import { expect, test, type Page } from "@playwright/test";

/**
 * M-154: every page the island can open, in a real browser.
 *
 * The bug this card started from — Settings → Preferences rendering the error
 * boundary — was one page of a class: a fork page that throws on a provider or
 * a query the island does not mount. A unit test can only assert the pages it
 * knows about, so this sweep walks all of them and fails on the boundary's own
 * copy or on any uncaught page error.
 *
 * Failures are collected, not skipped: a page that cannot render is a finding
 * to report, and narrowing the list to the pages that pass would hide exactly
 * the defect this spec exists to catch.
 */

const BOUNDARY = "Something went wrong displaying this section";

/**
 * The eight routes the rail can open, with text that proves the page rendered.
 *
 * The list pages mark themselves with a row, not the header: the header paints
 * before any query resolves, so a header marker would pass even if the list
 * itself never rendered. Both lists are scoped by default (agents → "mine"),
 * which is why the stub gives its agent an owner.
 */
const ROUTES: ReadonlyArray<{ label: string; params: Record<string, string>; marker?: string }> = [
  { label: "board", params: { route: "board" }, marker: "Rail click stays warm" },
  { label: "issue", params: { route: "issue", id: "MUL-1" }, marker: "MUL-1" },
  { label: "agents", params: { route: "agents" }, marker: "Ada" },
  { label: "agent", params: { route: "agent", id: "agent-1" }, marker: "Ada" },
  { label: "skills", params: { route: "skills" }, marker: "Release notes" },
  { label: "skill", params: { route: "skill", id: "skill-1" }, marker: "Release notes" },
  { label: "inbox", params: { route: "inbox" }, marker: "Inbox row 1" },
  { label: "decisions", params: { route: "decisions" }, marker: "Decisions" },
  { label: "chat", params: { route: "chat" } },
];

/** The tabs this panel offers: everything the fork ships minus `hiddenTabs`. */
const SETTINGS_TABS = [
  "profile",
  "preferences",
  "notifications",
  "tokens",
  "workspace",
  "members",
  "issue-statuses",
  "wakeups",
  "labels",
  "properties",
  "quick-actions",
  "mcp",
  "moct-memory",
  "moct-connection",
  "moct-interactions",
] as const;

/** The agent page's built-in detail tabs plus the host's Memory section. */
const AGENT_VIEWS = [
  "overview",
  "work",
  "instructions",
  "skills",
  "mcp_config",
  "composio_mcp",
  "integrations",
  "general",
  "access",
  "env",
  "custom_args",
  "runtime_config",
  "memory",
] as const;

function href(params: Record<string, string>): string {
  return `/route.html?${new URLSearchParams(params).toString()}`;
}

interface Finding {
  page: string;
  error: string;
}

/** Open one page and report what went wrong, without failing the sweep early. */
async function visit(
  page: Page,
  label: string,
  params: Record<string, string>,
  marker?: string,
): Promise<Finding[]> {
  const errors: string[] = [];
  const onError = (error: Error): void => {
    errors.push(error.message);
  };
  page.on("pageerror", onError);

  const findings: Finding[] = [];
  try {
    await page.goto(href(params));
    await page.waitForFunction(
      () => window.__islandHost?.()?.isConnected === true,
      undefined,
      { timeout: 20_000 },
    );
    // Boot is done when the island has painted something that is not the
    // "Connecting" placeholder; the boundary copy is checked separately.
    await expect(page.getByText("Connecting to Multica…")).toHaveCount(0, {
      timeout: 20_000,
    });
    if (marker !== undefined) {
      await expect(page.getByText(marker).first()).toBeVisible({ timeout: 20_000 });
    }
    await expect(page.getByText(BOUNDARY)).toHaveCount(0);
  } catch (cause) {
    findings.push({
      page: label,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (errors.length > 0) {
    findings.push({ page: label, error: `pageerror: ${errors.join(" | ")}` });
  }
  page.off("pageerror", onError);
  return findings;
}

function report(findings: Finding[]): void {
  expect(
    findings,
    findings.map((finding) => `${finding.page}: ${finding.error}`).join("\n"),
  ).toEqual([]);
}

test.describe("island smoke sweep", () => {
  test.slow();

  test("every route renders without the boundary or a page error", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1300 });
    const findings: Finding[] = [];
    for (const route of ROUTES) {
      findings.push(...(await visit(page, `route ${route.label}`, route.params, route.marker)));
    }
    report(findings);
  });

  test("every settings tab renders", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1300 });
    const findings: Finding[] = [];
    for (const tab of SETTINGS_TABS) {
      findings.push(
        ...(await visit(
          page,
          `settings tab ${tab}`,
          { route: "settings", query: `tab=${tab}` },
        )),
      );
    }
    report(findings);
  });

  test("every agent view renders", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1300 });
    const findings: Finding[] = [];
    for (const view of AGENT_VIEWS) {
      findings.push(
        ...(await visit(
          page,
          `agent view ${view}`,
          { route: "agent", id: "agent-1", query: `view=${view}` },
        )),
      );
    }
    report(findings);
  });

  test("Decisions renders with its pending count", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1300 });
    await page.goto(href({ route: "decisions" }));
    await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Pending 1" })).toBeVisible();
    await expect(page.getByRole("option", { name: /Question/ })).toBeVisible();
    await expect(page.getByText("Rail click stays warm").first()).toBeVisible();
    await page.screenshot({ path: "test-results/m212-decisions.png", fullPage: true });
  });
});
