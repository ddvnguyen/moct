import { describe, expect, it } from "vitest";
import type { PlanComment } from "@multica/core/issues/ask-plan";
import {
  commentThreads,
  docQuote,
  PLAN_QUOTE_LIMIT,
  quoteRange,
} from "./plan-doc";

function comment(
  id: string,
  parent: string | null = null,
  body = id,
): PlanComment {
  return {
    id,
    plan_id: "plan-1",
    section_id: "s1",
    quote: "",
    body,
    parent_comment_id: parent,
    author_user_id: "member-1",
    created_at: "2026-11-07T10:00:00Z",
  };
}

describe("docQuote", () => {
  it("collapses whitespace and trims, so a selection copied across lines stays one quote", () => {
    expect(docQuote("  Ship\n\tz   first  ")).toBe("Ship z first");
  });

  it("caps the quote at the limit and marks the cut", () => {
    const quoted = docQuote("a".repeat(PLAN_QUOTE_LIMIT + 50));
    expect(quoted).toHaveLength(PLAN_QUOTE_LIMIT);
    expect(quoted.endsWith("…")).toBe(true);
  });

  it("leaves a quote at exactly the limit uncut", () => {
    const exact = "b".repeat(PLAN_QUOTE_LIMIT);
    expect(docQuote(exact)).toBe(exact);
  });
});

describe("commentThreads", () => {
  it("folds a reply under its root, in creation order", () => {
    const threads = commentThreads([
      comment("root"),
      comment("reply-1", "root"),
      comment("reply-2", "root"),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.root.id).toBe("root");
    expect(threads[0]!.replies.map((reply) => reply.id)).toEqual([
      "reply-1",
      "reply-2",
    ]);
  });

  it("walks a reply to a reply up to the same thread", () => {
    const threads = commentThreads([
      comment("root"),
      comment("reply", "root"),
      comment("deep", "reply"),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.replies.map((reply) => reply.id)).toEqual(["reply", "deep"]);
  });

  it("keeps a comment whose parent is missing as a root instead of dropping its text", () => {
    const threads = commentThreads([comment("orphan", "gone")]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.root.id).toBe("orphan");
  });

  it("survives a parent cycle without hanging", () => {
    const threads = commentThreads([comment("a", "b"), comment("b", "a")]);
    expect(threads).toHaveLength(0);
  });
});

describe("quoteRange", () => {
  function section(html: string): HTMLElement {
    const element = document.createElement("div");
    element.innerHTML = html;
    return element;
  }

  it("finds a passage that spans element boundaries", () => {
    const body = section("<p>Ship <strong>z</strong> first</p>");
    const range = quoteRange(body, "Ship z first");
    expect(range).toBeDefined();
    expect(range!.toString()).toBe("Ship z first");
  });

  it("matches a quote whose whitespace was collapsed on the way in", () => {
    const body = section("<p>Ship z\n   first</p>");
    const range = quoteRange(body, "Ship z first");
    expect(range).toBeDefined();
  });

  it("matches a quote cut at the limit by its kept head", () => {
    const body = section("<p>Ship z first and then some</p>");
    const range = quoteRange(body, "Ship z first…");
    expect(range).toBeDefined();
    expect(range!.toString()).toBe("Ship z first");
  });

  it("returns nothing when the text no longer holds the quote", () => {
    const body = section("<p>Ship y first</p>");
    expect(quoteRange(body, "Ship z first")).toBeUndefined();
  });

  it("returns nothing for an empty quote", () => {
    expect(quoteRange(section("<p>Ship z first</p>"), "")).toBeUndefined();
  });
});
