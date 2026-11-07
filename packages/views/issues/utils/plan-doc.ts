import type { PlanComment } from "@multica/core/issues/ask-plan";

/**
 * M-275: the pure half of the plan page, ported from the team-room Doc page
 * (`team-docs.ts` @ fefa9c3). Nothing here renders or fetches, so the anchor
 * rules — how a passage is quoted, how a quote is found again, how replies fold
 * under their root — are testable without a DOM beyond the one `quoteRange`
 * needs.
 *
 * The port is deliberate rather than an import: the team-room package is a
 * different product with its own types, and MMX reads the same behaviour off
 * its own `agent_plan_comment` rows.
 */

/** One comment thread: its root and every reply under it, in creation order. */
export interface PlanCommentThread {
  root: PlanComment;
  replies: PlanComment[];
}

/**
 * Root comments in order, each with every reply under it (replies to replies
 * included) in order.
 *
 * The parent chain is walked to its root, so a reply written against a reply
 * still lands in the same thread instead of becoming an orphan — the store has
 * no depth limit, and a UI that dropped deep replies would lose text a human
 * wrote. A comment whose parent is missing from the list (a filtered read)
 * stays a root rather than vanishing.
 */
export function commentThreads(
  comments: readonly PlanComment[],
): PlanCommentThread[] {
  const parents = new Map(
    comments.map((comment) => [comment.id, comment.parent_comment_id ?? null]),
  );
  const rootOf = (comment: PlanComment): string => {
    let current = comment.id;
    // A bounded walk: the store has no depth limit, so a crafted cycle must
    // not hang the render. 64 is far past any real thread.
    for (let depth = 0; depth < 64; depth += 1) {
      const parent = parents.get(current) ?? null;
      if (parent === null || !parents.has(parent) || parent === current) {
        return current;
      }
      current = parent;
    }
    return current;
  };
  return comments
    .filter((comment) => {
      const parent = comment.parent_comment_id ?? null;
      // A reply whose parent is not in this read stays a root rather than
      // vanishing: a filtered list must not hide someone's text.
      return parent === null || !parents.has(parent);
    })
    .map((root) => ({
      root,
      replies: comments.filter(
        (comment) =>
          (comment.parent_comment_id ?? null) !== null &&
          rootOf(comment) === root.id,
      ),
    }));
}

/**
 * The longest quote a comment keeps: enough to find the passage again, short
 * enough to read in a rail. Same limit the server enforces at the edge.
 */
export const PLAN_QUOTE_LIMIT = 280;

/** One selected passage as a comment quotes it: whitespace collapsed, capped. */
export function docQuote(selected: string): string {
  const collapsed = selected.replace(/\s+/g, " ").trim();
  return collapsed.length <= PLAN_QUOTE_LIMIT
    ? collapsed
    : `${collapsed.slice(0, PLAN_QUOTE_LIMIT - 1)}…`;
}

/**
 * The passage a comment quotes, found again in the rendered section: the first
 * match of the quote against the section's text with whitespace collapsed the
 * way `docQuote` collapsed it. A quote cut at the limit matches by its kept
 * head. Undefined when the text no longer contains it, which is what makes the
 * highlight degrade to nothing instead of painting the wrong words.
 */
export function quoteRange(container: Node, quote: string): Range | undefined {
  const needle = quote.endsWith("…") ? quote.slice(0, -1) : quote;
  if (needle === "") return undefined;
  const ownerDocument =
    container.ownerDocument ??
    (typeof document === "undefined" ? null : document);
  const walker = ownerDocument?.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  if (walker === undefined || walker === null) return undefined;
  const positions: { node: Text; offset: number }[] = [];
  let text = "";
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = (node as Text).data;
    for (let offset = 0; offset < value.length; offset += 1) {
      const space = /\s/.test(value[offset]!);
      if (space && (text === "" || text.endsWith(" "))) continue;
      text += space ? " " : value[offset]!;
      positions.push({ node: node as Text, offset });
    }
  }
  const start = text.indexOf(needle);
  if (start === -1) return undefined;
  const first = positions[start]!;
  const last = positions[start + needle.length - 1]!;
  const range = ownerDocument!.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/**
 * The CSS Custom Highlight name commented passages are painted with. The rule
 * itself lives in `packages/ui/styles/base.css`; a browser without the API
 * skips the paint and the rail still shows every quote.
 */
export const PLAN_COMMENT_HIGHLIGHT = "plan-comment";

/** Is a comment still waiting to be sent by a verdict? */
export function isPlanCommentPending(comment: PlanComment): boolean {
  return (comment.delivered_at ?? null) === null;
}

/** Is the thread resolved? A reply never resolves on its own. */
export function isPlanCommentResolved(comment: PlanComment): boolean {
  return (comment.resolved_at ?? null) !== null;
}
