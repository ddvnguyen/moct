// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ANSWERABLE_DECISION_KINDS,
  decisionKey,
  isDecisionAnswerable,
  parseDecisionNative,
  parseDecisionPlan,
  parseDecisionQuestion,
  parseDecisionStatus,
} from "./detail";

describe("decision detail readers", () => {
  it("reads a durable card into the shared question form", () => {
    const detail = parseDecisionQuestion({
      id: "card-1",
      issue_id: "issue-1",
      task_id: "task-1",
      agent_id: "agent-1",
      status: "open",
      context: "Picked up from the board",
      questions: [
        {
          prompt: "Which store?",
          multiple: false,
          options: [{ label: "Postgres" }, { label: "SQLite", description: "local only" }],
        },
        { prompt: "Anything else?", multiple: true, options: [] },
      ],
    });
    expect(detail?.card.context).toBe("Picked up from the board");
    expect(detail?.questions.map((question) => question.question)).toEqual([
      "Which store?",
      "Anything else?",
    ]);
    // Order is the identity on the card table, so the form's ids are synthetic
    // but stable within the card.
    expect(detail?.questions[0]?.id).toBe("card-1:1");
    expect(detail?.questions[0]?.multiSelect).toBe(false);
    expect(detail?.questions[1]?.multiSelect).toBe(true);
    expect(detail?.questions[0]?.options[1]).toEqual({
      label: "SQLite",
      description: "local only",
    });
  });

  it("keeps a card's stored answers, so the answered state can show them", () => {
    const detail = parseDecisionQuestion({
      id: "card-1",
      issue_id: "issue-1",
      status: "answered",
      questions: [{ prompt: "Which store?", multiple: false, options: [{ label: "Postgres" }] }],
      answers: [{ selected: [0], text: "  because it ships  " }],
      answered_by: "member-1",
      answered_at: "2026-11-03T10:00:00Z",
    });
    expect(detail?.answers).toEqual([{ selected: [0], text: "because it ships" }]);
    expect(detail?.answeredBy).toBe("member-1");
  });

  it("refuses a body that is not a card, rather than rendering an empty one", () => {
    expect(parseDecisionQuestion({ id: "", issue_id: "issue-1" })).toBeNull();
    expect(parseDecisionQuestion({ id: "card-1" })).toBeNull();
    expect(parseDecisionQuestion({})).toBeNull();
  });

  it("reads a submitted plan and its review fence", () => {
    const detail = parseDecisionPlan({
      plan: {
        id: "plan-1",
        issue_id: "issue-1",
        task_id: "task-1",
        title: "Ship it",
        status: "in_review",
        revision: 4,
        submitted_revision: 4,
        sections: [{ sectionId: "s1", heading: "Approach", markdown: "Do the thing." }],
      },
      review: null,
    });
    expect(detail?.plan.submitted_revision).toBe(4);
    expect(detail?.plan.sections).toHaveLength(1);
    expect(detail?.review).toBeNull();
  });

  it("reads a recorded verdict", () => {
    const detail = parseDecisionPlan({
      plan: { id: "plan-1", issue_id: "issue-1", title: "Ship it", status: "approved", revision: 3, submitted_revision: 3 },
      review: {
        id: "review-1",
        verdict: "changes_requested",
        comments: ["Needs a rollback"],
        reviewed_by: "member-1",
        reviewed_at: "2026-11-03T10:00:00Z",
      },
    });
    expect(detail?.review).toEqual({
      id: "review-1",
      verdict: "changes_requested",
      comments: ["Needs a rollback"],
      reviewedBy: "member-1",
      reviewedAt: "2026-11-03T10:00:00Z",
    });
  });

  it("reads a native ask off its transcript row", () => {
    const detail = parseDecisionNative({
      task_id: "task-1",
      message: {
        seq: 7,
        content: "Which branch?",
        created_at: "2026-11-03T10:00:00Z",
        input: { questions: [{ id: "q1", question: "Which branch?", options: [{ label: "main" }] }] },
      },
    });
    expect(detail?.taskId).toBe("task-1");
    expect(detail?.seq).toBe(7);
    expect(detail?.questions[0]?.question).toBe("Which branch?");
    expect(detail?.content).toBe("Which branch?");
  });

  it("reads a status-only handoff as the issue it stands on", () => {
    const detail = parseDecisionStatus({
      id: "issue-1",
      title: "Migrate the store",
      description: "Plan is attached to the thread.",
      revision: 12,
      status: "wait_for_decision",
    });
    expect(detail).toEqual({
      issueId: "issue-1",
      title: "Migrate the store",
      description: "Plan is attached to the thread.",
      revision: 12,
      status: "wait_for_decision",
      response: null,
    });
    expect(parseDecisionStatus({ id: "" })).toBeNull();
  });

  it("reads the verdict recorded on an answered handoff", () => {
    const detail = parseDecisionStatus({
      id: "issue-1",
      title: "Migrate the store",
      description: "Plan is attached to the thread.",
      revision: 13,
      status: "in_progress",
      response: {
        id: "receipt-1",
        issue_id: "issue-1",
        actor_id: "member-1",
        decision: "Approve",
        rationale: "Reviewed the plan",
        next_status: "in_progress",
        requested_at: "2026-11-03T09:00:00Z",
        created_at: "2026-11-03T10:00:00Z",
      },
    });
    expect(detail?.response).toEqual({
      decision: "Approve",
      rationale: "Reviewed the plan",
      actorId: "member-1",
      recordedAt: "2026-11-03T10:00:00Z",
    });
    // A join that found no receipt is a handoff still waiting, not a verdict
    // with every field missing.
    expect(
      parseDecisionStatus({ id: "issue-1", status: "wait_for_decision", response: null })
        ?.response,
    ).toBeNull();
  });

  it("answers the three shipped sources and leaves the handoff read-only", () => {
    // The status answer operation is M-209; until it lands the page must not
    // offer a form the server would 404.
    expect(ANSWERABLE_DECISION_KINDS).toEqual(["question", "plan", "native"]);
    expect(isDecisionAnswerable("status")).toBe(false);
  });

  it("keys a request by kind and source", () => {
    expect(decisionKey({ kind: "native", source_id: "task-1:7" })).toBe("native:task-1:7");
  });
});
