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
import { HIDDEN_SETTINGS_TABS } from "../src/client/moct-settings";
import { runtimesDeviceTab } from "../src/client/moct-runtimes";

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

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const host of mounted.splice(0)) unmountIsland(host);
  resetIsland();
  document.body.replaceChildren();
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
      return json({
        groups: [
          { id: "none", assignee_type: null, assignee_id: null, issues: [], total: 0 },
        ],
      });
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

function shadow(): ShadowRoot {
  return (islandHost() as HTMLElement).shadowRoot as ShadowRoot;
}

function frames(): HTMLElement[] {
  return [...shadow().querySelectorAll<HTMLElement>("[data-tab-frame]")];
}

/** Right-click an element inside the island's shadow root. */
function contextMenu(el: Element) {
  el.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
  );
}

function menuItem(label: string): HTMLButtonElement {
  const menu = shadow().querySelector<HTMLElement>("[role='menu'][aria-label='Tab actions']");
  expect(menu).not.toBeNull();
  const item = [
    ...(menu as HTMLElement).querySelectorAll<HTMLButtonElement>("button[role='menuitem']"),
  ].find((candidate) => candidate.textContent === label);
  expect(item).toBeDefined();
  return item as HTMLButtonElement;
}

/** Attach the seat's board tab plus one second tab, both in the strip. */
async function attachTwoTabs(): Promise<HTMLElement> {
  stubBackend();
  const seat = seatElement();
  act(() => attachSeat(seat, BOARD_ROUTE));
  await settle(() => {
    expect(frames()).toHaveLength(1);
  });
  await act(async () => {
    attachIsland(seat, { view: "agents" });
  });
  const host = islandHost();
  if (host) mounted.push(host);
  await settle(() => {
    expect(frames()).toHaveLength(2);
  });
  return seat;
}

describe("tab strip appearance (M-174)", () => {
  it("draws every tab as a pill, the active one on the content surface", async () => {
    await attachTwoTabs();

    // The strip is a pill row: centred, 6px apart, no inset gutters.
    const strip = shadow().querySelector<HTMLElement>("[data-tab-strip]") as HTMLElement;
    expect(strip.classList.contains("items-center")).toBe(true);
    expect(strip.classList.contains("items-end")).toBe(false);
    expect(strip.classList.contains("gap-1.5")).toBe(true);

    const pills = frames().map((frame) => {
      const pill = frame.querySelector<HTMLElement>("span[aria-hidden]");
      expect(pill).not.toBeNull();
      const active = frame.querySelector("button[data-active]") !== null;
      return { pill: pill as HTMLElement, active };
    });
    expect(pills).toHaveLength(2);
    for (const { pill } of pills) {
      // Both states are the same shape: an inset pill, not a fill of the row.
      expect(pill.classList.contains("rounded-lg")).toBe(true);
      expect(pill.classList.contains("inset-y-1.5")).toBe(true);
      expect(pill.classList.contains("transition-colors")).toBe(true);
    }
    const activePill = pills.find((candidate) => candidate.active)?.pill;
    const inactivePill = pills.find((candidate) => !candidate.active)?.pill;
    expect(activePill?.classList.contains("ring-1")).toBe(true);
    expect(activePill?.classList.contains("ring-surface-border")).toBe(true);
    expect(activePill?.classList.contains("bg-page-canvas")).toBe(true);
    // The unselected tab is a lighter tint of the same material, brightening
    // under the pointer rather than flipping to another colour.
    expect(inactivePill?.classList.contains("bg-page-canvas/50")).toBe(true);
    expect(inactivePill?.classList.contains("group-hover/tab:bg-page-canvas/80")).toBe(true);
  });

  it("marks the pinned zone and refuses Close on a pinned tab", async () => {
    await attachTwoTabs();
    expect(shadow().querySelector("[data-tab-zone-divider]")).toBeNull();

    // Pin the trailing tab from its own menu; pinning re-sorts it to the front,
    // so the strip is [pinned, unpinned] and the zones need a boundary.
    const trailingFrame = frames()[1];
    expect(trailingFrame).toBeDefined();
    const trailingButton = (trailingFrame as HTMLElement).querySelector("button") as HTMLElement;
    await act(async () => {
      contextMenu(trailingButton);
    });
    await settle(() => expect(menuItem("Pin tab")).toBeDefined());
    act(() => menuItem("Pin tab").click());
    await settle(() => {
      expect(shadow().querySelector("[data-tab-zone-divider]")).not.toBeNull();
    });
    expect(frames()).toHaveLength(2);

    // Desktop rule: closing a pinned tab requires unpinning it first, and the
    // pin item now offers the inverse.
    const pinnedFrame = frames()[0];
    expect(pinnedFrame).toBeDefined();
    const pinnedButton = (pinnedFrame as HTMLElement).querySelector("button") as HTMLElement;
    await act(async () => {
      contextMenu(pinnedButton);
    });
    await settle(() => expect(menuItem("Unpin tab")).toBeDefined());
    expect(menuItem("Close").disabled).toBe(true);
    expect(menuItem("Close other tabs").disabled).toBe(false);
  });

  it("offers the shared Runtimes page from Settings", () => {
    // The island's only door to runtimes: the fork's host-supplied device slot.
    expect(runtimesDeviceTab.value).toBe("runtimes");
    expect(runtimesDeviceTab.label).toBe("Runtimes");
    expect(runtimesDeviceTab.icon).toBeTruthy();
    expect(runtimesDeviceTab.content).not.toBeNull();
    // Hiding a built-in page must never take this one with it.
    expect((HIDDEN_SETTINGS_TABS as readonly string[]).includes("runtimes")).toBe(false);
  });
});
