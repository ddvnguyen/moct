import { createStore, type StoreApi } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import type { IslandStorage } from "./storage";
import {
  FAMILY_ROOTS,
  islandParent,
  islandPath,
  parseIslandRoute,
  type IslandRoute,
} from "./navigation";

export const TABS_CAP = 20;

/**
 * Visited locations the window keeps, oldest dropped past this (M-197).
 *
 * One history for the whole window rather than one per tab, so Back and
 * Forward walk the reader's actual path across tabs and the URLs inside them,
 * the way a browser's session history does. 100 is the Owner's cap.
 */
export const HISTORY_CAP = 100;

export interface IslandTab {
  id: string;
  url: string;
  pinned: boolean;
}

/** One visited location: the tab it belonged to, and where that tab stood. */
export interface HistoryEntry {
  readonly tabId: string;
  readonly url: string;
}

export interface TabsGroup {
  tabs: IslandTab[];
  activeId: string | null;
  mru: string[];
}

/**
 * The window's one history.
 *
 * `index` is the entry the window is standing on (`-1` before the first one),
 * and every entry names the tab it was visited in. Back and Forward move the
 * index, re-open the tab the entry belongs to at the entry's URL, and skip the
 * entries of tabs that have since been closed.
 */
export interface HistoryGroup {
  entries: HistoryEntry[];
  index: number;
}

export type TabsState = TabsGroup &
  HistoryGroup & {
    // tab lifecycle
    openTab: (url: string, options?: OpenTabOptions) => string;
    open: (url: string, options?: OpenTabOptions) => string;
    focusTab: (id: string) => void;
    focus: (id: string) => void;
    closeTab: (id: string) => void;
    close: (id: string) => void;
    togglePin: (id: string) => void;
    // rail entry handling
    railEntry: (entry: IslandRoute | string) => void;
    onRailEntry: (entry: IslandRoute | string) => void;
    openOrFocus: (url: string) => string;
    openOrFocusUrl: (url: string) => string;
    // navigation inside the active tab
    push: (path: string) => void;
    replace: (path: string) => void;
    back: () => boolean;
    forward: () => boolean;
    canGoBack: (route?: IslandRoute | null) => boolean;
    canGoForward: () => boolean;
    // helpers
    activeTab: () => IslandTab | null;
    activeUrl: () => string | null;
  };

