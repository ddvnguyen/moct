import { createStore, type StoreApi } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import type { IslandStorage } from "./storage";

/**
 * One captured scroll offset (desktop 0.7.2 parity: the platform's
 * `ScrollRestorationEntry`). `contentKey` is optional only so external
 * capture sources can carry a content fingerprint; plain containers leave
 * it out and compare by identity.
 */
export interface MementoScrollEntry {
  top: number;
  height: number;
  contentKey?: string;
}

/**
 * A tab's memento: what a re-mount of its views should come back as.
 *
 * Both maps are keyed `${routeKey}::${containerKey}` — scoping by route so
 * in-tab Back/Forward restore each route's own state and same-named
 * containers on different routes never collide (desktop 0.7.2 semantics).
 * `scroll` is captured from the DOM before a tab or its route goes away;
 * `view` is written by views through the restoration adapter at the moment
 * their restorable state changes.
 */
export interface TabMemento {
  scroll: Record<string, MementoScrollEntry>;
  view: Record<string, string>;
}

export function emptyMemento(): TabMemento {
  return { scroll: {}, view: {} };
}

export function scrollMementoKey(
  routeKey: string,
  containerKey: string,
): string {
  return `${routeKey}::${containerKey}`;
}

/**
 * Upper bound on a tab's view-state entries. Scroll entries are bounded by
 * the per-route REPLACE, but view entries are only cleared by the views that
 * own them; a long-lived persisted tab would otherwise accumulate one entry
 * per thing ever opened in it. Oldest-written entries evict first — losing
 * one merely re-runs a deep-link landing that old (desktop parity).
 */
export const VIEW_MEMENTO_MAX_ENTRIES = 100;
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
  memento: TabMemento;
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
  /**
   * Reload = remount the active tab in place: every bump (a) key-remounts
   * the page (island-app) and (b) marks its live queries stale. Runtime
   * state of the window; not persisted — after a restart a fresh mount is
   * a reload by construction.
   */
  mountGeneration: number;
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
    /** Jump to one entry of the window's history (context menu; M-174). */
    goToHistoryIndex: (index: number) => boolean;
    // view-state persistence (M-174; desktop 0.7.2 memento semantics)
    commitScrollMemento: (
      tabId: string,
      routeKey: string,
      entries: Record<string, MementoScrollEntry>,
    ) => void;
    commitViewState: (
      tabId: string,
      routeKey: string,
      entryKey: string,
      value: string | undefined,
    ) => void;
    // ordering and lifecycle
    /**
     * Reorder. Clamped so a tab can never cross the pinned / unpinned
     * boundary — a drag that would is dropped at the boundary instead —
     * which keeps the "pinned tabs first" invariant without callers having
     * to know about it (desktop 0.7.2).
     */
    moveTab: (fromIndex: number, toIndex: number) => void;
    /**
     * Close every unpinned tab except the named one. Pinned tabs are never
     * closed by this (desktop 0.7.2); a no-op when nothing would close.
     */
    closeOtherTabs: (tabId: string) => void;
    /** Force-remount the active tab at the same URL: bump mountGeneration. */
    reloadActiveTab: () => void;
    // helpers
    activeTab: () => IslandTab | null;
    activeUrl: () => string | null;
  };

/**
 * Islands newer than the pinned-first invariant (a v1 payload written by a
 * build whose togglePin did not reorder) still rehydrate into store whose
 * strip always shows pinned tabs before unpinned ones.
 */
function withPinnedFirst(tabs: IslandTab[]): IslandTab[] {
  let anyUnpinned = false;
  for (const tab of tabs) {
    if (!tab.pinned) anyUnpinned = true;
    else if (anyUnpinned) return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
  }
  return tabs;
}

/**
 * Persisted payloads are untrusted: keep only the fields the store owns and
 * always attach a memento, so every consumer of `tab.memento` can bet on it.
 */
