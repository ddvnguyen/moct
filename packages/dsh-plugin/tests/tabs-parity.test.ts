// @vitest-environment node
import { describe, expect, it } from "vitest";
import { STORAGE_PREFIX, createIslandStorage } from "../src/client/storage";
import {
  VIEW_MEMENTO_MAX_ENTRIES,
  createTabsStore,
  type MementoScrollEntry,
  type TabsState,
} from "../src/client/tabs";
import type { StoreApi } from "zustand/vanilla";

function memoryBacking() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function store(backing?: ReturnType<typeof memoryBacking>[]): StoreApi<TabsState> {
  const back = backing?.[0];
  return createTabsStore(
    createIslandStorage((back ?? memoryBacking()) as never),
    "demo",
  );
}

function scrollEntry(top: number): MementoScrollEntry {
  return { top, height: top * 10 };
}

describe("scroll memento (M-174)", () => {
  it("commits and reads back a container's offset for its route", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    s.getState().commitScrollMemento(a, "/demo/issues", {
      main: scrollEntry(120),
    });
    expect(s.getState().tabs[0]?.memento.scroll["/demo/issues::main"]).toEqual({
      top: 120,
      height: 1200,
    });
  });

  it("scopes entries by route: the second route never overwrites the first", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    s.getState().commitScrollMemento(a, "/demo/issues", { main: scrollEntry(9) });
    s.getState().push("/demo/issues/MUL-1");
    s.getState().commitScrollMemento(a, "/demo/issues/MUL-1", {
      main: scrollEntry(3),
    });
    const memento = s.getState().tabs[0]?.memento.scroll;
    expect(memento?.["/demo/issues::main"]).toMatchObject({ top: 9 });
    expect(memento?.["/demo/issues/MUL-1::main"]).toMatchObject({ top: 3 });
  });

  it("REPLACE per route: a scrolled-back capture clears the stale offset", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    s.getState().commitScrollMemento(a, "/demo/issues", { main: scrollEntry(7) });
    // The capture of an unscrolled re-visit is an empty record.
    s.getState().commitScrollMemento(a, "/demo/issues", {});
    expect(s.getState().tabs[0]?.memento.scroll).toEqual({});
  });

  it("skips the write when the replacement is identical (no re-entrant tick)", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    s.getState().commitScrollMemento(a, "/demo/issues", { main: scrollEntry(7) });
    let writes = 0;
    const unsubscribe = s.subscribe(() => {
      writes++;
    });
    s.getState().commitScrollMemento(a, "/demo/issues", { main: scrollEntry(7) });
    unsubscribe();
    expect(writes).toBe(0);
  });

  it("rides persistence: a rehydrated store comes back with what it saved", () => {
    const backing = [memoryBacking()];
    {
      const s = store(backing);
      const a = s.getState().openTab("/demo/issues");
      s.getState().commitScrollMemento(a, "/demo/issues", { main: scrollEntry(55) });
    }
    const s2 = store(backing);
    expect(
      s2.getState().tabs[0]?.memento.scroll["/demo/issues::main"],
    ).toEqual({ top: 55, height: 550 });
  });
});

describe("view state (M-174)", () => {
  it("writes, rewrites and clears one entry's lifecycle", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    s.getState().commitViewState(a, "/demo/issues", "opened-deep-link", "yes");
    expect(s.getState().tabs[0]?.memento.view["/demo/issues::opened-deep-link"]).toBe("yes");
    s.getState().commitViewState(a, "/demo/issues", "opened-deep-link", undefined);
    expect(s.getState().tabs[0]?.memento.view).toEqual({});
  });

  it("evicts the oldest-written entries past the cap", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    for (let i = 0; i <= VIEW_MEMENTO_MAX_ENTRIES; i++) {
      s.getState().commitViewState(a, "/demo/issues", `entry-${i}`, `${i}`);
    }
    const view = s.getState().tabs[0]?.memento.view ?? {};
    // 101 written, cap is 100: entry-0 (the oldest) is gone.
    expect(Object.keys(view)).toHaveLength(VIEW_MEMENTO_MAX_ENTRIES);
    expect(view["/demo/issues::entry-0"]).toBeUndefined();
    // A re-write counts as the newest write.
    s.getState().commitViewState(a, "/demo/issues", "entry-1", "again");
    expect(s.getState().tabs[0]?.memento.view["/demo/issues::entry-1"]).toBe("again");
  });
});

