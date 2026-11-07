import { expect, test, type Page } from "@playwright/test";

/**
 * M-159: the header's side-panel toggle click through with the shell bridge
 * behind it.
 *
 * jsdom can mount the button, but the press runs across a live sidebar face:
 * whether it flips the column in place (`toggleExpanded`), names the project's
 * Session for the column beside MMX first (`selectHostedSession`), or has to
 * reveal the folder's Session, and what the face rejects (`no session surface
 * is mounted`) are only observable in a real browser. The shell harness page
 * configures a stub bridge that records every face call and renders the shown
 * state, so the spec asserts behaviour through the record — the same
 * discipline the Comments bar and the tab strip specs use.
 */

const toggle = '[data-shell-button="toggle"]';

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
  // rendered by the time the shell shows the toggle.
  await expect(page.locator(toggle)).toBeVisible({ timeout: 20_000 });
}

async function expectNoPageErrors(page: Page): Promise<void> {
  expect(
    (page as unknown as { __pageErrors?: string[] }).__pageErrors ?? [],
  ).toEqual([]);
}

test("with card C, the toggle opens and closes the dsh side panel in place", async ({
  page,
}) => {
  await openShell(page, "?hostPanel");

  // Enabled with a folder, and the tooltip names the folder it would show.
  await expect(page.locator(toggle)).toBeEnabled();
  await expect(page.locator(toggle)).toHaveAttribute(
    "title",
    "Open the dsh side panel on /srv/demo",
  );
  await expect(page.locator(toggle)).toHaveAttribute("aria-pressed", "false");

  await page.locator(toggle).click();
  await expect(page.locator("[data-sidebar-expanded]")).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(page.locator(toggle)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(toggle)).toHaveAttribute(
    "title",
    "Close the dsh side panel",
  );

  // In place: one flip of the column, and no Session was selected — MMX keeps
  // the main column, which is the whole point of card C. (`hostPanel` itself is
  // called from `apply`, which this harness page never runs.)
  expect(await stubCalls(page)).toEqual(["toggleExpanded"]);

  await page.locator(toggle).click();
  await expect(page.locator("[data-sidebar-expanded]")).toHaveCount(0, {
    timeout: 20_000,
  });
  expect((await stubCalls(page)).filter((call) => call.startsWith("selectSession"))).toEqual([]);

  await expectNoPageErrors(page);
});

test("with card C, a press on another Workspace's Session retargets the column before opening", async ({
  page,
}) => {
  // The Conversation last selected a Session from another Workspace, and MMX
  // owns the main column: the column would open on that other folder unless the
  // press names the project's Session first.
  await openShell(page, "?hostPanel&otherSession");

  await page.locator(toggle).click();
  await expect(page.locator("[data-sidebar-expanded]")).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(page.locator("[data-sidebar]")).toHaveAttribute("data-session", "s-1");
  // The name lands first, then the flip — and nothing selects a Session, so MMX
  // never leaves the main column.
  expect(await stubCalls(page)).toEqual(["selectHostedSession s-1", "toggleExpanded"]);
  expect((await stubCalls(page)).filter((call) => call.startsWith("selectSession"))).toEqual([]);

  // Closing goes where the column is: the press is not a retarget.
  await page.locator(toggle).click();
  await expect(page.locator("[data-sidebar-expanded]")).toHaveCount(0, {
    timeout: 20_000,
  });
  expect((await stubCalls(page)).filter((call) => call.startsWith("selectHostedSession"))).toEqual([
    "selectHostedSession s-1",
  ]);

  await expectNoPageErrors(page);
});

test("without hostPanel and no session on screen, the press reveals the folder's session first", async ({
  page,
}) => {
  await openShell(page, "?noSurface");

  // MMX owns the main column, so the column has nothing to draw for yet: the
  // press has to bring the bound Session on screen, and only then open, because
  // a write before that lands on nothing.
  await page.locator(toggle).click();
  await expect(page.locator("[data-sidebar-expanded]")).toHaveCount(1, {
    timeout: 20_000,
  });
  expect(await stubCalls(page)).toEqual(["selectSession s-1", "toggleExpanded"]);

  await expectNoPageErrors(page);
});

test("a reveal the shell never drew reports why instead of throwing", async ({
  page,
}) => {
  await openShell(page, "?noSurface&noReveal");

  // The press selected the Session and waited for the shell to draw it; it
  // never did. Shell state, not a page error: the copy lands in the tooltip and
  // the column stays closed.
  await page.locator(toggle).click();
  await expect(page.locator(toggle)).toHaveAttribute(
    "title",
    "The dsh side panel needs a session in the project folder",
    { timeout: 20_000 },
  );
  await expect(page.locator(toggle)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-sidebar-expanded]")).toHaveCount(0);

  await expectNoPageErrors(page);
});

test("no folder: the toggle is disabled and says what is missing", async ({
  page,
}) => {
  await openShell(page, "?noFolder");

  await expect(page.locator(toggle)).toBeDisabled();
  await expect(page.locator(toggle)).toHaveAttribute("title", "Choose a project");
  expect(await stubCalls(page)).toEqual([]);

  await expectNoPageErrors(page);
});
