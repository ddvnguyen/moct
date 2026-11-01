import { useEffect, useRef } from "react";
import type * as React from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { TabsState } from "./tabs";
import type { NavigationAdapter } from "../fork";
import { useTabPresentation, ResourceLeadingVisual } from "../fork";
import { tabLabel } from "./tab-label";

export const headerTrailing = <div data-header-trailing="" />;

export function HeaderTrailing() {
  return <div data-header-trailing="" />;
}



function TabItem({
  tab,
  isActive,
  activeRef,
  tabsStore,
}: {
  tab: { id: string; url: string };
  isActive: boolean;
  activeRef: React.RefObject<HTMLButtonElement | null> | null;
  tabsStore: StoreApi<TabsState>;
}) {
  const presentation = useTabPresentation(tab.url);
  // An issue reads as `M-123` with its title in the tooltip; every other tab
  // keeps the fork's own name and needs no tooltip (M-197).
  const label = tabLabel(tab.url, presentation.title);
  return (
    <button
      ref={isActive ? activeRef : undefined}
      type="button"
      title={label.tooltip}
      // The strip's selected tab, marked for the shell's own readers and for
      // the tests that walk it: the label alone cannot say which page shows.
      data-active={isActive || undefined}
      onClick={() => tabsStore.getState().focusTab(tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          tabsStore.getState().closeTab(tab.id);
        }
      }}
      className={`flex items-center gap-1 rounded px-2 py-1 text-sm ${
        isActive ? "bg-accent" : ""
      }`}
    >
      <ResourceLeadingVisual visual={presentation.visual} />
      <span className="truncate">{label.name}</span>
      <span
        role="button"
        aria-label="Close"
        onClick={(e) => {
          e.stopPropagation();
          tabsStore.getState().closeTab(tab.id);
        }}
      >
        ×
      </span>
    </button>
  );
}

export function TabBar({
  tabsStore,
  navigation,
  projectPicker,
}: {
  tabsStore: StoreApi<TabsState>;
  navigation: NavigationAdapter;
  /** Host-owned project filter rendered between back/forward and the strip. */
  projectPicker?: React.ReactNode;
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
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2"
    >
      <button
        type="button"
        aria-label="Back"
        disabled={!canGoBack}
        onClick={() => navigation.back()}
        className="rounded px-1 text-sm disabled:opacity-40"
      >
        ‹
      </button>
      <button
        type="button"
        aria-label="Forward"
        disabled={!canGoForward}
        onClick={() => navigation.forward?.()}
        className="rounded px-1 text-sm disabled:opacity-40"
      >
        ›
      </button>
      {projectPicker}
      {/* `data-tab-strip` is the strip's own address: the tests walk it, and
          nothing in the shell depends on the class names. */}
      <div
        ref={stripRef}
        data-tab-strip=""
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeId}
            activeRef={tab.id === activeId ? activeRef : null}
            tabsStore={tabsStore}
          />
        ))}
      </div>
      {headerTrailing}
    </div>
  );
}
