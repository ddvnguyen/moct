import { expect, test, type Page } from "@playwright/test";

/**
 * M-136: the composer takeover in a real browser.
 *
 * The unit tests cover the component; these cover the chain contract the
 * component sits in — elected only while exactly one running turn owns the
 * session, the shell's composer left mounted underneath with its draft intact,
 * and every write going to the issue-scoped route the server actually serves.
 */

const HARNESS = "/steer.html";

const RUNNING = {
  id: "task-1",
  issue_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "agent-1",
  status: "running",
  session_id: "sess-1",
  supplement_capability: "task-supplement-v1",
  can_supplement: true,
};

/** Swap what the snapshot answers, the way a task event would. */
async function setSnapshot(page: Page, rows: unknown[]): Promise<void> {
  await page.evaluate((next) => {
    window.__steer?.setSnapshot(next);
  }, rows);
}

const takeover = (page: Page) => page.locator("[data-multica-steer-composer]");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(HARNESS);
});

test("takes the composer over while a run owns the session", async ({ page }) => {
  await expect(takeover(page)).toBeVisible();
  await expect(page.getByText("Multica run")).toBeVisible();
  await expect(page.getByText("#task-1")).toBeVisible();

  // The shell's own composer is still there, hidden rather than unmounted.
  await expect(page.getByTestId("shell-composer")).toHaveCount(1);
  await expect(page.getByTestId("shell-composer")).toBeHidden();
});

test("hands the composer back, draft intact, when the run ends", async ({ page }) => {
  // No owner: the shell keeps its composer.
  await setSnapshot(page, []);
  await expect(page.getByTestId("shell-composer")).toBeVisible();
  await expect(takeover(page)).toHaveCount(0);

  await page.getByTestId("shell-input").fill("a draft written before the run");

  // A run starts in this session: the takeover replaces the composer.
  await setSnapshot(page, [RUNNING]);
  await expect(takeover(page)).toBeVisible();
  await expect(page.getByTestId("shell-composer")).toBeHidden();

  // The run finishes: the shell composer comes back with the draft untouched,
  // which is what `overlay: true` exists for.
  await setSnapshot(page, []);
  await expect(page.getByTestId("shell-composer")).toBeVisible();
  await expect(page.getByTestId("shell-input")).toHaveValue("a draft written before the run");
});

test("declines when two running tasks claim the same session", async ({ page }) => {
  await expect(takeover(page)).toBeVisible();

  await setSnapshot(page, [RUNNING, { ...RUNNING, id: "task-2" }]);

  // Two owners is not a coin flip: the composer goes back to the shell.
  await expect(takeover(page)).toHaveCount(0);
  await expect(page.getByTestId("shell-composer")).toBeVisible();
});

test("queues a message for the next turn", async ({ page }) => {
  await takeover(page).getByLabel("Message this run").fill("also run the linter");
  await takeover(page).getByLabel("Message this run").press("Enter");

  await expect(page.getByText("Queued for the next turn")).toBeVisible();
  await expect(page.getByText("queued — next turn")).toBeVisible();

  const writes = await page.evaluate(() => window.__mutations ?? []);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.path).toBe(
    "/multica/api/issues/11111111-1111-4111-8111-111111111111/tasks/task-1/supplements",
  );
  expect(writes[0]?.body).toMatchObject({ content: "also run the linter", mode: "queue" });
  expect(typeof writes[0]?.body.client_request_id).toBe("string");
});

test("steers into the running turn with Cmd+Enter", async ({ page }) => {
  const input = takeover(page).getByLabel("Message this run");
  await input.fill("change course now");
  await input.press("Meta+Enter");

  await expect(page.getByText("Sent to the running turn")).toBeVisible();
  const writes = await page.evaluate(() => window.__mutations ?? []);
  expect(writes[0]?.body).toMatchObject({ mode: "steer" });
});

test("promotes a queued message to a steer from its own row", async ({ page }) => {
  const input = takeover(page).getByLabel("Message this run");
  await input.fill("do it now");
  await input.press("Enter");
  await expect(page.getByText("queued — next turn")).toBeVisible();

  await takeover(page).getByRole("button", { name: "Steer now" }).click();

  await expect(page.getByText("steered — delivering")).toBeVisible();
  const writes = await page.evaluate(() => window.__mutations ?? []);
  expect(writes.at(-1)?.path).toBe(
    "/multica/api/issues/11111111-1111-4111-8111-111111111111/tasks/task-1/supplements/comment-steer-1/promote",
  );
});

test("stops the run only on the second click", async ({ page }) => {
  await takeover(page).getByRole("button", { name: "Stop" }).click();

  await expect(page.getByText("Stop this run?")).toBeVisible();
  expect(await page.evaluate(() => window.__mutations ?? [])).toHaveLength(0);

  await takeover(page).getByRole("button", { name: "Stop" }).click();

  await expect(page.getByText("Stop requested")).toBeVisible();
  const writes = await page.evaluate(() => window.__mutations ?? []);
  expect(writes.map((write) => write.path)).toEqual([
    "/multica/api/issues/11111111-1111-4111-8111-111111111111/tasks/task-1/cancel",
  ]);
});
