// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createIslandStorage } from "../src/client/storage";
import { createTabsStore } from "../src/client/tabs";

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

describe("tabs reuse", () => {
  it("reuses the same tab for the same route twice", () => {
    const storage = createIslandStorage(memoryBacking() as any);
    const store = createTabsStore(storage, "demo");
    const first = store.getState().openTab("/demo/issues");
    const second = store.getState().openOrFocus("/demo/issues");
    expect(second).toBe(first);
    expect(store.getState().tabs).toHaveLength(1);
  });

  it("reuses the same tab for the same route with a query", () => {
    const storage = createIslandStorage(memoryBacking() as any);
    const store = createTabsStore(storage, "demo");
    const first = store.getState().openTab("/demo/issues");
    const second = store.getState().openOrFocus("/demo/issues?filter=a");
    expect(second).toBe(first);
    expect(store.getState().tabs).toHaveLength(1);
  });

  it("creates separate tabs for two different issues", () => {
    const storage = createIslandStorage(memoryBacking() as any);
    const store = createTabsStore(storage, "demo");
    const first = store.getState().openTab("/demo/issues/MUL-1");
    const second = store.getState().openTab("/demo/issues/MUL-2");
    expect(second).not.toBe(first);
    expect(store.getState().tabs).toHaveLength(2);
  });

  it("reuses a pinned tab instead of opening a duplicate", () => {
    const storage = createIslandStorage(memoryBacking() as any);
    const store = createTabsStore(storage, "demo");
    const first = store.getState().openTab("/demo/issues", { pinned: true });
    const second = store.getState().openOrFocus("/demo/issues?x=1");
    expect(second).toBe(first);
    expect(store.getState().tabs[0]?.pinned).toBe(true);
  });

  it("closing the reused tab removes it", () => {
    const storage = createIslandStorage(memoryBacking() as any);
    const store = createTabsStore(storage, "demo");
    const first = store.getState().openTab("/demo/issues");
    store.getState().openOrFocus("/demo/issues?x=1");
    store.getState().closeTab(first);
    expect(store.getState().tabs.find((t) => t.id === first)).toBeUndefined();
  });
});