describe("pinned tabs (M-174)", () => {
  it("pinning moves the tab to the end of the pinned zone", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    const b = s.getState().openTab("/demo/agents");
    const c = s.getState().openTab("/demo/skills");
    s.getState().togglePin(b);
    expect(s.getState().tabs.map((t) => t.id)).toEqual([b, a, c]);
  });

  it("unpinning moves the tab to the start of the unpinned zone", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    const b = s.getState().openTab("/demo/agents");
    const c = s.getState().openTab("/demo/skills");
    s.getState().togglePin(a);
    s.getState().togglePin(c);
    // pinned: [a, c], unpinned: [b]
    s.getState().togglePin(c);
    expect(s.getState().tabs.map((t) => t.id)).toEqual([a, c, b]);
  });

  it("eviction never picks a pinned tab", () => {
    const s = store();
    const first = s.getState().openTab("/demo/issues");
    for (let i = 1; i < 20; i++) {
      s.getState().openTab(`/demo/agents/${i}`, { activate: false });
    }
    // The strip is at its cap; pin any other tab and open one more —
    // exactly one unpinned tab is evicted, never the pinned one, never the
    // active one.
    const second = s.getState().tabs[1]!;
    s.getState().togglePin(second.id);
    s.getState().openTab("/demo/skills");
    const ids = s.getState().tabs.map((t) => t.id);
    expect(ids).toHaveLength(20);
    expect(ids).toContain(first);
    expect(ids).toContain(second.id);
  });
});

describe("moveTab (M-174)", () => {
  function pinnedFirst(s: StoreApi<TabsState>) {
    s.getState().openTab("/demo/issues");
    s.getState().openTab("/demo/agents");
    s.getState().openTab("/demo/skills");
    s.getState().togglePin(s.getState().tabs.find((t) => t.url === "/demo/issues")!.id);
    // Strip: issues (pinned), agents, skills.
  }

  it("reorders within the strip", () => {
    const s = store();
    pinnedFirst(s);
    // Strip: issues (pinned), agents, skills. Swap the two unpinned tabs.
    s.getState().moveTab(2, 1);
    expect(familyUrls(s)).toEqual(["/demo/issues", "/demo/skills", "/demo/agents"]);
  });

  it("clamps drags at the pinned / unpinned boundary", () => {
    const s = store();
    pinnedFirst(s);
    // Boundary: index 1. An unpinned tab dragged into the pinned zone drops
    // AT the boundary instead of crossing it.
    s.getState().moveTab(1, 0);
    expect(familyUrls(s)).toEqual(["/demo/issues", "/demo/agents", "/demo/skills"]);
    // A pinned tab dragged into the unpinned zone clamps to its own zone's
    // last slot.
    s.getState().moveTab(0, 3);
    expect(familyUrls(s)).toEqual(["/demo/issues", "/demo/agents", "/demo/skills"]);
  });

  function familyUrls(s: StoreApi<TabsState>) {
    return s.getState().tabs.map((t) => t.url);
  }
});

