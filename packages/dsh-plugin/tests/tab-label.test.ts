// @vitest-environment node
import { describe, expect, it } from "vitest";
import { tabLabel } from "../src/client/tab-label";

describe("tab strip names (M-197)", () => {
  it("names an issue tab by its identifier and keeps the title in the tooltip", () => {
    expect(tabLabel("/demo/issues/M-123", "M-123: Fix the rail row")).toEqual({
      name: "M-123",
      tooltip: "M-123: Fix the rail row",
    });
  });

  it("falls back to the segment in the URL until the issue is loaded", () => {
    // A board card links the UUID; the route replaces it with the identifier
    // once the issue resolves, and the name settles then.
    expect(
      tabLabel(
        "/demo/issues/11111111-1111-4111-8111-111111111111",
        "Issue",
      ),
    ).toEqual({
      name: "11111111-1111-4111-8111-111111111111",
      tooltip: "Issue",
    });
  });

  it("keeps the strip's own name on every other tab", () => {
    for (const [url, title] of [
      ["/demo/issues", "Issues"],
      ["/demo/agents", "Agents"],
      ["/demo/agents/agent-7", "Reviewer"],
      ["/demo/skills/skill-3", "Triage"],
      ["/demo/inbox?issue=MUL-1", "Inbox"],
      ["/demo/chat?session=abc", "Session"],
      ["/demo/settings?tab=moct-memory", "Settings"],
    ] as const) {
      expect(tabLabel(url, title)).toEqual({ name: title });
    }
  });
});
