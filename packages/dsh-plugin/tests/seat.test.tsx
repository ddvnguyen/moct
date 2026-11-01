import { render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { DshClientContext } from "../src/dsh";
import {
  apply,
  configureHostRuntime,
  inject,
  MULTICA_ENTRIES,
  MULTICA_PANEL_ID,
} from "../src/client/index";
import { resetIsland } from "../src/client/island";
import { FAMILY_ROOTS } from "../src/client/navigation";
import { createRailIcon, createSeatComponent } from "../src/client/seat";
import { bindShell, selectShellPanel } from "../src/client/shell";
import type { DshLayout } from "../src/dsh";
import { setUnread, startUnreadPoll } from "../src/client/unread-store";

// `apply` starts the page-lifetime unread poller; stop the one it started so
// no interval outlives this file. A repeat call returns the live stop.
afterAll(async () => {
  startUnreadPoll()();
  // `apply` also warms the island on a 200ms timer, outside act, and nothing
  // in this file seats it. Vitest runs this file's tests as one macrotask, so
  // that timer can only fire once this hook yields — a mount in the gap before
  // vitest closes the jsdom environment leaves a pending react flush that
  // fires after the close and fails the run with "window is not defined".
  // Yield past the warm-up window, then tear the keep-alive host down the way
  // island.test's afterEach does.
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 250);
  await promise;
  resetIsland();
});

interface Registration {
  options: Record<string, unknown>;
  component: unknown;
}

function fakeSlots(layout?: DshLayout) {
  const registrations: Registration[] = [];
  const injected: string[] = [];
  const ctx: DshClientContext = {
    slots: {
      inject(key: string, register: () => unknown) {
        injected.push(key);
        return register();
      },
      register(options, component) {
        registrations.push({
          options: options as unknown as Record<string, unknown>,
          component,
        });
        return () => {};
      },
    },
    ...(layout === undefined ? {} : { layout }),
  };
  return { registrations, injected, ctx };
}

/** The layout service as dsh offers it: a selection snapshot and a toggle. */
function fakeLayout() {
  let activePanelId: string | null = null;
  const listeners = new Set<() => void>();
  const selected: (string | null)[] = [];
  let toggles = 0;
  const layout: DshLayout = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId }),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    selectPanel(panelId) {
      selected.push(panelId);
      activePanelId = panelId;
      for (const listener of listeners) listener();
    },
    toggleSidebar() {
      toggles += 1;
    },
  };
  const select = (panelId: string | null) => {
    activePanelId = panelId;
    for (const listener of listeners) listener();
  };
  return { layout, selected, select, toggles: () => toggles };
}

function byName(registrations: Registration[], name: string): Registration[] {
  return registrations.filter((entry) => entry.options.name === name);
}

describe("client apply", () => {
  it("adds one rail row and one keyed main seat per view", () => {
    const { ctx, registrations, injected } = fakeSlots();
    apply(ctx);

    // `layout` is dsh's own ui-layout service: the rail follows the active tab
    // and the sidebar collapses through it (M-197).
    expect(inject).toEqual(["slots", "layout"]);
    // Two contributions per entry, and each waits for its own slot.
    expect(injected).toEqual(
      MULTICA_ENTRIES.flatMap(() => ["sidebar.panellist", "main"]),
    );

    const rows = byName(registrations, "sidebar.panellist");
    const seats = byName(registrations, "main");
    expect(rows).toHaveLength(6);
    expect(seats).toHaveLength(6);
    expect(MULTICA_ENTRIES).toHaveLength(6);
  });

  it("labels the six entries and keeps the rail order", () => {
    const { ctx, registrations } = fakeSlots();
    apply(ctx);

    const rows = byName(registrations, "sidebar.panellist");
    expect(rows.map((entry) => entry.options.label)).toEqual([
      "Multica Issues",
      "Multica Agents",
      "Multica Skills",
      "Multica Inbox",
      "Multica Chat",
      "Multica Settings",
    ]);
    // A list slot has no grouping API: adjacent order is the grouping, and each
    // row's id is its own, so no shipped row is replaced.
    expect(rows.map((entry) => entry.options.order)).toEqual([30, 31, 32, 33, 34, 35]);
    for (const row of rows) expect(row.options.key).toBeUndefined();
    expect(new Set(rows.map((entry) => entry.options.id)).size).toBe(6);
    expect(rows[0]?.options.id).toBe(MULTICA_PANEL_ID);
  });

  it("binds the shell: the rail follows the active tab and MMX collapses the sidebar", () => {
    const shell = fakeLayout();
    const { ctx } = fakeSlots(shell.layout);
    apply(ctx);

    // The island's ask reaches the entry ids this module registered.
    selectShellPanel("chat");
    expect(shell.selected).toEqual(["multica-chat"]);

    // The auto-collapse rides the same layout service: entering an MMX row
    // collapses, leaving it restores.
    shell.select(null);
    const leaving = shell.toggles();
    shell.select("multica-agents");
    expect(shell.toggles()).toBe(leaving + 1);

    bindShell(null);
  });

  it("addresses each rail row with a matching main cell", () => {
    const { ctx, registrations } = fakeSlots();
    apply(ctx);

    const rowIds = byName(registrations, "sidebar.panellist").map((entry) =>
      String(entry.options.id),
    );
    const seatKeys = byName(registrations, "main").map((entry) =>
      String(entry.options.key),
    );
    // dsh selects a panel only when a `main` cell claims the same id.
    expect(seatKeys).toEqual(rowIds);
    for (const seat of byName(registrations, "main")) {
      expect(seat.options.priority).toBe(-100);
    }
  });

  it("opens each entry at its own view", () => {
    configureHostRuntime(createElement as never);
    for (const entry of MULTICA_ENTRIES) {
      const Seat = createSeatComponent(createElement as never, {
        panelId: entry.id,
        route: entry.route,
      });
      const element = Seat() as { type: string; props: Record<string, unknown> };
      expect(element.props["data-multica-panel"]).toBe(entry.id);
    }
    // One entry per family, and the first is the board.
    expect(MULTICA_ENTRIES.map((entry) => entry.route)).toEqual([
      FAMILY_ROOTS.issues,
      FAMILY_ROOTS.agents,
      FAMILY_ROOTS.skills,
      FAMILY_ROOTS.inbox,
      FAMILY_ROOTS.chat,
      FAMILY_ROOTS.settings,
    ]);
    configureHostRuntime(null);
  });
});

