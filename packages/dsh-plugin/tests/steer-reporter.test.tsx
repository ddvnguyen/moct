import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../src/fork";
import { SteerReporter } from "../src/client/steer-reporter";
import { resetSteerStore, selectOwnedSession } from "../src/client/steer-store";

/**
 * The reporter is the only writer of the composer takeover's ownership map, and
 * it writes the workspace snapshot verbatim. So this test hands it the JSON a
 * server returns — `session_id`, `supplement_capability` and `can_supplement`
 * already on the row — and never sets those fields by hand. The Go snapshot
 * test proves the server emits them; this one proves the plugin needs nothing
 * else to take a session over. Together they close the gap the e2e harness left
 * open: it injected both fields itself, so it could not see that a live server
 * never sent them.
 */
const SERVER_PAYLOAD = `[
  {
    "id": "task-9",
    "issue_id": "issue-9",
    "agent_id": "agent-9",
    "status": "running",
    "session_id": "sess-9",
    "supplement_capability": "task-supplement-v1",
    "can_supplement": true
  },
  {
    "id": "task-10",
    "issue_id": "issue-10",
    "agent_id": "agent-9",
    "status": "running",
    "session_id": "sess-10",
    "supplement_capability": null,
    "can_supplement": false
  }
]`;

function stubSnapshot(rows: unknown[]) {
  const getAgentTaskSnapshot = vi.fn(async () => rows as AgentTask[]);
  setApiInstance({ getAgentTaskSnapshot } as unknown as ApiClient);
  return getAgentTaskSnapshot;
}

function renderReporter(workspaceId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SteerReporter workspaceId={workspaceId} />
    </QueryClientProvider>,
  );
}

describe("SteerReporter", () => {
  beforeEach(() => {
    resetSteerStore();
    vi.clearAllMocks();
  });

  it("owns the sessions a server snapshot marks steerable, and only those", async () => {
    stubSnapshot(JSON.parse(SERVER_PAYLOAD));
    renderReporter("ws-1");

    await waitFor(() =>
      expect(selectOwnedSession("sess-9")).toEqual({
        taskId: "task-9",
        issueId: "issue-9",
        agentId: "agent-9",
      }),
    );
    expect(selectOwnedSession("sess-10")).toBeNull();
  });
});
