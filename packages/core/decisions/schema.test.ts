// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DecisionsPageSchema } from "./schema";

describe("DecisionsPageSchema", () => {
  it("accepts an unknown source kind for read-only display", () => {
    const page = { items: [{ kind: "future", source_id: "x", issue_id: "i", issue_title: "Issue", project_id: null, issue_revision: 1, agent_id: null, task_id: null, question_seq: null, sort_at: "2026-01-01T00:00:00Z", requested_at: "2026-01-01T00:00:00Z", status: "open", actor_id: null, response_id: null }], pending_count: 1, next_cursor: null };
    expect(DecisionsPageSchema.safeParse(page).success).toBe(true);
  });
  it("rejects a malformed queue instead of displaying it as empty", () => {
    expect(DecisionsPageSchema.safeParse({ items: "broken", pending_count: 0, next_cursor: null }).success).toBe(false);
  });
});
