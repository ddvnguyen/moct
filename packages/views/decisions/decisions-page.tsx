"use client";

import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  decisionKeys,
  decisionKey,
  decisionsOptions,
  type Decision,
} from "@multica/core/decisions";
import { useWorkspaceId } from "@multica/core/hooks";
import { Button } from "@multica/ui/components/ui/button";
import { CircleDot, Loader2, RefreshCw } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";
import { DecisionDetail } from "./decision-detail";
import { DecisionList } from "./decision-list";
import type { DecisionState } from "./decision-presentation";

export interface DecisionsPageProps {
  /**
   * The workspace's global project scope, as the page's own filter.
   *
   * Decisions follows the same picker every other surface does (M-206): `null`
   * is "All projects", which includes unprojected issues. Reading it as a prop
   * keeps this package free of the shell's scope store — the destination that
   * mounts it (M-211 slice 5) owns that wiring.
   */
  projectId?: string | null;
}

/**
 * The Decisions destination (M-202 slice 4): one place to read and answer
 * everything waiting on a human.
 *
 * The queue is the server's projection, so this page never joins sources
 * itself: it pages the pending or answered feed, groups the rows by issue, and
 * reads the selected request's own body from its source. Each answer goes back
 * through the operation that owns it — question card, plan verdict, native
 * supplement — which is why there is no second write path to keep in sync.
 *
 * A failed read is never rendered as an empty queue: the derived list is the
 * only evidence of work waiting, so the error state says so and offers a retry.
 */
export function DecisionsPage({ projectId = null }: DecisionsPageProps) {
  const { t } = useT("decisions");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [state, setState] = useState<DecisionState>("pending");
  const [selected, setSelected] = useState<string | null>(null);

  const feed = useInfiniteQuery(
    decisionsOptions(wsId, {
      state,
      ...(projectId !== null ? { project_id: projectId } : {}),
    }),
  );

  const decisions = feed.data?.pages.flatMap((page) => page.items) ?? [];
  const pendingCount = feed.data?.pages[0]?.pending_count ?? 0;
  const activeKey =
    selected !== null &&
    decisions.some((decision) => decisionKey(decision) === selected)
      ? selected
      : decisions[0] !== undefined
        ? decisionKey(decisions[0])
        : null;
  const active =
    decisions.find((decision) => decisionKey(decision) === activeKey) ?? null;

  // Every transport invalidates the source it wrote; the queue is a projection
  // of those sources, so it has to be re-read as well or a row that was just
  // answered would stay pending.
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: decisionKeys.all(wsId) });
  };

  const select = (decision: Decision): void => {
    setSelected(decisionKey(decision));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <CircleDot aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="truncate text-body font-medium">{t(($) => $.page.title)}</h1>
        <div
          role="tablist"
          aria-label={t(($) => $.page.title)}
          className="ml-2 flex items-center gap-1"
        >
          <StateTab
            active={state === "pending"}
            onClick={() => {
              setState("pending");
              setSelected(null);
            }}
            label={t(($) => $.page.pending_tab)}
            count={pendingCount}
          />
          <StateTab
            active={state === "answered"}
            onClick={() => {
              setState("answered");
              setSelected(null);
            }}
            label={t(($) => $.page.answered_tab)}
          />
        </div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="ml-auto shrink-0"
          aria-label={t(($) => $.list.retry)}
          onClick={refresh}
          disabled={feed.isFetching}
        >
          {feed.isFetching ? (
            <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-full min-w-0 shrink-0 flex-col border-r sm:w-[340px]">
          {feed.isLoading ? (
            <div className="flex flex-1 items-center justify-center px-4 py-10">
              <span className="flex items-center gap-2 text-caption text-muted-foreground">
                <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
                {t(($) => $.list.loading)}
              </span>
            </div>
          ) : feed.isError ? (
            <div role="alert" className="flex flex-1 flex-col items-center justify-center px-5 py-10 text-center">
              <p className="text-caption font-medium text-destructive">
                {t(($) => $.list.error_title)}
              </p>
              <p className="mt-1 text-caption text-muted-foreground">
                {t(($) => $.list.error_hint)}
              </p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="mt-2"
                onClick={refresh}
              >
                <RefreshCw aria-hidden="true" />
                {t(($) => $.list.retry)}
              </Button>
            </div>
          ) : decisions.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center px-5 py-10 text-center">
              <p className="text-caption font-medium text-foreground">
                {state === "pending"
                  ? t(($) => $.list.empty_pending_title)
                  : t(($) => $.list.empty_answered_title)}
              </p>
              <p className="mt-1 text-caption text-muted-foreground">
                {state === "pending"
                  ? t(($) => $.list.empty_pending_hint)
                  : t(($) => $.list.empty_answered_hint)}
              </p>
            </div>
          ) : (
            <DecisionList
              decisions={decisions}
              state={state}
              selectedKey={activeKey}
              onSelect={select}
              hasNextPage={feed.hasNextPage}
              isFetchingNextPage={feed.isFetchingNextPage}
              onLoadMore={() => void feed.fetchNextPage()}
            />
          )}
        </div>

        <div className="hidden min-h-0 min-w-0 flex-1 flex-col sm:flex">
          <DecisionDetail decision={active} state={state} onChanged={refresh} />
        </div>
      </div>
    </div>
  );
}

function StateTab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-caption transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className="font-mono text-micro tabular-nums">{count}</span>
      )}
    </button>
  );
}
