import { type StoreApi } from "zustand/vanilla";
import type { ScrollRestorationAdapter } from "../fork";
import {
  resourceKeyForUrl,
  scrollMementoKey,
  type MementoScrollEntry,
  type TabsState,
} from "./tabs";

/**
 * The island's platform half of the state-restoration protocol (M-174).
 *
 * Desktop 0.7.2 has a Coordinator that captures the outgoing views' scroll
 * offsets inside the store's own subscription — synchronously during `set`,
 * before React re-renders, so the outgoing DOM is still mounted — and serves
 * offsets back to mounting views through `ScrollRestorationProvider`. The
 * island mounts the same views, so it mounts the same plumbing: this module
 * is that Coordinator, scoped to what the island has.
 *
 * - {@link watchScrollMemento} is the capture pass. Plain scroll containers
 *   self-mark with `data-tab-scroll-root` (attribute value is the container
 *   key, "main" when bare); containers at 0 are absent from the capture, and
 *   the store's per-route REPLACE turns that absence into "clear the stale
 *   offset". External (out-of-DOM) scroll sources have no island use yet.
 * - {@link createIslandScrollRestorationAdapter} is the pull side, scoped
 *   per tab and per route at read time, exactly like desktop's per-tab
 *   adapter (`getActiveTabHost` memoized on the tab id).
 */

/** Scan the page root for scrollable containers with a saved-worthy offset. */
export function captureScrollEntries(
  root: HTMLElement | null,
): Record<string, MementoScrollEntry> {
  const entries: Record<string, MementoScrollEntry> = {};
  if (root === null) return entries;
  root.querySelectorAll<HTMLElement>("[data-tab-scroll-root]").forEach(
    (el) => {
      // A container scrolled back to 0 is simply absent — the store's
      // REPLACE semantics clear its stale offset for that route.
      if (el.scrollTop <= 0) return;
      const key = el.getAttribute("data-tab-scroll-root") || "main";
      entries[key] = { top: el.scrollTop, height: el.scrollHeight };
    },
  );
  return entries;
}

/**
 * Capture the outgoing route's scroll offsets on every change of what the
 * page shows. Runs inside the store's subscription, which fires
 * synchronously during `set()` — before React re-renders — so the outgoing
 * DOM (previous tab, previous route of the same tab, or the remounted page
 * of a reload) is still mounted when capture reads it.
 *
 * The capture root is only the page content (resolved through `getRoot` at
 * capture time), never the tab strip or the rail.
 *
 * Returns the unsubscribe function; the caller's effect wires it up and
 * tears it down.
 */
export function watchScrollMemento(
  tabsStore: StoreApi<TabsState>,
  getRoot: () => HTMLElement | null,
): () => void {
  let lastTabId: string | null = null;
  let lastUrl: string | null = null;
  let lastGeneration = tabsStore.getState().mountGeneration;

  // Prime what the DOM currently shows the way desktop's Coordinator does
  // in `initTabCoordinator`: the first change after wiring must see the
  // pre-change world as outgoing, or its capture would be lost.
  const prime = () => {
    const s = tabsStore.getState();
    const active = s.tabs.find((t) => t.id === s.activeId) ?? null;
    lastTabId = active?.id ?? null;
    lastUrl = active?.url ?? null;
    lastGeneration = s.mountGeneration;
  };
  prime();

  return tabsStore.subscribe(() => {
    const s = tabsStore.getState();
    const active = s.tabs.find((t) => t.id === s.activeId) ?? null;
    const activeUrl = active?.url ?? null;
    const hostSwitching =
      active?.id !== lastTabId || s.mountGeneration !== lastGeneration;
    const inTabNavigation = !hostSwitching && activeUrl !== lastUrl;
    if (!hostSwitching && !inTabNavigation) return;

    const outgoingTabId = lastTabId;
    const outgoingUrl = lastUrl;
    lastTabId = active?.id ?? null;
    lastUrl = activeUrl;
    lastGeneration = s.mountGeneration;

    if (outgoingTabId === null || outgoingUrl === null) return;
    const entries = captureScrollEntries(getRoot());
    // Always commit — an empty capture is the scrolled-back-to-0 case, and
    // the store skips the write itself when the replacement is identical.
    tabsStore
      .getState()
      .commitScrollMemento(
        outgoingTabId,
        resourceKeyForUrl(outgoingUrl),
        entries,
      );
  });
}

/**
 * The pull side. Reads live against the store's active tab, so the keys
 * resolve at mount time: a view asking during mount gets the restoring
 * tab's offset for *its* route — including the route after an in-tab Back
 * to an earlier entry, which is what per-route keying exists for.
 */
export function createIslandScrollRestorationAdapter(
  tabsStore: StoreApi<TabsState>,
): ScrollRestorationAdapter {
  const scope = ():
    | { tabId: string; routeKey: string }
    | null => {
    const s = tabsStore.getState();
    const active = s.tabs.find((t) => t.id === s.activeId);
    if (active === undefined) return null;
    return { tabId: active.id, routeKey: resourceKeyForUrl(active.url) };
  };

  return {
    get(containerKey) {
      const at = scope();
      if (at === null) return undefined;
      const entry =
        tabsStore.getState().tabs.find((t) => t.id === at.tabId)?.memento
          .scroll[scrollMementoKey(at.routeKey, containerKey)];
      return entry;
    },
    getViewState(entryKey) {
      const at = scope();
      if (at === null) return undefined;
      return tabsStore.getState().tabs.find((t) => t.id === at.tabId)
        ?.memento.view[scrollMementoKey(at.routeKey, entryKey)];
    },
    setViewState(entryKey, value) {
      const at = scope();
      if (at === null) return;
      tabsStore
        .getState()
        .commitViewState(at.tabId, at.routeKey, entryKey, value);
    },
  };
}
