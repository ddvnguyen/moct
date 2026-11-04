import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { decisionKeys } from "./queries";
import { useWorkspaceId } from "../hooks";
import { issueKeys } from "../issues/queries";

export function useRespondDecision() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (input: { issueId: string; client_request_id: string; expected_issue_revision: number; decision: string; rationale?: string; next_status: string }) =>
      api.respondDecision(input.issueId, {
        client_request_id: input.client_request_id,
        expected_issue_revision: input.expected_issue_revision,
        decision: input.decision,
        rationale: input.rationale,
        next_status: input.next_status,
      }),
    onSettled: (_data, _error, input) => {
      void qc.invalidateQueries({ queryKey: decisionKeys.all(wsId) });
      void qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
      void qc.invalidateQueries({ queryKey: issueKeys.timeline(input.issueId) });
    },
  });
}
