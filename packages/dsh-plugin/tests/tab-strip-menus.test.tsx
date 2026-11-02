import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachIsland,
  islandHost,
  resetIsland,
  unmountIsland,
} from "../src/client/island";
import { attachSeat } from "../src/client/seat";
import { resetIslandConfig } from "../src/client/config";
import { BOARD_ROUTE } from "../src/client/navigation";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 64,
        end: (index + 1) * 64,
        size: 64,
      })),
    getTotalSize: () => count * 64,
  }),
}));

// Reduced from island.test.tsx's stub: the endpoints the board and the strip's
// presentation hooks read on mount. Unlisted requests get an empty list — the
// shape those queries parse.
const requests: string[] = [];
const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const host of mounted.splice(0)) unmountIsland(host);
  resetIsland();
  document.body.replaceChildren();
  requests.length = 0;
  resetIslandConfig();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubBackend() {
  const handler = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push(url);
    if (url.startsWith("/multica/config")) {
      return json({ wsPath: "/multica/ws", workspaceSlug: "demo", problem: null });
    }
    if (url.startsWith("/multica/api/workspaces")) {
      return json([
        {
          id: "ws-1",
          slug: "demo",
          name: "Demo",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ]);
    }
    if (url.startsWith("/multica/api/me")) {
      return json({ id: "user-1", name: "Ada", email: "ada@example.test" });
    }
    if (url.startsWith("/multica/api/issues/grouped")) {
      return json({ groups: [{ id: "none", assignee_type: null, assignee_id: null, issues: [], total: 0 }] });
    }
    if (url === "/multica/api/issues" || url.startsWith("/multica/api/issues?")) {
      return json({ issues: [], total: 0, comments: [] });
    }
    return json([]);
  });
  vi.stubGlobal("fetch", handler);
}

function seatElement(): HTMLElement {
  const seat = document.createElement("div");
  document.body.append(seat);
  return seat;
}

/** Retries the assertion between React/async commits, then gives up loudly. */
async function settle(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  }
  assertion();
}

function stripRows(shadow: ShadowRoot): HTMLElement[] {
  return [...shadow.querySelectorAll<HTMLElement>("[data-tab-strip] [data-tab-id]")];
}

/** The strip's tab rows, addressed the way every caller holds the island. */
function hostRows(host: HTMLElement): HTMLElement[] {
  return stripRows(host.shadowRoot as ShadowRoot);
}

function fullStrip(root: HTMLElement): HTMLElement {
  return root.shadowRoot?.querySelector("[data-tab-strip]") as HTMLElement;
}

/** Right-click an element inside the island's shadow root. */
function contextMenu(el: Element) {
  el.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
  );
}

describe("tab strip context menus (M-174)", () => {
  it("closes the other unpinned tabs from a tab's context menu", async () => {
    stubBackend();
    const seat = seatElement();

    act(() => attachSeat(seat, BOARD_ROUTE));
    await settle(() => {
      // Wait for the board tab itself: attaching a different entry before the
      // entry effect seeds the strip would leave nothing behind to per-tab
      // store on.
      expect(hostRows(islandHost() as HTMLElement)).toHaveLength(1);
    });
    // A second family joins the strip with an entry in the window history.
    await act(async () => {
      attachIsland(seat, { view: "agents" });
    });
    await settle(() => {
      expect(hostRows(islandHost() as HTMLElement)).toHaveLength(2);
    });

    const host = islandHost() as HTMLElement;
    const shadow = host.shadowRoot as ShadowRoot;
    // Right-click the *second* row (the agents entry): the menu keeps the
    // tab it was opened on and closes the other unpinned one. Right-clicking
    // the board row would read the same behavior with "Issues" surviving,
    // and the assertion below pins the kept tab to the one clicked here.
    let rowButton: HTMLElement | null = null;
    await act(async () => {
      rowButton = hostRows(islandHost() as HTMLElement)[1]?.querySelector("button") ?? null;
      expect(rowButton).not.toBeNull();
      contextMenu(rowButton as HTMLElement);
    });
    const menu = shadow.querySelector<HTMLElement>("[role='menu'][aria-label='Tab actions']");
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("Pin tab");
    expect(menu?.textContent).toContain("Close other tabs");

    const closeOthers = [...(menu as Element).querySelectorAll<HTMLButtonElement>("button[role='menuitem']")]
      .find((item) => item.textContent === "Close other tabs");
    expect(closeOthers).not.toBeUndefined();
    act(() => {
      (closeOthers as HTMLButtonElement).click();
    });

    await settle(() => {
      expect(hostRows(host)).toHaveLength(1);
      expect(shadow.querySelector("[role='menu']")).toBeNull();
    });
    // The strip still renders its remaining tab.
    expect(fullStrip(host).textContent ?? "").toContain("Agents");
  });
});
