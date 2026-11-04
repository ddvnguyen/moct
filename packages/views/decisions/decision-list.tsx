"use client";

import { useRef } from "react";
import type { Decision } from "@multica/core/decisions";
import { decisionKey } from "@multica/core/decisions";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { agentListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import {
  ChevronRight,
  ClipboardList,
  Flag,
  HelpCircle,
  Loader2,
  MessageSquare,
} from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../navigation";
import { useTimeAgo, useT } from "../i18n";
import {
  decisionKind,
  groupDecisionsByIssue,
  type DecisionState,
} from "./decision-presentation";

/**
 * The Decisions list (M-211): one row per waiting request, grouped by issue.
 *
 * A row is a switch, not a link: selecting one loads it beside the list so the
 * member reads and answers without leaving the page (and without a second tab
 * per request). The issue title inside the group is the link out.
 *
 * Selection is a roving tabindex over the flat row order — Up/Down move it,
 * Home/End jump — because the visual grouping is presentational while the
 * requests themselves are one column. Screen readers hear a listbox whose group
 * headings separate the issues, which is what the grouping is for.
 */
export function DecisionList({
  decisions,
  state,
  selectedKey,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  decisions: readonly Decision[];
  state: DecisionState;
  selectedKey: string | null;
  onSelect: (decision: Decision) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useT("decisions");
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const rowNodes = useRef<Array<HTMLButtonElement | null>>([]);
  const groups = groupDecisionsByIssue(decisions);
  const flat = groups.flatMap((group) => group.decisions);

  const selectAt = (index: number): void => {
    const target = flat[index];
    if (!target) return;
    onSelect(target);
    rowNodes.current[index]?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="listbox"
        aria-label={t(($) => $.list.aria)}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
        onKeyDown={(event) => {
          const index = flat.findIndex(
            (entry) => decisionKey(entry) === selectedKey,
          );
          if (index < 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            selectAt(Math.min(flat.length - 1, index + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            selectAt(Math.max(0, index - 1));
          } else if (event.key === "Home") {
            event.preventDefault();
            selectAt(0);
          } else if (event.key === "End") {
            event.preventDefault();
            selectAt(flat.length - 1);
          }
        }}
      >
        {groups.map((group) => (
          <section key={group.issueId} className="mb-1 last:mb-0">
            <div className="px-2 pb-1 pt-2">
              <AppLink
                href={paths.issueDetail(group.issueId)}
                className="block min-w-0 truncate rounded-xs text-caption font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {group.issueTitle}
              </AppLink>
            </div>
            {group.decisions.map((decision) => {
              const key = decisionKey(decision);
              const active = key === selectedKey;
              const index = flat.findIndex((entry) => decisionKey(entry) === key);
              return (
                <button
                  key={key}
                  ref={(node) => {
                    rowNodes.current[index] = node;
                  }}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  data-decision={key}
                  onClick={() => onSelect(decision)}
                  className={cn(
                    "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <KindIcon kind={decision.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <KindLabel kind={decision.kind} />
                      <span className="shrink-0 truncate text-micro text-muted-foreground">
                        {state === "pending"
                          ? t(($) => $.row.waiting, {
                              age: timeAgo(decision.requested_at),
                            })
                          : decision.status}
                      </span>
                    </span>
                    <AgentLine decision={decision} />
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0 transition-opacity",
                      active ? "opacity-80" : "opacity-0",
                    )}
                  />
                </button>
              );
            })}
          </section>
        ))}
      </div>

      {hasNextPage && (
        <div className="shrink-0 border-t px-3 py-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={isFetchingNextPage}
            onClick={onLoadMore}
            className="w-full"
          >
            {isFetchingNextPage && (
              <Loader2
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            )}
            {isFetchingNextPage
              ? t(($) => $.list.loading)
              : t(($) => $.list.load_more)}
          </Button>
        </div>
      )}
    </div>
  );
}

function KindIcon({ kind }: { kind: string }) {
  switch (decisionKind(kind)) {
    case "question":
      return (
        <HelpCircle
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-info"
        />
      );
    case "plan":
      return (
        <ClipboardList
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-info"
        />
      );
    case "native":
      return (
        <MessageSquare
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-info"
        />
      );
    default:
      return (
        <Flag
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-warning"
        />
      );
  }
}

function KindLabel({ kind }: { kind: string }) {
  const { t } = useT("decisions");
  let label: string;
  switch (decisionKind(kind)) {
    case "question":
      label = t(($) => $.kind.question);
      break;
    case "plan":
      label = t(($) => $.kind.plan);
      break;
    case "native":
      label = t(($) => $.kind.native);
      break;
    case "status":
      label = t(($) => $.kind.status);
      break;
    default:
      label = t(($) => $.list.unknown_kind);
  }
  return (
    <span className="min-w-0 truncate text-caption font-medium">{label}</span>
  );
}

/** The asking agent, resolved from the workspace directory the app already has. */
function AgentLine({ decision }: { decision: Decision }) {
  const { t } = useT("decisions");
  const wsId = useWorkspaceId();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const agent = decision.agent_id
    ? agents.find((candidate) => candidate.id === decision.agent_id)
    : undefined;
  return (
    <span className="mt-0.5 block truncate text-micro text-muted-foreground">
      {t(($) => $.row.by_agent, {
        agent: agent?.name ?? t(($) => $.row.unknown_agent),
      })}
    </span>
  );
}