export interface OpenTabOptions {
  activate?: boolean;
  insertAfterActive?: boolean;
  pinned?: boolean;
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function familyOfRoute(route: IslandRoute): string {
  switch (route.view) {
    case "board":
    case "issue":
      return "issues";
    case "agents":
    case "agent":
      return "agents";
    case "skills":
    case "skill":
      return "skills";
    case "inbox":
      return "inbox";
    case "chat":
      return "chat";
    case "settings":
      return "settings";
  }
}

export function familyOfUrl(url: string): string | null {
  const route = parseIslandRoute(url);
  if (route === null) return null;
  return familyOfRoute(route);
}

/** Dedup identity of a tab URL: its pathname (search/hash are view state). */
export function resourceKeyForUrl(url: string): string {
  const hash = url.indexOf("#");
  const query = url.indexOf("?");
  let cut = -1;
  if (query !== -1 && (hash === -1 || query < hash)) cut = query;
  else if (hash !== -1) cut = hash;
  return cut === -1 ? url : url.slice(0, cut);
}

export const resourceKeyOfUrl = resourceKeyForUrl;
export const resourceKey = resourceKeyForUrl;

/** The root the last tab of a family falls back to when the strip empties. */
function familyRootUrl(slug: string, url: string): string {
  const family = familyOfUrl(url);
  const root =
    family === null
      ? undefined
      : (Object.entries(FAMILY_ROOTS).find(([name]) => name === family)?.[1] as
          | IslandRoute
          | undefined);
  return root === undefined ? url : islandPath(slug, root);
}

/**
 * Append a visited location, dropping anything the reader had gone Back from
 * and the oldest entries past {@link HISTORY_CAP}.
 *
 * A repeat of the location already current (focusing the active tab, pressing
 * a rail row that is already open) is not a second visit: it keeps one entry.
 */
function pushEntry(history: HistoryGroup, entry: HistoryEntry): HistoryGroup {
  const kept = history.entries.slice(0, history.index + 1);
  const last = kept[kept.length - 1];
  if (last !== undefined && last.tabId === entry.tabId && last.url === entry.url) {
    return { entries: kept, index: kept.length - 1 };
  }
  const next = [...kept, entry];
  const overflow = Math.max(0, next.length - HISTORY_CAP);
  const entries = overflow === 0 ? next : next.slice(overflow);
  return { entries, index: entries.length - 1 };
}

/**
 * The nearest entry in `step`'s direction whose tab is still open, or `-1`.
 *
 * Closed tabs are skipped rather than pruned: the index of the entry the
 * window is standing on must not move when some other tab closes.
 */
function nearestLiveEntry(
  history: HistoryGroup,
  isOpen: (tabId: string) => boolean,
  from: number,
  step: 1 | -1,
): number {
  for (let at = from; at >= 0 && at < history.entries.length; at += step) {
    const entry = history.entries[at];
    if (entry !== undefined && isOpen(entry.tabId)) return at;
  }
  return -1;
}

export interface CreateTabsStoreOptions {
  storage: IslandStorage;
  /** Workspace whose paths this store builds; not part of the persist key (M-173). */
  slug: string;
}

export function createTabsStore(
  storageOrOptions: IslandStorage | CreateTabsStoreOptions,
  slugArg?: string,
): StoreApi<TabsState> {
  const storage =
    (storageOrOptions as CreateTabsStoreOptions).storage !== undefined
      ? (storageOrOptions as CreateTabsStoreOptions).storage
      : (storageOrOptions as IslandStorage);
  const slug =
    (storageOrOptions as CreateTabsStoreOptions).slug !== undefined
      ? (storageOrOptions as CreateTabsStoreOptions).slug
      : (slugArg as string);

  // One workspace, one tab set (M-173): the key dropped its per-slug suffix,
  // so a second history can never be stranded behind a slug change.
  const persistKey = "tabs.v1";

  const slice = (
    set: (partial: Partial<TabsState> | ((s: TabsState) => Partial<TabsState>)) => void,
    get: () => TabsState,
  ): TabsState => {
    const base: TabsGroup & HistoryGroup = {
      tabs: [],
      activeId: null,
      mru: [],
      entries: [],
      index: -1,
    };

    const update = (
      fn: (s: TabsGroup & HistoryGroup) => TabsGroup & HistoryGroup,
    ) => {
      const state = get();
      const current: TabsGroup & HistoryGroup = {
        tabs: state.tabs,
        activeId: state.activeId,
        mru: state.mru,
        entries: state.entries,
        index: state.index,
      };
      set(fn(current));
    };

    const focusId = (id: string) => {
      update((s) => {
        const tab = s.tabs.find((t) => t.id === id);
        if (tab === undefined) return s;
        return {
          ...s,
          activeId: id,
          mru: [id, ...s.mru.filter((x) => x !== id)],
          ...pushEntry(s, { tabId: id, url: tab.url }),
        };
      });
    };

    const evictIfNeeded = (s: TabsGroup & HistoryGroup): TabsGroup & HistoryGroup => {
      if (s.tabs.length < TABS_CAP) return s;
      // find least recently used unpinned tab that is not active
      const candidates = [...s.mru].reverse();
      let victim: string | null = null;
      for (const id of candidates) {
        if (id === s.activeId) continue;
        const tab = s.tabs.find((t) => t.id === id);
        if (tab && !tab.pinned) {
          victim = id;
          break;
        }
      }
      if (victim === null) {
        // fall back to oldest unpinned tab not active
        for (const t of s.tabs) {
          if (t.id !== s.activeId && !t.pinned) {
            victim = t.id;
            break;
          }
        }
      }
      if (victim === null) return s;
      return {
        ...s,
        tabs: s.tabs.filter((t) => t.id !== victim),
        activeId:
          s.activeId === victim
            ? (s.tabs.find((t) => t.id !== victim)?.id ?? null)
            : s.activeId,
        mru: s.mru.filter((x) => x !== victim),
      };
    };

    const openTab = (url: string, options?: OpenTabOptions) => {
      const activate = options?.activate !== false;
      const insertAfterActive = options?.insertAfterActive !== false;
      const pinned = options?.pinned === true;
      // Reuse an existing tab for the same resource (pathname), like upstream.
      const existing = get().tabs.find(
        (t) => resourceKeyForUrl(t.url) === resourceKeyForUrl(url),
      );
      if (existing) {
        if (activate) focusId(existing.id);
        return existing.id;
      }
      const id = newId();
      const tab: IslandTab = { id, url, pinned };
      update((s) => {
        const next = evictIfNeeded(s);
        const activeIndex = next.tabs.findIndex((t) => t.id === next.activeId);
        const insertAt =
          insertAfterActive && activeIndex >= 0 ? activeIndex + 1 : next.tabs.length;
        const tabs = [...next.tabs];
        tabs.splice(insertAt, 0, tab);
        const mru = activate ? [id, ...next.mru.filter((x) => x !== id)] : next.mru;
        const activeId = activate ? id : next.activeId;
        if (!activate) return { ...next, tabs, activeId, mru };
        return {
          ...next,
          tabs,
          activeId,
          mru,
          ...pushEntry(next, { tabId: id, url }),
        };
      });
      return id;
    };

    const closeTab = (id: string) => {
      update((s) => {
        const closed = s.tabs.find((t) => t.id === id);
        const tabs = s.tabs.filter((t) => t.id !== id);
        const mru = s.mru.filter((x) => x !== id);
        let activeId = s.activeId;
        if (activeId === id) {
          // most recently used other tab
          const nextMru = mru.find((x) => tabs.some((t) => t.id === x));
          activeId = nextMru ?? (tabs.length ? tabs[tabs.length - 1]!.id : null);
        }
        // close-last: open family root of closed tab
        if (tabs.length === 0) {
          const rootUrl =
            closed === undefined ? `/${slug}/issues` : familyRootUrl(slug, closed.url);
          const newTab: IslandTab = { id: newId(), url: rootUrl, pinned: false };
          return {
            ...s,
            tabs: [newTab],
            activeId: newTab.id,
            mru: [newTab.id],
            ...pushEntry(s, { tabId: newTab.id, url: rootUrl }),
          };
        }
        // The closed tab's own entries stay in the history: Back skips them
        // rather than rewriting the path the reader walked.
        return { ...s, tabs, activeId, mru };
      });
    };

    const openOrFocus = (url: string) => {
      const existing = get().tabs.find(
        (t) => resourceKeyForUrl(t.url) === resourceKeyForUrl(url),
      );
      if (existing) {
        focusId(existing.id);
        return existing.id;
      }
      return openTab(url, { activate: true });
    };

    const railEntry = (entry: IslandRoute | string) => {
      const route: IslandRoute | null =
        typeof entry === "string" ? parseIslandRoute(entry) : entry;
      if (route === null) return;
      const family = familyOfRoute(route);
      const entryUrl = typeof entry === "string" ? entry : islandPath(slug, entry);
      const active = get().tabs.find((t) => t.id === get().activeId);
      if (active !== undefined && familyOfUrl(active.url) === family) return;
      // The rail row is a destination, not a new tab: an open tab of that
      // family is re-focused, which visits it in the window's history.
      const familyTabIds = get()
        .tabs.filter((t) => familyOfUrl(t.url) === family)
        .map((t) => t.id);
      const mruFamily = get().mru.find((id) => familyTabIds.includes(id));
      if (mruFamily !== undefined) {
        focusId(mruFamily);
        return;
      }
      openTab(entryUrl, { activate: true });
    };

    const push = (path: string) => {
      update((s) => {
        const active = s.tabs.find((t) => t.id === s.activeId);
        if (!active) return s;
        const tabs = s.tabs.map((t) => (t.id === active.id ? { ...t, url: path } : t));
        return { ...s, tabs, ...pushEntry(s, { tabId: active.id, url: path }) };
      });
    };

    const replace = (path: string) => {
      update((s) => {
        const active = s.tabs.find((t) => t.id === s.activeId);
        if (!active) return s;
        const tabs = s.tabs.map((t) => (t.id === active.id ? { ...t, url: path } : t));
        // A replace stands for the entry the window is on, not a new visit:
        // the canonical identifier of the issue it is on is the same page.
        const current = s.entries[s.index];
        const entries =
          current !== undefined && current.tabId === active.id
            ? s.entries.map((e, at) => (at === s.index ? { ...e, url: path } : e))
            : s.entries;
        return { ...s, tabs, entries };
      });
    };

    const openEntry = (isOpen: (tabId: string) => boolean, at: number): boolean => {
      const entry = get().entries[at];
      if (entry === undefined || !isOpen(entry.tabId)) return false;
      update((s) => ({
        ...s,
        tabs: s.tabs.map((t) => (t.id === entry.tabId ? { ...t, url: entry.url } : t)),
        activeId: entry.tabId,
        mru: [entry.tabId, ...s.mru.filter((x) => x !== entry.tabId)],
        index: at,
      }));
      return true;
    };

    const isOpen = (tabId: string) => get().tabs.some((t) => t.id === tabId);

    const back = (): boolean => {
      const s = get();
      const at = nearestLiveEntry(s, isOpen, s.index - 1, -1);
      return at === -1 ? false : openEntry(isOpen, at);
    };

    const forward = (): boolean => {
      const s = get();
      const at = nearestLiveEntry(s, isOpen, s.index + 1, 1);
      return at === -1 ? false : openEntry(isOpen, at);
    };

    const canGoBackFn = (route?: IslandRoute | null) => {
      const s = get();
      if (nearestLiveEntry(s, isOpen, s.index - 1, -1) !== -1) return true;
      const active = s.tabs.find((t) => t.id === s.activeId);
      const r = route ?? (active ? parseIslandRoute(active.url) : null);
      return r !== null && islandParent(r) !== null;
    };

    const canGoForwardFn = () => {
      const s = get();
      return nearestLiveEntry(s, isOpen, s.index + 1, 1) !== -1;
    };

    const activeTab = () => get().tabs.find((t) => t.id === get().activeId) ?? null;
    const activeUrl = () => activeTab()?.url ?? null;

    const togglePin = (id: string) => {
      update((s) => ({
        ...s,
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
      }));
    };

    const actions = {
      openTab,
      open: openTab,
      focusTab: focusId,
      focus: focusId,
      closeTab,
      close: closeTab,
      togglePin,
      railEntry,
      onRailEntry: railEntry,
      openOrFocus,
      openOrFocusUrl: openOrFocus,
      push,
      replace,
      back,
      forward,
      canGoBack: canGoBackFn,
      canGoForward: canGoForwardFn,
      activeTab,
      activeUrl,
    };

    return { ...base, ...actions };
  };

  const store = createStore<TabsState>()(
    persist(slice as any, {
      name: persistKey,
      storage: createJSONStorage(() => storage),
      partialize: (state: TabsState) => ({
        tabs: state.tabs,
        activeId: state.activeId,
        mru: state.mru,
        // The window's history is part of the session: a reload keeps the path
        // Back walks, just as it keeps the tabs themselves (M-197).
        entries: state.entries,
        index: state.index,
      }),
    }),
  );

  return store;
}

// aliases
export const createIslandTabs = createTabsStore;
export const createIslandTabsStore = createTabsStore;
export const createTabStore = createTabsStore;
