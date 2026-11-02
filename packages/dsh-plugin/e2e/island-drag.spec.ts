import { expect, test, type Page } from "@playwright/test";

/**
 * M-174 (lane replay): tab drag-to-reorder through real pointer events.
 *
 * jsdom delivers no pointer capture — this suite is the one that can catch
 * the defect this card replayed on lane z: the drag handlers used to live
 * on the pressed tab, and once the strip held pointer capture the browser
 * retargeted every move to the strip, so the handlers went silent on the
 * first move and the tab froze mid-drag without ever reordering (Proved
 * live 26 Nov with a real-browser event trace). The drag now lives on the
 * strip itself, so this spec drives a real mouse drag and asserts the
 * reorder lands BEFORE the release — exactly the moment the old code died —
 * plus the trailing-slot drop and a post-drag click.
 */

interface StripRow {
  text: string;
  x: number;
  y: number;
}

async function stripRows(page: Page): Promise<StripRow[]> {
  return page.evaluate(() => {
    const rows = [
      ...(window.__islandHost!()!
        .shadowRoot!.querySelectorAll<HTMLElement>("[data-tab-strip] [data-tab-id]") ?? []),
    ].map((row) => {
      const r = row.querySelector("button")!.getBoundingClientRect();
      return {
        text: ((row.querySelector("button span:nth-child(2)") ?? row.querySelector("button"))?.textContent ?? "").trim(),
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
      };
    });
    return rows.sort((a, b) => a.x - b.x);
  });
}

async function openBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/route.html?route=board");
  await page.waitForFunction(
    () => window.__islandHost?.()?.isConnected === true,
    undefined,
    { timeout: 20_000 },
  );
  await expect(page.getByText("Connecting to Multica…")).toHaveCount(0, {
    timeout: 20_000,
  });
}

test("drag-reorder lands during the drag, with the handlers on the strip", async ({ page }) => {
  await openBoard(page);
  await expect(page.getByText("Rail click stays warm").first()).toBeVisible({
    timeout: 20_000,
  });

  // Fixture, the user's own flow: click a board card so the issue opens in
  // its own tab (M-190). If the card navigated the active tab instead, the
  // New tab button makes the second tab.
  let rows = await stripRows(page);
  if (rows.length < 2) {
    const card = await page.evaluate(() => {
      const root = window.__islandHost!()!.shadowRoot!;
      // The card body: the smallest div that still wraps the issue title
      // (column headers and the app wrapper carry the same text).
      const hits = [...root.querySelectorAll<HTMLElement>("div")]
        .filter(
          (n) =>
            (n.textContent ?? "").includes("Rail click stays warm") &&
            n.clientHeight > 30,
        )
        .sort(
          (a, b) =>
            a.clientWidth * a.clientHeight - b.clientWidth * b.clientHeight,
        );
      const el = hits[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + 14 };
    });
    expect(card, "board card found").not.toBeNull();
    await page.mouse.click(card!.x, card!.y);
    await page.waitForTimeout(2500);
    rows = await stripRows(page);
    if (rows.length < 2) {
      const plus = await page.evaluate(() => {
        const root = window.__islandHost!()!.shadowRoot!;
        const b = root.querySelector<HTMLButtonElement>('button[aria-label="New tab"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      expect(plus, "New tab button").not.toBeNull();
      await page.mouse.click(plus!.x, plus!.y);
      await page.waitForTimeout(1200);
      rows = await stripRows(page);
    }
  }
  expect(rows.length, "two tabs on the strip").toBe(2);

  // Drag the second tab to the front. The reorder must already show while
  // the pointer is still held — under the old handler placement the strip
  // had captured the pointer and the tab went silent right here.
  const moving = rows[1]!;
  await page.mouse.move(moving.x, moving.y);
  await page.mouse.down();
  await page.mouse.move(20, moving.y, { steps: 12 }); // left half of row 0
  const midDrag = await stripRows(page);
  expect(midDrag).toHaveLength(2);
  // the moved tab now sits at the front, mid-drag
  expect(midDrag[0]!.text, "reorder landed during the drag").toBe(moving.text);
  await page.mouse.up();
  await page.waitForTimeout(300);

  const released = await stripRows(page);
  expect(released[0]!.text).toBe(midDrag[0]!.text); // order kept on release
  const stuck = await page.evaluate(() =>
    [...(window.__islandHost!()!.shadowRoot!.querySelectorAll("[data-dragging]") ?? [])].length,
  );
  expect(stuck, "no tab stuck in its dragging state").toBe(0);

  // Click still works after a drag: the second press opens the tab.
  await page.mouse.click(released[0]!.x, released[0]!.y);
  await page.waitForTimeout(600);
  const active = await page.evaluate(() => {
    const btn = window
      .__islandHost!()!
      .shadowRoot!.querySelector<HTMLElement>("[data-tab-strip] [data-tab-id] [data-active]");
    return btn !== null;
  });
  expect(active, "clicked tab is active").toBe(true);
});

test("a drop past the last midpoint takes the trailing slot", async ({ page }) => {
  await openBoard(page);
  await expect(page.getByText("Rail click stays warm").first()).toBeVisible({
    timeout: 20_000,
  });

  // Fixture, the user's own flow again: the board card opens the issue in
  // its own tab. (The New tab button cannot make this one: with the active
  // tab already on the board, `openTab` reuses it by design.)
  const card = await page.evaluate(() => {
    const root = window.__islandHost!()!.shadowRoot!;
    const hits = [...root.querySelectorAll<HTMLElement>("div")]
      .filter(
        (n) =>
          (n.textContent ?? "").includes("Rail click stays warm") &&
          n.clientHeight > 30,
      )
      .sort(
        (a, b) =>
          a.clientWidth * a.clientHeight - b.clientWidth * b.clientHeight,
      );
    const el = hits[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 14 };
  });
  expect(card, "board card found").not.toBeNull();
  await page.mouse.click(card!.x, card!.y);
  await page.waitForTimeout(2500);

  const rows = await stripRows(page);
  expect(rows).toHaveLength(2);

  // Drag tab 0 right, well past tab 1's midpoint: it must take slot 1 —
  // the trailing slot read one short when the drop index started at
  // `tabs.length - 1`, and the drag then did nothing.
  const from = rows[0]!;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(rows[1]!.x + 100, from.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const after = await stripRows(page);
  expect(after[1]!.text, "dragged the first tab to the end").toBe(from.text);
  expect(after[0]!.text).toBe(rows[1]!.text);
});
