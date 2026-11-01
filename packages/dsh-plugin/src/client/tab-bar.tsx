import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { TabsState } from "./tabs";
import type { NavigationAdapter } from "../fork";
import { useTabPresentation, ResourceLeadingVisual } from "../fork";
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
import { tabLabel } from "./tab-label";
import { BOARD_ROUTE, islandPath } from "./navigation";

export const headerTrailing = <div data-header-trailing="" />;

export function HeaderTrailing() {
  return <div data-header-trailing="" />;
}

function TabItem({
  tab,
  isActive,
  isOnly,
  activeRef,
  tabsStore,
}: {
  tab: { id: string; url: string; pinned?: boolean };
  isActive: boolean;
  isOnly: boolean;
  activeRef: React.RefObject<HTMLButtonElement | null> | null;
  tabsStore: StoreApi<TabsState>;
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
        onClick={() => tabsStore.getState().focusTab(tab.id)}
        onAuxClick={(e) => {
          if (e.button === 1 && showCloseButton) {
            e.preventDefault();
            tabsStore.getState().closeTab(tab.id);
          }
        }}
        className={cn(
          "group relative flex size-full min-w-0 items-center gap-1.5 px-2.5 pb-1 text-caption transition-colors select-none cursor-default",
          isActive
            ? "font-medium text-foreground"
            : "text-muted-foreground hover:text-sidebar-accent-foreground",
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
  // One history for the whole window (M-197): Back and Forward cross tabs, so
  // whether they have somewhere to go is the store's answer, not the active
  // tab's own stack.
  const canGoBack = navigation.canGoBack?.() ?? false;
  const canGoForward = state.canGoForward();

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
        className={navButtonClassName}
      >
        <ArrowLeft className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Forward"
        disabled={!canGoForward}
        onClick={() => navigation.forward?.()}
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
        className="no-scrollbar flex h-full min-w-0 flex-1 items-end overflow-x-auto overflow-y-hidden overscroll-x-contain px-4"
      >
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeId}
            isOnly={tabs.length === 1}
            activeRef={tab.id === activeId ? activeRef : null}
            tabsStore={tabsStore}
          />
        ))}
      </div>
      {slug && <NewTabButton tabsStore={tabsStore} slug={slug} />}
      <SearchButton />
      {headerTrailing}
    </div>
  );
}