function sanitizeTab(raw: unknown): IslandTab | null {
  if (raw === null || typeof raw !== "object") return null;
  const id = (raw as { id?: unknown }).id;
  const url = (raw as { url?: unknown }).url;
  if (typeof id !== "string" || typeof url !== "string") return null;
  const source = raw as Record<string, unknown>;
  const memento = emptyMemento();
  const rawScroll = source.memento as Record<string, unknown> | undefined;
  if (
    rawScroll !== null &&
    typeof rawScroll === "object" &&
    rawScroll.scroll !== null &&
    typeof rawScroll.scroll === "object"
  ) {
    for (const [key, entry] of Object.entries(
      rawScroll.scroll as Record<string, unknown>,
    )) {
      if (entry === null || typeof entry !== "object") continue;
      const top = (entry as { top?: unknown }).top;
      const height = (entry as { height?: unknown }).height;
      if (typeof top !== "number" || typeof height !== "number") continue;
      const contentKey = (entry as { contentKey?: unknown }).contentKey;
      memento.scroll[key] =
        typeof contentKey === "string"
          ? { top, height, contentKey }
          : { top, height };
    }
  }
  if (
    rawScroll !== null &&
    typeof rawScroll === "object" &&
    rawScroll.view !== null &&
    typeof rawScroll.view === "object"
  ) {
    for (const [key, value] of Object.entries(
      rawScroll.view as Record<string, unknown>,
    )) {
      if (typeof value === "string") memento.view[key] = value;
    }
  }
  return { id, url, pinned: source.pinned === true, memento };
}

