import { expect, test, type Page } from "@playwright/test";

/**
 * M-159: the header's Files/Terminal buttons click through with the shell
 * bridge behind them.
 *
 * jsdom can mount the buttons, but the open path runs across a live sidebar
 * face: which call the plan makes (`openTab` on the on-screen session vs the
 * keep-alive fallback's `selectPanel(null)` first) and what the face rejects
 * (`no session surface is mounted`) are only observable in a real browser.
 * The shell harness page configures a stub bridge that records every face
 * call and renders the opened tabs, so the spec asserts behaviour through the
 * record — the same discipline the Comments bar and the tab strip specs use.
 */

const tabStrip = "span[data-sidebar-tab]";

async function stubCalls(page: Page): Promise<string[]> {
  return (await page.evaluate(() => window.__stubCalls)) ?? [];
}

async function openShell(page: Page, query: string): Promise<void> {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  ;(page as unknown as { __pageErrors?: string[] }).__pageErrors = pageErrors;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shell.html${query}`);
  await page.waitForFunction(
    () => window.__islandHost?.()?.isConnected === true,
    undefined,
    { timeout: 20_000 },
  );
  await expect(page.getByText("Connecting to Multica…")).toHaveCount(0, {
    timeout: 20_000,
  });
  // The board's list request is the last boot network touch; the strip has
  // rendered by the time the shell shows the buttons.
  await expect(page.locator('[data-shell-button="toggle"]')).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('[data-shell-button="files"]')).toBeEnabled();
}

async function expectNoPageErrors(page: Page): Promise<void> {
  expect(
    (page as unknown as { __pageErrors?: string[] }).__pageErrors ?? [],
  ).toEqual([]);
}

test("with a folder, Files and Terminal open their tabs beside the on-screen session", async ({
  page,
}) => {
  await openShell(page, "?hostPanel");

  // Enabled with a folder, and the tooltip names the folder it addresses.
  const folder = "/srv/demo";
  await expect(page.locator('[data-shell-button="files"]')).toHaveAttribute(
    "title",
    new RegExp(folder.replace(/\//g, "\\$&")),
  );
  await expect(page.locator('[data-shell-button="terminal"]')).toBeEnabled();

  await page.locator('[data-shell-button="files"]').click();
  await expect(page.locator(tabStrip)).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('[data-sidebar-tab="files"]')).toHaveAttribute(
    "data-tab-session",
    "s-1",
  );
  await page.locator('[data-shell-button="terminal"]').click();
  await expect(page.locator('[data-sidebar-tab="terminal"]')).toHaveAttribute(
    "data-tab-session",
    "s-1",
    { timeout: 20_000 },
  );

  // The recorded path: bound session equals the on-screen one, so the plan is
  // the plain openTab; the hostPanel face is in place, so no panel was
  // dropped — the keep-alive fallback stayed unused.
  const calls = await stubCalls(page);
  expect(calls).toContain("openTab files");
  expect(calls).toContain("openTab terminal");
  expect(calls.filter((call) => call.startsWith("selectPanel:"))).toEqual([]);

  // A session is on screen, so the toggle's two states agree on click.
  await expect(page.locator("[data-sidebar-expanded]")).toHaveCount(0);
  await page.locator('[data-shell-button="toggle"]').click();
  await expect(page.locator('[data-sidebar-expanded]')).toHaveCount(1, {
    timeout: 20_000,
  });
  await expectNoPageErrors(page);
});

test("without hostPanel, opening drops the main panel first (the keep-alive fallback)", async ({
  page,
}) => {
  await openShell(page, "");

  await page.locator('[data-shell-button="terminal"]').click();
  await expect(page.locator('[data-sidebar-tab="terminal"]')).toHaveAttribute(
    "data-tab-session",
    "s-1",
    { timeout: 20_000 },
  );

  // The fallback's order is the point: drop the main panel, then open.
  expect(await stubCalls(page)).toEqual(["selectPanel:null", "openTab terminal"]);

  await expectNoPageErrors(page);
});

test("no session surface: the guard says why instead of throwing", async ({
  page,
}) => {
  await openShell(page, "");

  // Reproduce M-159's shell state only once the mount has settled: the
  // session surface leaves between the render that paired the buttons and
  // the click, exactly the race the guard's catch is for.
  await page.evaluate(() => {
    window.__sessionSurfaceMounted = "";
  });

  await page.locator('[data-shell-button="toggle"]').click();
  await expect(page.locator('[data-shell-note]')).toHaveText(
    "MMX owns the main column, so the dsh sidebar has no session to open tabs in",
    { timeout: 20_000 },
  );

  // The throw stayed caught: the page never errored, and the toggle reads the
  // way the disabled buttons do now that the surface is gone.
  await expect(page.locator('[data-shell-button="toggle"]')).toBeDisabled();
  await expect(page.locator('[data-shell-button="toggle"]')).toHaveAttribute(
    "title",
    "MMX owns the main column, so the dsh sidebar has no session to open tabs in",
  );
  await expectNoPageErrors(page);
});
