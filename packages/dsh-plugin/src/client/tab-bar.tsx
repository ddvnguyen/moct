import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { TabsState } from "./tabs";
import { tabLabel } from "./tab-label";
import {
  BOARD_ROUTE,
  islandPath,
  parseIslandRoute,
} from "./navigation";
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  X,
  Pin,
  PinOff,
  Search,
  TruncatedTooltip,
  cn,
  useSearchStore,
} from "../fork";
import { useTabPresentation, ResourceLeadingVisual } from "../fork";
import type { NavigationAdapter } from "../fork";
export const headerTrailing = <div data-header-trailing="" />;

export function HeaderTrailing() {
  return <div data-header-trailing="" />;
}

// ─── Strip context menus (M-174) ─────────────────────────────────────────
//
// Both menus are the island's own small popovers, not the fork's dialog
// machinery: they position against the pointer, live in the strip's own
// render tree (the popup seat's portal host is for Base UI popups), and
// close on an outside pointerdown, another right-click, or Escape.
//
// A transparent backdrop under the menu is the click-away, rather than a
// window listener: inside the island's shadow root a window listener sees
// retargeted hosts, which would give `contains()` nothing to compare and
// close the menu under its own pointerdown.

const menuSurfaceClassName =
  "fixed z-70 min-w-44 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none";

const menuItemClassName =
  "flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-caption outline-none hover:bg-popover-accent hover:text-popover-accent-foreground disabled:pointer-events-none disabled:opacity-40";

function FloatingMenu({
  at,
  onClose,
  ariaLabel,
  children,
}: {
  at: { x: number; y: number };
  onClose: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
  // Keep the surface on screen against the pointer (the strip sits at the
  // top of a panel, so the menu's own growth heads downward; clamp both
  // axes against the viewport and read them back on every open).
  const left = Math.max(4, Math.min(at.x - 4, window.innerWidth - 184));
  const top = Math.max(4, Math.min(at.y + 2, window.innerHeight - 160));
  return (
    // The backdrop closes on outside pointerdown and outside right-click;
    // the menu stops its own pointerdown so choosing an item survives.
    <div
      className="fixed inset-0 z-70"
      onPointerDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        role="menu"
        aria-label={ariaLabel}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        style={{ left, top }}
        className={menuSurfaceClassName}
      >
        {children}
      </div>
    </div>
  );
}

const VIEW_FALLBACK_NAMES = {
  board: "Issues",
  issue: "Issue",
  agents: "Agents",
  agent: "Agent",
  skills: "Skills",
  skill: "Skill",
  inbox: "Inbox",
  chat: "Chat",
  settings: "Settings",
} as const;

/** A history entry's label: live titles when resolvable, route names otherwise. */
function HistoryEntryLabel({ url }: { url: string }) {
  const presentation = useTabPresentation(url);
  const label = tabLabel(
    url,
    presentation.title ||
      (VIEW_FALLBACK_NAMES as Record<string, string | undefined>)[
        parseIslandRoute(url)?.view ?? ""
      ] ||
      url,
  );
  return <span className="truncate">{label.name}</span>;
}

function HistoryContextMenu({
  at,
  tabsStore,
  onClose,
}: {
  at: { x: number; y: number };
  tabsStore: StoreApi<TabsState>;
  onClose: () => void;
}) {
  const state = useStore(tabsStore);
  // Newest at the bottom, like the browser's own long-press menu.
  const items = state.entries.map((entry, index) => ({ entry, index }));
  if (items.length === 0) return null;
  return (
    <FloatingMenu at={at} onClose={onClose} ariaLabel="Tab history">
      {items.map(({ entry, index }) => {
        const live = state.tabs.some((t) => t.id === entry.tabId);
        return (
          <button
            key={`${entry.tabId}:${index}`}
            type="button"
            role="menuitem"
            aria-current={index === state.index ? "true" : undefined}
            disabled={!live}
            title={live ? undefined : "Closed tab — unavailable from history"}
            onClick={() => {
              tabsStore.getState().goToHistoryIndex(index);
              onClose();
            }}
            className={cn(
              menuItemClassName,
              "gap-2 text-left",
              index === state.index && "font-medium",
            )}
          >
            <span
              className={cn(
                "size-1 shrink-0 rounded-full bg-current",
                index !== state.index && "opacity-0",
              )}
            />
            <HistoryEntryLabel url={entry.url} />
          </button>
        );
      })}
    </FloatingMenu>
  );
}

function TabContextMenu({
  at,
  tabId,
  isActive,
  tabsStore,
  onClose,
}: {
  at: { x: number; y: number };
  tabId: string;
  isActive: boolean;
  tabsStore: StoreApi<TabsState>;
  onClose: () => void;
}) {
  const pinned = tabsStore.getState().tabs.find((t) => t.id === tabId)?.pinned === true;
  const closingOther = tabsStore
    .getState()
    .tabs.some((t) => t.id !== tabId && !t.pinned);
  const item = (
    label: string,
    onClick: () => void,
    disabled = false,
  ) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onClick();
        onClose();
      }}
      className={menuItemClassName}
    >
      {label}
    </button>
  );
  return (
    <FloatingMenu at={at} onClose={onClose} ariaLabel="Tab actions">
      {item(
        pinned ? "Unpin tab" : "Pin tab",
        () => tabsStore.getState().togglePin(tabId),
      )}
      {item(
        "Reload",
        () => tabsStore.getState().reloadActiveTab(),
        !isActive,
      )}
      {item("Close", () => tabsStore.getState().closeTab(tabId))}
      {item(
        "Close other tabs",
        () => tabsStore.getState().closeOtherTabs(tabId),
        !closingOther,
      )}
    </FloatingMenu>
  );
}