function sanitizeState(persisted: Record<string, unknown>) {
  const tabs = withPinnedFirst(
    (Array.isArray(persisted.tabs) ? persisted.tabs : [])
      .map((raw) => sanitizeTab(raw))
      .filter((tab): tab is IslandTab => tab !== null),
  );
  const byId = new Set(tabs.map((t) => t.id));
  const activeId =
    typeof persisted.activeId === "string" && byId.has(persisted.activeId)
      ? (persisted.activeId as string)
      : (tabs[0]?.id ?? null);
  const mru = Array.isArray(persisted.mru)
    ? persisted.mru.filter(
        (id: unknown): id is string => typeof id === "string" && byId.has(id),
      )
    : [];
  const index =
    typeof persisted.index === "number" && persisted.index >= 0
      ? Math.min(Math.trunc(persisted.index), Math.max((persisted.entries as unknown[])?.length ?? 0, 0) - 1)
      : -1;
  return { tabs, activeId, mru, entries: Array.isArray(persisted.entries) ? persisted.entries : [], index };
}

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
    case "decisions":
      return "decisions";
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
      mountGeneration: 0,
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
        mountGeneration: state.mountGeneration,
      };
      const next = fn(current);
      // An action that returns the slice it was handed is a no-op — do not
      // rebuild the state object (and do not notify) for an empty change.
      // This is what lets the memento commit sit inside the store's own
      // subscription during capture without re-entering itself.
      if (next === current) return;
      set(next);
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

    /** Index of the first unpinned tab in a strip (== pinned count). */
    const pinnedBoundary = (tabs: IslandTab[]): number => {
      let at = 0;
      while (at < tabs.length && tabs[at]?.pinned) at++;
      return at;
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
      const tab: IslandTab = { id, url, pinned, memento: emptyMemento() };
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
          const newTab: IslandTab = {
            id: newId(),
            url: rootUrl,
            pinned: false,
            memento: emptyMemento(),
          };
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

    /**
     * Flip a tab's pinned state, mobile-desktop parity: pinning moves it to
     * the end of the pinned zone (just before the first unpinned tab);
     * unpinning moves it to the start of the unpinned zone. Both keep the
     * "pinned tabs before unpinned tabs" invariant.
     */
    const togglePin = (id: string) => {
      update((s) => {
        const index = s.tabs.findIndex((t) => t.id === id);
        const current = s.tabs[index];
        if (current === undefined) return s;
        const nextTab = { ...current, pinned: !current.pinned };
        const without = [
          ...s.tabs.slice(0, index),
          ...s.tabs.slice(index + 1),
        ];
        const insertAt = pinnedBoundary(without);
        const tabs = [
          ...without.slice(0, insertAt),
          nextTab,
          ...without.slice(insertAt),
        ];
        return { ...s, tabs };
      });
    };

    const moveTab = (fromIndex: number, toIndex: number) => {
      update((s) => {
        if (fromIndex === toIndex) return s;
        if (fromIndex < 0 || fromIndex >= s.tabs.length) return s;
        // Clamp the drop position to within the source tab's zone (pinned
        // vs unpinned) so the "pinned tabs first" invariant survives a drag.
        const boundary = pinnedBoundary(s.tabs);
        const source = s.tabs[fromIndex];
        if (source === undefined) return s;
        const clampedTo = source.pinned
          ? Math.max(0, Math.min(toIndex, boundary - 1))
          : Math.max(boundary, Math.min(toIndex, s.tabs.length - 1));
        if (clampedTo === fromIndex) return s;
        const tabs = [...s.tabs];
        const [moved] = tabs.splice(fromIndex, 1);
        tabs.splice(clampedTo, 0, moved as IslandTab);
        return { ...s, tabs };
      });
    };

    const closeOtherTabs = (tabId: string) => {
      update((s) => {
        const keep = s.tabs.find((t) => t.id === tabId);
        if (keep === undefined) return s;
        const closing = s.tabs.filter((t) => !t.pinned && t.id !== tabId);
        if (closing.length === 0) return s;
        const closingIds = new Set(closing.map((t) => t.id));
        return {
          ...s,
          tabs: s.tabs.filter((t) => !closingIds.has(t.id)),
          mru: s.mru.filter((id) => !closingIds.has(id)),
          activeId: s.activeId !== null && closingIds.has(s.activeId) ? tabId : s.activeId,
        };
      });
    };

    const reloadActiveTab = () => {
      update((s) =>
        s.activeId === null ? s : { ...s, mountGeneration: s.mountGeneration + 1 },
      );
    };

    const commitScrollMemento = (
      tabId: string,
      routeKey: string,
      entries: Record<string, MementoScrollEntry>,
    ) => {
      update((s) => {
        const current = s.tabs.find((t) => t.id === tabId);
        if (current === undefined) return s;
        const memento = current.memento;
        // REPLACE per route: a container whose capture is absent (scrolled
        // back to 0) loses its stale offset instead of resurrecting it on
        // the next visit.
        const prefix = `${routeKey}::`;
        const nextScroll: Record<string, MementoScrollEntry> = {};
        for (const [key, entry] of Object.entries(memento.scroll)) {
          if (!key.startsWith(prefix)) nextScroll[key] = entry;
        }
        for (const [containerKey, entry] of Object.entries(entries)) {
          nextScroll[scrollMementoKey(routeKey, containerKey)] = entry;
        }
        // Skip the write when nothing changed — the common case is an
        // unscrolled route captured as empty over an already-empty route
        // scope, and the capture host commits inside the store's own
        // subscription, so a redundant write would re-enter it.
        const prevKeys = Object.keys(memento.scroll);
        const nextKeys = Object.keys(nextScroll);
        const unchanged =
          prevKeys.length === nextKeys.length &&
          prevKeys.every((key) => {
            const prev = memento.scroll[key];
            const next = nextScroll[key];
            return (
              prev !== undefined &&
              next !== undefined &&
              prev.top === next.top &&
              prev.height === next.height &&
              prev.contentKey === next.contentKey
            );
          });
        if (unchanged) return s;
        return {
          ...s,
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? { ...t, memento: { ...memento, scroll: nextScroll } }
              : t,
          ),
        };
      });
    };

    const commitViewState = (
      tabId: string,
      routeKey: string,
      entryKey: string,
      value: string | undefined,
    ) => {
      update((s) => {
        const current = s.tabs.find((t) => t.id === tabId);
        if (current === undefined) return s;
        const memento = current.memento;
        const key = scrollMementoKey(routeKey, entryKey);
        if (value === undefined) {
          if (!(key in memento.view)) return s;
          const view = { ...memento.view };
          delete view[key];
          return {
            ...s,
            tabs: s.tabs.map((t) =>
              t.id === tabId
                ? { ...t, memento: { ...memento, view } }
                : t,
            ),
          };
        }
        if (memento.view[key] === value) return s;
        // Re-bake so a re-written key counts as the newest one.
        const view = { ...memento.view };
        delete view[key];
        view[key] = value;
        const overflow =
          Object.keys(view).length - VIEW_MEMENTO_MAX_ENTRIES;
        if (overflow > 0) {
          // Insertion order is the write order: oldest written evicts first.
          for (const stale of Object.keys(view).slice(0, overflow)) {
            delete view[stale];
          }
        }
        return {
          ...s,
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? { ...t, memento: { ...memento, view } }
              : t,
          ),
        };
      });
    };

    const goToHistoryIndex = (at: number): boolean => {
      const s = get();
      if (at < 0 || at >= s.entries.length) return false;
      return openEntry(isOpen, at);
    };

    const actions = {
      openTab,
      open: openTab,
      focusTab: focusId,
      focus: focusId,
      closeTab,
      close: closeTab,
      togglePin,
      moveTab,
      closeOtherTabs,
      reloadActiveTab,
      commitScrollMemento,
      commitViewState,
      goToHistoryIndex,
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
      // Persisted payloads pass through sanitizeState: the pinned-first
      // invariant, valid ids, and a memento on every tab — the payload was
      // written by a previous build's rules.
      merge: (persisted, current) => ({
        ...current,
        ...sanitizeState((persisted ?? {}) as Record<string, unknown>),
        mountGeneration: 0,
      }) as typeof current,
    }),
  );

  return store;
}

// aliases
export const createIslandTabs = createTabsStore;
export const createIslandTabsStore = createTabsStore;
export const createTabStore = createTabsStore;