describe("closeOtherTabs (M-174)", () => {
  it("closes every unpinned tab except the target and keeps pinned tabs", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    s.getState().togglePin(a);
    s.getState().openTab("/demo/agents");
    const c = s.getState().openTab("/demo/skills");
    const d = s.getState().openTab("/demo/inbox");
    s.getState().openOrFocus(c); // active: c
    s.getState().closeOtherTabs(d);
    expect(s.getState().tabs.map((t) => t.id)).toEqual([a, d]);
    // The active tab closed with the rest; the target survives and takes over.
    expect(s.getState().activeId).toBe(d);
  });

  it("is a no-op when nothing would close", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    s.getState().openTab("/demo/agents", { activate: false });
    s.getState().togglePin(s.getState().tabs[1]!.id);
    s.getState().closeOtherTabs(a);
    expect(s.getState().tabs).toHaveLength(2);
  });

  it("close-last still seeds a fresh tab of the closed family's root", () => {
    const s = store();
    s.getState().openTab("/demo/chat");
    s.getState().closeTab(s.getState().tabs[0]!.id);
    // The chat family's own root, not a silently-switched rail family.
    expect(s.getState().tabs[0]?.url).toBe("/demo/chat");
  });
});

describe("reloadActiveTab (M-174)", () => {
  it("bumps the mount generation for the active tab only", () => {
    const s = store();
    s.getState().openTab("/demo/issues");
    const before = s.getState().mountGeneration;
    s.getState().reloadActiveTab();
    expect(s.getState().mountGeneration).toBe(before + 1);
  });

  it("is inert without an active tab", () => {
    const s = store();
    s.getState().reloadActiveTab();
    expect(s.getState().mountGeneration).toBe(0);
  });
});

describe("goToHistoryIndex (M-174)", () => {
  it("jumps to an earlier live entry", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    s.getState().push("/demo/issues/MUL-1");
    s.getState().push("/demo/issues/MUL-2");
    expect(s.getState().goToHistoryIndex(0)).toBe(true);
    expect(s.getState().tabs.find((t) => t.id === a)?.url).toBe("/demo/issues");
  });

  it("refuses entries outside the strip's own history", () => {
    const s = store();
    s.getState().openTab("/demo/issues");
    expect(s.getState().goToHistoryIndex(99)).toBe(false);
  });
});

// The brief asked for a `tabs.v2` key with a migration; the store keeps
// `tabs.v1` and migrates inside the rehydrator instead. These tests are that
// migration contract: a payload written before pinning existed still loads
// (every tab unpinned), and a payload whose pinned flags arrive out of order is
// re-sorted to the pinned-first invariant on the way in.
describe("tabs.v1 payload migration (M-174)", () => {
  function seeded(payload: unknown) {
    const backing = memoryBacking();
    backing.setItem(`${STORAGE_PREFIX}tabs.v1`, JSON.stringify(payload));
    return store([backing]);
  }

  it("loads a pre-pin payload with every tab unpinned and a memento attached", () => {
    const s = seeded({
      state: {
        tabs: [
          { id: "a", url: "/demo/issues" },
          { id: "b", url: "/demo/issues/MUL-1" },
        ],
        activeId: "b",
        mru: ["b", "a"],
        entries: [
          { tabId: "a", url: "/demo/issues" },
          { tabId: "b", url: "/demo/issues/MUL-1" },
        ],
        index: 1,
      },
      version: 0,
    });
    const tabs = s.getState().tabs;
    expect(tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(tabs.every((t) => t.pinned === false)).toBe(true);
    expect(
      tabs.every((t) => Object.keys(t.memento.scroll).length === 0 && Object.keys(t.memento.view).length === 0),
    ).toBe(true);
    expect(s.getState().activeId).toBe("b");
    expect(s.getState().index).toBe(1);
  });

  it("re-sorts a payload whose pinned flags arrived out of order", () => {
    const s = seeded({
      state: {
        tabs: [
          { id: "a", url: "/demo/issues" },
          { id: "b", url: "/demo/issues/MUL-1", pinned: true },
          { id: "c", url: "/demo/issues/MUL-2" },
        ],
        activeId: "a",
        mru: ["a", "b", "c"],
        entries: [],
        index: -1,
      },
      version: 0,
    });
    expect(s.getState().tabs.map((t) => t.id)).toEqual(["b", "a", "c"]);
    expect(s.getState().tabs[0]?.pinned).toBe(true);
  });
});
