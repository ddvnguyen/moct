import {
  asDecisionKind,
  type Decision,
  type DecisionKind,
} from "@multica/core/decisions";

/**
 * The Decisions page's reading of the queue (M-206 slice 4).
 *
 * `GET /decisions` returns one flat, keyset-ordered stream: two requests on the
 * same issue are adjacent only when they were asked at the same moment, so the
 * page cannot assume the grouping it has to render. These helpers turn the
 * stream into that grouping and name the kinds this build can show, so the
 * list and the detail pane share one reading of a row instead of each deriving
 * it.
 */

export type DecisionState = "pending" | "answered";

/**
 * A kind label key, or null for a kind this client does not know.
 *
 * The queue is deliberately open (`DecisionSchema` types `kind` as a string) so
 * a newer server can add a source without breaking an older client. That client
 * shows the row read-only and links the issue rather than guessing a form.
 */
export function decisionKind(kind: string): DecisionKind | null {
  return asDecisionKind(kind);
}

export interface DecisionIssueGroup {
  issueId: string;
  issueTitle: string;
  decisions: Decision[];
}

/**
 * Group the flat queue by issue, keeping the server's order.
 *
 * The server orders pending requests oldest-first, so a group sits at the
 * position of its first request and its rows keep that order inside it. The
 * points of contact stay separate rows: one issue waiting on a question and a
 * plan is two decisions, and collapsing them would hide one of them behind the
 * other's form.
 */
export function groupDecisionsByIssue(
  decisions: readonly Decision[],
): DecisionIssueGroup[] {
  const groups = new Map<string, DecisionIssueGroup>();
  for (const decision of decisions) {
    const existing = groups.get(decision.issue_id);
    if (existing) {
      existing.decisions.push(decision);
      continue;
    }
    groups.set(decision.issue_id, {
      issueId: decision.issue_id,
      issueTitle: decision.issue_title,
      decisions: [decision],
    });
  }
  return [...groups.values()];
}
