"use client";

import { useQuery } from "@tanstack/react-query";
import type { PlanSectionVersion } from "@multica/core/issues/ask-plan";
import { planSectionHistoryOptions } from "@multica/core/issues/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import { Button } from "@multica/ui/components/ui/button";
import { Loader2 } from "@multica/ui/icons";
import { useT, useTimeAgo } from "../../i18n";

/**
 * Every version of one plan section, newest first (M-275), ported from the
 * team-room `TeamDocHistory`.
 *
 * The ledger is the only history a plan has — MMX rewrites the whole sections
 * JSONB on every write — so this panel is what makes a human edit reviewable.
 * Restoring a version writes it again as a new version, fenced like any edit;
 * nothing is rewritten in place, so the trail stays honest.
 */
export function PlanSectionHistory({
  planId,
  sectionId,
  heading,
  revision,
  onRestore,
  restoring,
  onClose,
}: {
  planId: string;
  sectionId: string;
  heading: string;
  /** The plan revision on the page; history is re-read whenever it moves. */
  revision: number;
  /** Absent when the plan is final: an old version can be read, not restored. */
  onRestore?: (version: PlanSectionVersion) => void;
  restoring: boolean;
  onClose: () => void;
}) {
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const wsId = useWorkspaceId();
  const { data, isLoading, isError, refetch } = useQuery(
    planSectionHistoryOptions(wsId, planId, sectionId, revision),
  );
  const versions = data?.versions ?? [];

  return (
    <section
      aria-label={t(($) => $.ask_plan.history_title, { heading })}
      data-plan-section-history={sectionId}
      className="rounded-md border border-border px-3 py-2.5"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-caption font-medium text-foreground">
          {t(($) => $.ask_plan.history_title, { heading })}
        </p>
        <button
          type="button"
          aria-label={t(($) => $.ask_plan.history_close)}
          title={t(($) => $.ask_plan.history_close)}
          onClick={onClose}
          className="rounded-xs p-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          ×
        </button>
      </div>
      {isError ? (
        <div role="alert" className="mt-1">
          <p className="text-caption text-destructive">
            {t(($) => $.ask_plan.history_failed)}
          </p>
          <Button size="xs" variant="outline" className="mt-1" onClick={() => void refetch()}>
            {t(($) => $.ask_plan.history_retry)}
          </Button>
        </div>
      ) : isLoading ? (
        <p className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
          {t(($) => $.ask_plan.history_loading)}
        </p>
      ) : versions.length === 0 ? (
        <p className="mt-1 text-caption text-muted-foreground">
          {t(($) => $.ask_plan.history_empty)}
        </p>
      ) : (
        <ol className="mt-1.5 space-y-2">
          {versions.map((version, index) => (
            <li
              key={version.id}
              data-plan-version={version.revision}
              className={index === 0 ? "border-l-2 border-border pl-2" : "border-l-2 border-transparent pl-2"}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-caption font-medium text-foreground">
                  {version.writer_type === "member"
                    ? t(($) => $.ask_plan.history_writer_member)
                    : t(($) => $.ask_plan.history_writer_agent)}
                </span>
                <span className="text-caption text-muted-foreground">
                  {version.created_at === ""
                    ? t(($) => $.ask_plan.history_revision, { revision: version.revision })
                    : `${t(($) => $.ask_plan.history_revision, { revision: version.revision })} · ${timeAgo(version.created_at)}`}
                </span>
                {index === 0 && (
                  <span className="rounded-full border border-border px-1.5 text-caption text-foreground">
                    {t(($) => $.ask_plan.history_current)}
                  </span>
                )}
              </div>
              {version.heading !== heading && (
                <p className="mt-0.5 text-caption text-muted-foreground">
                  {version.heading}
                </p>
              )}
              <p className="mt-0.5 line-clamp-6 whitespace-pre-wrap text-caption text-foreground">
                {version.markdown.trim() === ""
                  ? t(($) => $.ask_plan.section_empty)
                  : version.markdown}
              </p>
              {index > 0 && onRestore !== undefined && (
                <Button
                  size="xs"
                  variant="outline"
                  className="mt-1"
                  disabled={restoring}
                  onClick={() => onRestore(version)}
                >
                  {t(($) => $.ask_plan.history_restore)}
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
