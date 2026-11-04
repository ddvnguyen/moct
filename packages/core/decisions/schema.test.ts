// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DecisionResponseReceiptSchema, DecisionsPageSchema } from "./schema";

describe("DecisionsPageSchema", () => {
  it("accepts an unknown source kind for read-only display", () => {
    const page = { items: [{ kind: "future", source_id: "x", issue_id: "i", issue_title: "Issue", project_id: null, issue_revision: 1, agent_id: null, task_id: null, question_seq: null, sort_at: "2026-01-01T00:00:00Z", requested_at: "2026-01-01T00:00:00Z", status: "open", actor_id: null, response_id: null }], pending_count: 1, next_cursor: null };
    expect(DecisionsPageSchema.safeParse(page).success).toBe(true);
  });
  it("keeps a native answer's receipt state and retry handle", () => {
    const page = { items: [{ kind: "native", source_id: "t:2", issue_id: "i", issue_title: "Issue", project_id: null, issue_revision: 3, agent_id: "a", task_id: "t", question_seq: 2, sort_at: "2026-01-01T00:00:00Z", requested_at: "2026-01-01T00:00:00Z", status: "failed", actor_id: null, response_id: "comment-1", receipt_reason: "daemon rejected the message" }], pending_count: 1, next_cursor: null };
    const parsed = DecisionsPageSchema.parse(page);
    expect(parsed.items[0]).toMatchObject({ status: "failed", response_id: "comment-1", receipt_reason: "daemon rejected the message" });
  });
  it("rejects a malformed queue instead of displaying it as empty", () => {
    expect(DecisionsPageSchema.safeParse({ items: "broken", pending_count: 0, next_cursor: null }).success).toBe(false);
  });
});


describe("DecisionResponseReceiptSchema", () => {
  it("rejects a malformed receipt", () => {
    expect(DecisionResponseReceiptSchema.safeParse({ id: "x" }).success).toBe(false);
  });
  it("accepts a valid receipt", () => {
    const receipt = { id: "1", workspace_id: "2", issue_id: "3", client_request_id: "4", actor_id: "5", source_revision: 1, decision: "Approve", rationale: "r", next_status: "in_progress", comment_id: "6", task_id: null, created_at: "2026-01-01T00:00:00Z" };
    expect(DecisionResponseReceiptSchema.safeParse(receipt).success).toBe(true);
  });
});
