import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { decisionsOptions } from "../fork";
import { setDecisionPendingCount } from "./decisions-badge-store";

/** Publishes the scoped authoritative pending count to the host rail badge. */
export function DecisionsBadgeReporter({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string | null;
}): null {
  const { data } = useInfiniteQuery(
    decisionsOptions(workspaceId, {
      state: "pending",
      ...(projectId === null ? {} : { project_id: projectId }),
    }),
  );

  useEffect(() => {
    setDecisionPendingCount(data?.pages[0]?.pending_count ?? 0);
  }, [data, projectId]);

  return null;
}
