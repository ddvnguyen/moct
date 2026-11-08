// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  useTimelineDisplayStore,
} from "./timeline-display-store";

// Node 25 ships a partial `localStorage` shim under jsdom that's missing
// `clear`/`removeItem`; replace it with a real in-memory Storage so persist
// can round-trip values (same setup as sub-issue-display-store.test.ts).
beforeAll(() => {
  if (typeof globalThis.localStorage?.setItem !== "function") {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (k) => values.get(k) ?? null,
      key: (i) => Array.from(values.keys())[i] ?? null,
      removeItem: (k) => { values.delete(k); },
      setItem: (k, v) => { values.set(k, v); },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  }
});

describe("timeline display store", () => {
  beforeEach(() => {
    useTimelineDisplayStore.setState({ order: "oldest-first" });
  });

  it("defaults to oldest-first", () => {
    expect(useTimelineDisplayStore.getState().order).toBe("oldest-first");
  });

  it("toggleOrder flips between the two orders", () => {
    useTimelineDisplayStore.getState().toggleOrder();
    expect(useTimelineDisplayStore.getState().order).toBe("newest-first");
    useTimelineDisplayStore.getState().toggleOrder();
    expect(useTimelineDisplayStore.getState().order).toBe("oldest-first");
  });

  it("setOrder assigns the given order", () => {
    useTimelineDisplayStore.getState().setOrder("newest-first");
    expect(useTimelineDisplayStore.getState().order).toBe("newest-first");
  });
});
