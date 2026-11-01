import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { DecisionsParams } from "./schema";

export const decisionKeys = { all: (workspaceId: string) => ["decisions", workspaceId] as const };
export function decisionsOptions(workspaceId: string, params: Omit<DecisionsParams, "cursor"> = {}) {
  return infiniteQueryOptions({
    queryKey: [...decisionKeys.all(workspaceId), params],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listDecisions(workspaceId, { ...params, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: Boolean(workspaceId),
  });
}

export function decisionDetailOptions(workspaceId: string, kind: string, sourceId: string) {
  return queryOptions({
    queryKey: [...decisionKeys.all(workspaceId), "detail", kind, sourceId],
    queryFn: () => api.getDecisionDetail(workspaceId, kind, sourceId),
    enabled: Boolean(workspaceId && kind && sourceId),
  });
}