describe("seat component", () => {
  it("renders one host element and no hooks", () => {
    configureHostRuntime(createElement as never);
    const Seat = createSeatComponent(createElement as never, {
      panelId: MULTICA_PANEL_ID,
      route: FAMILY_ROOTS.issues,
    });
    // React 18 calls a component as a plain function; a hook here would throw.
    const element = Seat() as { type: string; props: Record<string, unknown> };
    expect(element.type).toBe("div");
    expect(element.props["data-multica-panel"]).toBe("multica");
    expect(typeof element.props.ref).toBe("function");
    configureHostRuntime(null);
  });

  it("sizes the rail glyph from the owner props", () => {
    for (const glyph of [
      "issues",
      "agents",
      "skills",
      "chat",
      "settings",
    ] as const) {
      const Icon = createRailIcon(createElement as never, glyph);
      const element = Icon({ size: 18 }) as {
        type: string;
        props: Record<string, unknown>;
      };
      expect(element.type).toBe("svg");
      expect(element.props.width).toBe(18);
      expect(element.props.height).toBe(18);
    }

    // The inbox row alone wraps its glyph in the dot's host span; the svg
    // inside keeps the same sizing contract as the other five rows.
    const Icon = createRailIcon(createElement as never, "inbox");
    const wrapper = Icon({ size: 18 }) as {
      type: string;
      props: { children: Array<{ type: string; props: Record<string, unknown> }> };
    };
    expect(wrapper.type).toBe("span");
    const svg = wrapper.props.children[0];
    expect(svg?.type).toBe("svg");
    expect(svg?.props.width).toBe(18);
    expect(svg?.props.height).toBe(18);
  });

  it("draws a different shape for every entry", () => {
    const drawn = MULTICA_ENTRIES.map((entry) => {
      const Icon = createRailIcon(createElement as never, entry.glyph);
      const element = Icon({ size: 16 }) as { props: { children: unknown[] } };
      return JSON.stringify(element.props.children);
    });
    expect(new Set(drawn).size).toBe(MULTICA_ENTRIES.length);
  });
});

/**
 * The inbox rail icon typed the way this test's React 19 renders it in JSX:
 * the host's `createElement` types its result as `unknown`, but the component
 * returns elements at runtime.
 */
function inboxRailIcon(): (props: { size?: number }) => ReactElement {
  return createRailIcon(createElement as never, "inbox") as (
    props: { size?: number },
  ) => ReactElement;
}

describe("inbox rail dot", () => {
  afterEach(() => {
    setUnread(0);
  });

  it("starts hidden with an empty store and follows the store", () => {
    setUnread(0);
    const Icon = inboxRailIcon();
    const { container, rerender } = render(<Icon />);

    const host = container.querySelector("span");
    expect(host).not.toBeNull();
    expect(host?.style.position).toBe("relative");
    expect(host?.style.display).toBe("inline-flex");
    expect(host?.querySelector("svg")).not.toBeNull();

    const dot = host?.querySelector<HTMLElement>("[data-multica-inbox-dot]");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("data-multica-inbox-dot")).toBe("");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.style.display).toBe("none");

    setUnread(3);
    expect(dot?.style.display).toBe("block");

    // A re-render must not lose the paint: React writes only the style
    // properties that changed between renders, and the dot's style prop
    // never changes — the store's imperative `display` write stands.
    rerender(<Icon />);
    expect(dot?.style.display).toBe("block");

    setUnread(0);
    expect(dot?.style.display).toBe("none");
  });

  it("detaches the dot when the row unmounts", () => {
    setUnread(2);
    const Icon = inboxRailIcon();
    const { container, unmount } = render(<Icon />);

    const dot = container.querySelector<HTMLElement>("[data-multica-inbox-dot]");
    expect(dot).not.toBeNull();
    expect(dot?.style.display).toBe("block");

    unmount();
    expect(dot?.style.display).toBe("none");

    // Detached: later counts no longer reach this node.
    setUnread(9);
    expect(dot?.style.display).toBe("none");
  });
});
