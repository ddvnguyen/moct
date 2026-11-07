import type { AgentAnswerDraft, AgentQuestion } from "./agent-question";

/**
 * S1-A1 (M-118) ask/plan — the island's side of a parked exchange.
 *
 * The server owns the durable shape: `agent_question_card`, `agent_plan` and
 * `agent_plan_review` (migrations 585-587) plus the single island read
 * `GET /issues/{id}/ask-plan`. This module is the client's reading of that
 * response and the two pure mappings the panel needs — card questions into the
 * shared question form, and the form's drafts back into the wire's answer
 * list. Nothing here fetches or renders.
 *
 * Why this is separate from `agent-question.ts`: that module reads an ask off
 * a **transcript row** (`input.questions`, M-109) and answers it through a
 * task supplement; this one reads the **card table** and answers it through
 * `/question-cards/{id}/answer`. Same exchange, two persisted sources.
 */

/** One open question card, as `cardResponse` serialises it. */
export interface AskPlanQuestionCard {
  id: string;
  issue_id: string;
  task_id: string;
  agent_id: string;
  /** `open` on every card this read returns; the query filters on it. */
  status: string;
  context?: string | null;
  /** `[{prompt, multiple, options:[{label, description}]}]`, 1-6 entries. */
  questions: AskPlanQuestion[];
  /** Present only once answered, which this read never returns. */
  answers?: AgentAnswerDraft[];
}

export interface AskPlanQuestion {
  prompt: string;
  multiple: boolean;
  options: { label: string; description?: string }[];
}

/** One plan section. `sectionId` is camelCase inside an otherwise snake_case
 *  response: sections are tool-contract JSONB, written verbatim by the agent
 *  (`handler/askplan.go:308`), so their keys never went through Go's mapper. */
export interface AskPlanSection {
  sectionId: string;
  heading: string;
  markdown: string;
}

/**
 * One comment on a plan, anchored to a passage of one section (M-275).
 *
 * `section_id` is `""` for a note with no anchor and `quote` is `""` when
 * nothing was selected. `parent_comment_id` makes it a reply; `resolved_at` is
 * the human's resolve, which never rewrites the agent's text; `delivered_at` is
 * the verdict that sent it to the agent, stamped once.
 */
export interface PlanComment {
  id: string;
  plan_id: string;
  section_id: string;
  quote: string;
  body: string;
  parent_comment_id?: string | null;
  author_user_id: string;
  resolved_at?: string | null;
  resolved_by?: string | null;
  delivered_at?: string | null;
  delivered_verdict?: string | null;
  created_at: string;
}

/** One accepted write to a plan section, newest first in the history read. */
export interface PlanSectionVersion {
  id: string;
  section_id: string;
  revision: number;
  heading: string;
  markdown: string;
  /** `agent | member` — whoever's write produced this version. */
  writer_type: string;
  writer_id?: string | null;
  created_at: string;
}

/** The plan currently open on an issue. `status` is the 586 CHECK constraint. */
export interface AgentPlan {
  id: string;
  issue_id: string;
  task_id: string;
  title: string;
  /** `draft | in_review | changes_requested | approved | cancelled`. */
  status: string;
  revision: number;
  /** The revision under review — the fence every verdict must repeat. */
  submitted_revision?: number;
  sections: AskPlanSection[];
  approved_by?: string | null;
  /** The plan page's passage comments, oldest first (M-275). */
  comments?: PlanComment[];
}

/** A comment as the plan page writes it. `base_revision` fences the anchor. */
export interface PlanCommentBody {
  base_revision: number;
  section_id: string;
  quote: string;
  body: string;
  parent_comment_id?: string;
}

/** A human's edit of one section; `base_revision` fences the write. */
export interface PlanSectionWriteBody {
  base_revision: number;
  heading: string;
  markdown: string;
}

/**
 * The island's read: open cards plus the one open plan, either absent.
 *
 * `status` is deliberately `string` rather than a union of the five known
 * values. The panel's default on an unrecognised status is "show it read-only
 * and offer no verdict"; typing it as a union would turn a future server value
 * into a parse failure that blanks the whole panel instead.
 */
export interface IssueAskPlan {
  question_cards: AskPlanQuestionCard[];
  plan?: AgentPlan | null;
}

export const EMPTY_ISSUE_ASK_PLAN: IssueAskPlan = { question_cards: [] };

/**
 * The fallback a section write parses into when its response is unreadable.
 *
 * A failed plan write is already a failed request — an `ApiError` — so this
 * value only has to keep `parseWithFallback`'s types honest, never to be
 * rendered as a plan. The caller re-reads the plan on success anyway.
 */
export const EMPTY_AGENT_PLAN: AgentPlan = {
  id: "",
  issue_id: "",
  task_id: "",
  title: "",
  status: "",
  revision: 0,
  sections: [],
  comments: [],
};

/** The verdicts `POST /plans/{planId}/verdict` accepts, in panel order. */
export type PlanVerdict = "approve" | "changes_requested" | "cancel";

export interface PlanVerdictBody {
  /** Must equal the plan's `submitted_revision`, or the server answers 409. */
  revision: number;
  verdict: PlanVerdict;
  /** `changes_requested` needs at least one comment or a non-empty note. */
  comments: string[];
  note: string;
}

/** True when a verdict can be recorded against this plan right now. */
export function isPlanVerdictable(plan: AgentPlan | null | undefined): boolean {
  return (
    plan !== null &&
    plan !== undefined &&
    plan.status === "in_review" &&
    typeof plan.submitted_revision === "number"
  );
}

/** Is there anything on this issue for the panel to render? */
export function hasAskPlanState(state: IssueAskPlan | undefined | null): boolean {
  if (state === undefined || state === null) return false;
  if (state.question_cards.length > 0) return true;
  return state.plan !== null && state.plan !== undefined;
}

/**
 * The card's stored questions as the shared question form reads them.
 *
 * The card table has no per-question id — order is the identity, and the
 * server answers in question order (`validateCardAnswers`) — so the index
 * becomes a synthetic one. It only has to be stable within one card: the form
 * uses it as the React key and as the radio group name.
 */
export function cardQuestionsToAgentQuestions(
  card: AskPlanQuestionCard,
): AgentQuestion[] {
  return card.questions.map((question, index) => ({
    id: `${card.id}:${index + 1}`,
    question: question.prompt,
    options: question.options.map((option) =>
      option.description === undefined || option.description === ""
        ? { label: option.label }
        : { label: option.label, description: option.description },
    ),
    multiSelect: question.multiple === true,
  }));
}

/**
 * The form's drafts as the answer endpoint expects them: one entry per
 * question, in question order, selection sorted so the stored answer is
 * deterministic. Whitespace-only text is trimmed to `""` so the server's
 * "needs a selected option or an answer text" rule and the form's own
 * readiness check agree on what an unanswered question is.
 */
export function draftsToCardAnswers(
  drafts: readonly AgentAnswerDraft[],
): AgentAnswerDraft[] {
  return drafts.map((draft) => ({
    selected: [...draft.selected].sort((left, right) => left - right),
    text: draft.text.trim(),
  }));
}

/** A verdict payload from the panel's state. `revision` comes from the plan. */
export function planVerdictBody(
  plan: AgentPlan,
  verdict: PlanVerdict,
  comments: readonly string[],
): PlanVerdictBody {
  return {
    revision: plan.submitted_revision ?? plan.revision,
    verdict,
    comments: [...comments],
    note: "",
  };
}
