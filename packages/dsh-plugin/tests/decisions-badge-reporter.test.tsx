import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDecisionPendingCount, setDecisionPendingCount } from "../src/client/decisions-badge-store";
import { DecisionsBadgeReporter } from "../src/client/decisions-badge-reporter";

const queryMock = vi.hoisted(() => ({ options: vi.fn() }));

vi.mock("../src/fork", () => ({
  decisionsOptions: (workspaceId: string, params: Record<string, unknown>) => {
    queryMock.options(workspaceId, params);
    return {
      queryKey: ["decisions", workspaceId, params],
      initialPageParam: undefined,
      queryFn: async () => ({ items: [], pending_count: 7, next_cursor: null }),
      getNextPageParam: () => undefined,
    };
  },
}));

describe("DecisionsBadgeReporter", () => {
  beforeEach(() => {
    queryMock.options.mockClear();
    setDecisionPendingCount(0);
  });

  it("publishes the authoritative count for the workspace-wide project scope", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DecisionsBadgeReporter workspaceId="workspace-1" projectId="project-9" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getDecisionPendingCount()).toBe(7));
    expect(queryMock.options).toHaveBeenCalledWith("workspace-1", {
      state: "pending",
      project_id: "project-9",
    });
  });

  it("uses the unfiltered feed for All projects", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DecisionsBadgeReporter workspaceId="workspace-1" projectId={null} />
      </QueryClientProvider>,
    );

    expect(queryMock.options).toHaveBeenCalledWith("workspace-1", { state: "pending" });
  });
});
