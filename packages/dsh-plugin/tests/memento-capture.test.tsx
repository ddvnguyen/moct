import { act, render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { describe, expect, it } from "vitest";
import { createIslandStorage } from "../src/client/storage";
import { createTabsStore, type TabsState } from "../src/client/tabs";
import {
  captureScrollEntries,
  createIslandScrollRestorationAdapter,
  watchScrollMemento,
} from "../src/client/memento-capture";
import type { StoreApi } from "zustand/vanilla";

/** jsdom has no layout: make one container really scrollable, by hand. */
function scrollable(el: HTMLElement, top: number, height: number) {
  Object.defineProperty(el, "scrollTop", { value: top, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: height, configurable: true });
}

/**
 * The page host as island-app mounts it: the capture subscription wired to
 * the element the pages render into.
 */
function MementoHost({
  tabsStore,
  children,
}: {
  tabsStore: StoreApi<TabsState>;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => watchScrollMemento(tabsStore, () => ref.current), [tabsStore]);
  return (
    <div ref={ref} data-island-page-root="">
      {children}
    </div>
  );
}

describe("captureScrollEntries", () => {
  it("collects only scrolled containers, keyed by their attribute", () => {
    const root = document.createElement("div");
    const unnamed = document.createElement("div");
    unnamed.setAttribute("data-tab-scroll-root", "");
    scrollable(unnamed, 12, 300);
    const named = document.createElement("div");
    named.setAttribute("data-tab-scroll-root", "filters");
    scrollable(named, 40, 800);
    const atTop = document.createElement("div");
    atTop.setAttribute("data-tab-scroll-root", "top");
    scrollable(atTop, 0, 500);
    root.append(unnamed, named, atTop);

    const entries = captureScrollEntries(root);
    expect(entries).toEqual({
      main: { top: 12, height: 300 },
      filters: { top: 40, height: 800 },
    });
  });

  it("is empty without a root", () => {
    expect(captureScrollEntries(null)).toEqual({});
  });
});

describe("watchScrollMemento (M-174)", () => {
  it("captures the outgoing route's containers during an in-tab navigation", () => {
    const s = createTabsStore(createIslandStorage({} as never), "demo");
    const id = s.getState().openTab("/demo/issues");
    const { container } = render(
      <MementoHost tabsStore={s}>
        <div data-tab-scroll-root="" />
      </MementoHost>,
    );
    scrollable(
      container.querySelector("[data-tab-scroll-root]") as HTMLElement,
      // The DOM the capture sees during `set` is still the issues page's.
      33,
      660,
    );
    act(() => {
      s.getState().push("/demo/issues/MUL-1");
    });
    expect(s.getState().tabs[0]?.url).toBe("/demo/issues/MUL-1");
    expect(s.getState().tabs[0]?.memento.scroll["/demo/issues::main"]).toEqual({
      top: 33,
      height: 660,
    });
    void id;
  });

  it("captures the outgoing tab on a tab switch, not the incoming one", () => {
    const s = createTabsStore(createIslandStorage({} as never), "demo");
    const a = s.getState().openTab("/demo/issues");
    const { container } = render(
      <MementoHost tabsStore={s}>
        <div data-tab-scroll-root="" />
      </MementoHost>,
    );
    scrollable(container.querySelector("[data-tab-scroll-root]") as HTMLElement, 9, 90);
    act(() => {
      s.getState().openTab("/demo/agents");
    });
    const outgoing = s.getState().tabs.find((t) => t.id === a);
    expect(outgoing?.memento.scroll["/demo/issues::main"]).toEqual({
      top: 9,
      height: 90,
    });
    const incoming = s.getState().tabs.find((t) => t.id !== a);
    expect(incoming?.memento.scroll).toEqual({});
  });

  it("captures nothing when the page root has left the DOM", () => {
    const s = createTabsStore(createIslandStorage({} as never), "demo");
    s.getState().openTab("/demo/issues");
    const { container } = render(<MementoHost tabsStore={s} />);
    Object.defineProperty(container, "_rootGone", { value: true });
    act(() => {
      s.getState().push("/demo/issues/MUL-1");
    });
    // No root mounted: the capture is empty, and an empty capture just
    // clears stale offsets instead of writing one.
    expect(s.getState().tabs[0]?.memento.scroll).toEqual({});
  });
});

describe("island restoration adapter (M-174)", () => {
  it("serves the active tab's entry for the current route at mount time", () => {
    const s = createTabsStore(createIslandStorage({} as never), "demo");
    const id = s.getState().openTab("/demo/issues");
    s.getState().commitScrollMemento(id, "/demo/issues", {
      main: { top: 77, height: 700 },
    });
    const adapter = createIslandScrollRestorationAdapter(s);
    expect(adapter.get("main")).toEqual({ top: 77, height: 700 });
    // A container with no entry on this route is undefined, not a neighbor's.
    expect(adapter.get("filters")).toBeUndefined();
  });

  it("rescopes on in-tab navigation: the old route keeps its entry out of view", () => {
    const s = createTabsStore(createIslandStorage({} as never), "demo");
    const id = s.getState().openTab("/demo/issues");
    s.getState().commitScrollMemento(id, "/demo/issues", {
      main: { top: 77, height: 700 },
    });
    s.getState().push("/demo/issues/MUL-2");
    const adapter = createIslandScrollRestorationAdapter(s);
    // The mounted page is now the issue; its own route has no offset yet,
    // and the board's entry stays stored (not served) until Back returns.
    expect(adapter.get("main")).toBeUndefined();
    expect(s.getState().tabs[0]?.memento.scroll["/demo/issues::main"]).toEqual({
      top: 77,
      height: 700,
    });
  });

  it("round-trips view state through the store", () => {
    const s = createTabsStore(createIslandStorage({} as never), "demo");
    s.getState().openTab("/demo/issues");
    const adapter = createIslandScrollRestorationAdapter(s);
    adapter.setViewState?.("opened-deep-link", "yes");
    expect(adapter.getViewState?.("opened-deep-link")).toBe("yes");
    adapter.setViewState?.("opened-deep-link", undefined);
    expect(adapter.getViewState?.("opened-deep-link")).toBeUndefined();
  });
});
