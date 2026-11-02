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

// Same harness as tab-strip-menus.test.tsx: full island in a shadow root,
// a stubbed backend for the board's mount reads.
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

function hostRows(host: HTMLElement): HTMLElement[] {
  return [
    ...(host.shadowRoot as ShadowRoot).querySelectorAll<HTMLElement>(
      "[data-tab-strip] [data-tab-id]",
    ),
  ];
}

/** Sorts each row into the 160px slot its DOM index implies. */
function giveRects(host: HTMLElement): void {
  hostRows(host).forEach((row, ix) => {
    row.getBoundingClientRect = () =>
      ({
        left: 10 + ix * 160,
        right: 10 + ix * 160 + 160,
        width: 160,
        top: 0,
        bottom: 36,
        height: 36,
        x: 10 + ix * 160,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  });
}

function pointer(
  type: string,
  target: Element,
  opts: PointerEventInit,
): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        ...opts,
      }),
    );
  });
}

function rowTexts(host: HTMLElement): string[] {
  return hostRows(host).map((row) => (row.textContent ?? "").trim());
}

describe("tab strip drag-to-reorder (M-174)", () => {
  it("reorders at the strip: the handlers stay live through pointer capture", async () => {
    stubBackend();
    const seat = seatElement();

    act(() => attachSeat(seat, BOARD_ROUTE));
    await settle(() => {
      expect(hostRows(islandHost() as HTMLElement)).toHaveLength(1);
    });
    await act(async () => {
      attachIsland(seat, { view: "agents" });
    });
    await settle(() => {
      expect(hostRows(islandHost() as HTMLElement)).toHaveLength(2);
    });

    const host = islandHost() as HTMLElement;
    giveRects(host);
    expect(rowTexts(host)).toEqual(["Issues", "Agents"]);

    // Drag the Agents tab (row 1) left of the Issues tab. The press starts
    // on the tab button and MOVES hit the strip: with capture engaged on
    // the strip the browser retargets every pointer event there, so the
    // drag handlers must live on the strip — handlers on the pressed tab
    // would go silent on the first move and the drag would never land.
    const agents = hostRows(host)[1]!.querySelector("button") as HTMLElement;
    pointer("pointerdown", agents, { button: 0, pointerId: 9, clientX: 250, clientY: 18 });
    pointer("pointermove", agents, { button: 0, pointerId: 9, clientX: 80, clientY: 18 });
    expect(rowTexts(host)).toEqual(["Agents", "Issues"]); // landed mid-drag
    pointer("pointerup", agents, { button: 0, pointerId: 9, clientX: 80, clientY: 18 });
    await settle(() => {
      expect(rowTexts(host)).toEqual(["Agents", "Issues"]);
      // the dragging state clears on release
      expect(
        hostRows(host).every((row) => row.querySelector("[data-dragging]") === null),
      ).toBe(true);
    });

    // A press that never crosses the drag threshold stays a click: no
    // reorder follows from a tiny wiggle.
    const issues = hostRows(host).at(-1)!.querySelector("button") as HTMLElement;
    pointer("pointerdown", issues, { button: 0, pointerId: 11, clientX: 330, clientY: 18 });
    pointer("pointermove", issues, { button: 0, pointerId: 11, clientX: 333, clientY: 18 });
    pointer("pointerup", issues, { button: 0, pointerId: 11, clientX: 333, clientY: 18 });
    await settle(() => {
      expect(rowTexts(host)).toEqual(["Agents", "Issues"]);
    });
  });

  it("drops past the last midpoint at the end, not one slot short", async () => {
    stubBackend();
    const seat = seatElement();

    act(() => attachSeat(seat, BOARD_ROUTE));
    await settle(() => {
      expect(hostRows(islandHost() as HTMLElement)).toHaveLength(1);
    });
    await act(async () => {
      attachIsland(seat, { view: "agents" });
    });
    await settle(() => {
      expect(hostRows(islandHost() as HTMLElement)).toHaveLength(2);
    });

    const host = islandHost() as HTMLElement;
    giveRects(host);

    // Drag the first tab (Issues, row 0) right past EVERY midpoint. The
    // trailing slot is `tabs.length` pre-removal; initialising the target
    // one short meant `moveTab(from, from)` — a no-op that left the drag
    // doing nothing.
    const issues = hostRows(host)[0]!.querySelector("button") as HTMLElement;
    pointer("pointerdown", issues, { button: 0, pointerId: 7, clientX: 90, clientY: 18 });
    pointer("pointermove", issues, { button: 0, pointerId: 7, clientX: 420, clientY: 18 });
    pointer("pointerup", issues, { button: 0, pointerId: 7, clientX: 420, clientY: 18 });
    await settle(() => {
      expect(rowTexts(host)).toEqual(["Agents", "Issues"]);
    });
  });
});
