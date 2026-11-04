/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { issueKeys } from "../issues/queries";
import { decisionKeys } from "./queries";
import { useRespondDecision } from "./mutations";

vi.mock("../hooks", () => ({ useWorkspaceId: () => "ws-1" }));

it("submits the answer and invalidates decisions, issue data and its timeline", async () => {
  const qc = new QueryClient();
  const keys = [decisionKeys.all("ws-1"), issueKeys.detail("ws-1", "issue-1"), issueKeys.list("ws-1"), issueKeys.timeline("issue-1")];
  for (const key of keys) qc.setQueryData(key, {});
  const respondDecision = vi.fn().mockResolvedValue({ id: "receipt" });
  setApiInstance({ respondDecision } as unknown as ApiClient);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useRespondDecision(), { wrapper });
  await act(async () => { await result.current.mutateAsync({ issueId: "issue-1", client_request_id: "request", expected_issue_revision: 3, decision: "Approve", next_status: "in_progress" }); });
  expect(respondDecision).toHaveBeenCalledWith("issue-1", expect.objectContaining({ client_request_id: "request", expected_issue_revision: 3 }));
  for (const key of keys) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  qc.clear();
});

it("invalidates stale data after a failed response", async () => {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const keys = [decisionKeys.all("ws-1"), issueKeys.detail("ws-1", "issue-1"), issueKeys.timeline("issue-1")];
  for (const key of keys) qc.setQueryData(key, {});
  setApiInstance({ respondDecision: vi.fn().mockRejectedValue(new Error("conflict")) } as unknown as ApiClient);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useRespondDecision(), { wrapper });
  await act(async () => {
    await expect(result.current.mutateAsync({ issueId: "issue-1", client_request_id: "request", expected_issue_revision: 3, decision: "Approve", next_status: "in_progress" })).rejects.toThrow("conflict");
  });
  for (const key of keys) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  qc.clear();
});