function TabItem({
  tab,
  isActive,
  isOnly,
  isDragging,
  activeRef,
  tabsStore,
  openContextMenu,
}: {
  tab: { id: string; url: string; pinned?: boolean };
  isActive: boolean;
  isOnly: boolean;
  /** Strip-owned drag state: this tab is the one being dragged (M-174). */
  isDragging: boolean;
  activeRef: React.RefObject<HTMLButtonElement | null> | null;
  tabsStore: StoreApi<TabsState>;
  /** Context-menu host above `TabItem` (strip-level placement state). */
  openContextMenu: (at: { x: number; y: number }, tabId: string) => void;
}) {
  const presentation = useTabPresentation(tab.url);
  // An issue reads as `M-123` with its title in the tooltip; every other tab
  // keeps the fork's own name and needs no tooltip (M-197).
  const label = tabLabel(tab.url, presentation.title);
  const isPinned = tab.pinned === true;
  const showCloseButton = !isPinned && !isOnly;
  const tooltipContent = label.tooltip ?? label.name;

  const handleTogglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    tabsStore.getState().togglePin(tab.id);
  };
  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    tabsStore.getState().closeTab(tab.id);
  };

  return (
    <div
      data-tab-id={tab.id}
      className={cn("h-9 w-40 min-w-32", isActive && "z-10")}
    >
      <button
        ref={isActive ? activeRef : undefined}
        type="button"
        title={label.tooltip}
        data-active={isActive || undefined}
        data-dragging={isDragging || undefined}
        onClick={() => tabsStore.getState().focusTab(tab.id)}
        onAuxClick={(e) => {
          if (e.button === 1 && showCloseButton) {
            e.preventDefault();
            tabsStore.getState().closeTab(tab.id);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openContextMenu({ x: e.clientX, y: e.clientY }, tab.id);
        }}
        className={cn(
          "group relative flex size-full min-w-0 items-center gap-1.5 px-2.5 pb-1 text-caption transition-colors select-none cursor-default",
          isActive
            ? "font-medium text-foreground"
            : "text-muted-foreground hover:text-sidebar-accent-foreground",
          isDragging && "opacity-60",
        )}
      >
        <ResourceLeadingVisual visual={presentation.visual} />
        <TruncatedTooltip content={tooltipContent}>
          <span
            className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left"
            style={{
              maskImage:
                "linear-gradient(to right, black calc(100% - 12px), transparent)",
              WebkitMaskImage:
                "linear-gradient(to right, black calc(100% - 12px), transparent)",
            }}
          >
            {label.name}
          </span>
        </TruncatedTooltip>
        <span
          onClick={handleTogglePin}
          role="button"
          aria-label={isPinned ? "Unpin" : "Pin"}
          className="hidden size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors group-hover:flex hover:bg-muted-foreground/20 hover:text-foreground"
        >
          {isPinned ? (
            <PinOff className="size-2.5" />
          ) : (
            <Pin className="size-2.5" />
          )}
        </span>
        {showCloseButton && (
          <span
            onClick={handleClose}
            role="button"
            aria-label="Close"
            className="hidden size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors group-hover:flex hover:bg-muted-foreground/20 hover:text-foreground"
          >
            <X className="size-2.5" />
          </span>
        )}
      </button>
    </div>
  );
}

