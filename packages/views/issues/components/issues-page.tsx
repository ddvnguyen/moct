"use client";

import { ListTodo } from "@multica/ui/icons";
import type {
  Issue,
  IssueTableFacetSpec,
  IssueTableFacetsResponse,
  WorkingAgentSummary,
} from "@multica/core/types";
import { useIssuesScope } from "@multica/core/issues/stores/issues-scope-store";
import { useViewStore } from "@multica/core/issues/stores/view-store-context";
import { PageHeader } from "../../layout/page-header";
import { usePageChrome, usePageScope } from "../../layout/page-chrome";
import { RefreshablePageIcon } from "../../layout/refreshable-page-icon";
import { useT } from "../../i18n";
import { IssueSurface } from "../surface/issue-surface";
import { IssuesHeader } from "./issues-header";

function IssuesSurfaceHeader({
  issues,
  workingAgents,
  isRefreshing,
  facetCountsExact,
  tableFacetCounts,
  onTableFacetChange,
}: {
  issues: Issue[];
  workingAgents: WorkingAgentSummary[] | undefined;
  isRefreshing: boolean;
  facetCountsExact: boolean;
  tableFacetCounts?: IssueTableFacetsResponse;
  onTableFacetChange: (facet: IssueTableFacetSpec | null) => void;
}) {
  const { t } = useT("issues");
  const { titleInHostChrome } = usePageChrome();
  const dateFilter = useViewStore((s) => s.dateFilter);
  const setDateFilter = useViewStore((s) => s.setDateFilter);

  return (
    <>
      {titleInHostChrome ? null : (
        <PageHeader>
          <RefreshablePageIcon refreshing={isRefreshing}>
            <ListTodo className="size-4" />
          </RefreshablePageIcon>
          <h1 className="text-body font-medium">{t(($) => $.page.breadcrumb_title)}</h1>
        </PageHeader>
      )}
      <IssuesHeader
        scopedIssues={issues}
        workingAgents={workingAgents}
        dateFilter={dateFilter}
        onDateFilterChange={setDateFilter}
        facetCountsExact={facetCountsExact}
        tableFacetCounts={tableFacetCounts}
        onTableFacetChange={onTableFacetChange}
      />
    </>
  );
}

export function IssuesPage() {
  const { t } = useT("issues");
  const scope = useIssuesScope("issues");
  // A host that owns a global project filter (the dsh island header) narrows
  // the board through the project scope the fork already supports, so the
  // server-side query, the facets and the new-issue default all agree with it.
  const { projectId } = usePageScope();

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <IssueSurface
        scope={
          projectId === null
            ? { type: "workspace", actorKind: scope }
            : { type: "project", projectId, actorKind: scope }
        }
        modes={["board", "list", "table", "swimlane"]}
        batchToolbar="list"
        createDefaults={
          projectId === null ? undefined : { project_id: projectId }
        }
        renderHeader={({ controller }) => (
          <IssuesSurfaceHeader
            issues={controller.surfaceIssues}
            workingAgents={controller.workingAgents}
            isRefreshing={controller.isRefreshing}
            facetCountsExact={controller.facetCountsExact}
            tableFacetCounts={controller.tableFacetCounts}
            onTableFacetChange={controller.setActiveTableFacet}
          />
        )}
        renderEmpty={() => (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-2 text-muted-foreground">
            <ListTodo className="h-10 w-10 text-faint-foreground" />
            <p className="text-body">{t(($) => $.page.empty_title)}</p>
          </div>
        )}
      />
    </div>
  );
}