const navButtonClassName =
  "flex size-7 items-center justify-center rounded-md text-faint-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-30 motion-reduce:transition-none";

function NewTabButton({
  tabsStore,
  slug,
}: {
  tabsStore: StoreApi<TabsState>;
  slug: string;
}) {
  const handleClick = () => {
    const url = islandPath(slug, BOARD_ROUTE);
    const id = tabsStore.getState().openTab(url);
    tabsStore.getState().focusTab(id);
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="New tab"
      title="New tab"
      className="flex size-7 shrink-0 items-center justify-center self-center rounded-md text-faint-foreground transition-colors hover:bg-muted/50 hover:text-muted-foreground"
    >
      <Plus className="size-3.5" />
    </button>
  );
}

function SearchButton() {
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);
  if (!expanded) {
    return (
      <button
        type="button"
        aria-label="Search"
        title="Search"
        onClick={() => setExpanded(true)}
        className="flex size-7 shrink-0 items-center justify-center self-center rounded-md text-faint-foreground transition-colors hover:bg-muted/50 hover:text-muted-foreground"
      >
        <Search className="size-3.5" />
      </button>
    );
  }
  return (
    <input
      ref={inputRef}
      type="text"
      placeholder="Search"
      aria-label="Search"
      className="h-7 w-40 shrink-0 rounded-md border border-border bg-transparent px-2 text-sm outline-none"
      onFocus={() => useSearchStore.getState().setOpen(true)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          setExpanded(false);
        }
      }}
      onBlur={() => setExpanded(false)}
    />
  );
}

export function TabBar({
  tabsStore,
  navigation,
  projectPicker,
  slug,
}: {
  tabsStore: StoreApi<TabsState>;
  navigation: NavigationAdapter;
  /** Host-owned project filter rendered between back/forward and the strip. */
  projectPicker?: React.ReactNode;
  slug?: string;
}) {
  const state = useStore(tabsStore);
  const tabs = state.tabs;
  const activeId = state.activeId;

  // Strip context menus (M-174): one kind at a time, positioned against the
  // pointer that opened them. The tab menu opens on a tab's own
  // contextmenu; the history menu opens on a right-click of either
  // history button, the strip-local equivalent of the browser's
  // long-press-on-Back.
  const [tabMenu, setTabMenu] = useState<
    { at: { x: number; y: number }; tabId: string } | null
  >(null);
  const [historyMenu, setHistoryMenu] = useState<
    { at: { x: number; y: number } } | null
  >(null);
  // One history for the whole window (M-197): Back and Forward cross tabs, so
  // whether they have somewhere to go is the store's answer, not the active
  // tab's own stack.
  const canGoBack = navigation.canGoBack?.() ?? false;
  const canGoForward = state.canGoForward();

  // Drag-to-reorder (M-174). The drag lives on the strip, not the pressed
  // tab: once capture engages the browser retargets every pointer event to
  // the strip, so handlers a level below go silent mid-drag (a tab would
  // freeze in its dragging state and never reorder). The drop order lives
  // in the store: `moveTab` clamps into the pinned / unpinned zones and
  // removes-then-inserts, so a rightward drag targeting the hovered tab's
  // slot must drop one narrower — before it, not through it.
  const dragRef = useRef<{
    pointerId: number;
    tabId: string;
    startX: number;
    startY: number;
    engaged: boolean;
  } | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);

  const endStripDrag = () => {
    dragRef.current = null;
    setDraggingTabId(null);
  };

  const handleStripPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[role="button"][aria-label]')) {
      // A knob (Pin / Close) owns the press, not the tab.
      return;
    }
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-tab-id]");
    const tabId = row?.getAttribute("data-tab-id");
    if (!tabId) return;
    dragRef.current = {
      pointerId: e.pointerId,
      tabId,
      startX: e.clientX,
      startY: e.clientY,
      engaged: false,
    };
  };

  const handleStripPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || e.pointerId !== drag.pointerId) return;
    if (
      !drag.engaged &&
      Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4
    ) {
      return; // a press that never crosses the threshold stays a click
    }
    // Hold capture on the strip once a real drag starts, so the moves keep
    // arriving when the pointer leaves the strip's rows (edge-scroll at
    // the strip's ends stays possible later if the cap is ever lifted).
    if (!drag.engaged) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Capture is an optimization here, not a requirement: without it a
        // pointer that leaves the strip ends the drag on the next move.
      }
      drag.engaged = true;
      setDraggingTabId(drag.tabId);
    }
    const strip = e.currentTarget;
    // Drop-before rule: land before the first tab whose midpoint the
    // pointer has passed; past the last midpoint, land at the end. The
    // slot is pre-removal (0..tabs.length), and `toIndex` maps it into the
    // post-removal index `moveTab` consumes: initialising the target at
    // `tabs.length - 1` read the trailing slot one short, so dragging past
    // every midpoint never reached the end.
    const s = tabsStore.getState();
    const fromIndex = s.tabs.findIndex((t) => t.id === drag.tabId);
    if (fromIndex < 0) {
      endStripDrag();
      return;
    }
    let targetIndex = s.tabs.length;
    const rows = strip.querySelectorAll<HTMLElement>("[data-tab-id]");
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (e.clientX < rect.left + rect.width / 2) {
        const rowId = row.getAttribute("data-tab-id");
        const rowIndex = s.tabs.findIndex((t) => t.id === rowId);
        if (rowIndex >= 0) targetIndex = rowIndex;
        break;
      }
    }
    const toIndex = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
    if (fromIndex !== toIndex) s.moveTab(fromIndex, toIndex);
  };

  const handleStripPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || e.pointerId !== drag.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Already released by the browser on pointerup.
    }
    endStripDrag();
  };

  const stripRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (event: PointerEvent) => {
      if (event.button === 3) {
        event.preventDefault();
        navigation.back();
      } else if (event.button === 4) {
        event.preventDefault();
        navigation.forward?.();
      }
    };
    el.addEventListener("pointerdown", handler);
    return () => el.removeEventListener("pointerdown", handler);
  }, [navigation]);

  return (
    <div
      ref={containerRef}
      className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border px-2"
    >
      <button
        type="button"
        aria-label="Back"
        disabled={!canGoBack}
        onClick={() => navigation.back()}
        onContextMenu={(e) => {
          e.preventDefault();
          setTabMenu(null);
          setHistoryMenu({ at: { x: e.clientX, y: e.clientY } });
        }}
        className={navButtonClassName}
      >
        <ArrowLeft className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Forward"
        disabled={!canGoForward}
        onClick={() => navigation.forward?.()}
        onContextMenu={(e) => {
          e.preventDefault();
          setTabMenu(null);
          setHistoryMenu({ at: { x: e.clientX, y: e.clientY } });
        }}
        className={navButtonClassName}
      >
        <ArrowRight className="size-4" />
      </button>
      {projectPicker}
      {/* `data-tab-strip` is the strip's own address: the tests walk it, and
          nothing in the shell depends on the class names. */}
      <div
        ref={stripRef}
        data-tab-strip=""
        onPointerDown={handleStripPointerDown}
        onPointerMove={handleStripPointerMove}
        onPointerUp={handleStripPointerUp}
        onPointerCancel={handleStripPointerUp}
        className="no-scrollbar flex h-full min-w-0 flex-1 items-end overflow-x-auto overflow-y-hidden overscroll-x-contain px-4"
      >
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeId}
            isOnly={tabs.length === 1}
            isDragging={draggingTabId === tab.id}
            activeRef={tab.id === activeId ? activeRef : null}
            tabsStore={tabsStore}
            openContextMenu={(at, tabId) => {
              setHistoryMenu(null);
              setTabMenu({ at, tabId });
            }}
          />
        ))}
      </div>
      {slug && <NewTabButton tabsStore={tabsStore} slug={slug} />}
      <SearchButton />
      {headerTrailing}
      {tabMenu !== null && (
        <TabContextMenu
          at={tabMenu.at}
          tabId={tabMenu.tabId}
          isActive={tabMenu.tabId === activeId}
          tabsStore={tabsStore}
          onClose={() => setTabMenu(null)}
        />
      )}
      {historyMenu !== null && (
        <HistoryContextMenu
          at={historyMenu.at}
          tabsStore={tabsStore}
          onClose={() => setHistoryMenu(null)}
        />
      )}
    </div>
  );
}
