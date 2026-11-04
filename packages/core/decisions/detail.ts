import {
  parseAgentQuestions,
  type AgentAnswerDraft,
  type AgentQuestion,
} from "../issues/agent-question";
import {
  cardQuestionsToAgentQuestions,
  type AgentPlan,
  type AskPlanQuestion,
  type AskPlanQuestionCard,
} from "../issues/ask-plan";

/**
 * The Decisions detail payloads (M-206 slice 4).
 *
 * `GET /decisions/{kind}/{sourceId}` returns the *source* row and nothing
 * derived: a serialized `agent_question_card`, `{plan, review}`, a task message
 * for a native ask, or the issue itself for a status-only handoff
 * (`pkg/db/queries/decisions.sql`). The endpoint deliberately does not reshape
 * those bodies — the writer already owns their shape, and a second projection
 * here is how the two would drift.
 *
 * The cost of that choice is that the payload is `Record<string, unknown>` on
 * the wire, so every reader below is written the way `parseAgentQuestions` is:
 * read what is there, ignore what is not, and return `null` when the body is
 * not the shape this kind promises. A detail that fails to parse renders as an
 * error with a retry, never as an empty decision — losing the list because one
 * body changed shape would hide work that is still waiting.
 */

/**
 * The four sources the queue projects, in the order the page describes them.
 *
 * Mirrors the `kind` values `decisions.sql` emits and `GetDecisionDetail`
 * validates; a fifth source is a server change that has to reach this list.
 */
export const DECISION_KINDS = ["question", "plan", "native", "status"] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

export function asDecisionKind(value: string): DecisionKind | null {
  return (DECISION_KINDS as readonly string[]).includes(value)
    ? (value as DecisionKind)
    : null;
}

/**
 * Whether this client can answer the source yet.
 *
 * Question and plan answers are the shipped endpoints the issue page already
 * uses, and native asks go through the running turn's supplement route — the
 * same one the transcript card uses. A status-only handoff needs the
 * `issue_decision_response` transaction (M-209), which is not on the server
 * this page ships against, so it is readable here and answerable on the issue
 * page until that card lands. Keeping the rule in one place is what makes the
 * page honest later: the day the operation merges, this list grows a kind and
 * the detail pane grows its form.
 */
export const ANSWERABLE_DECISION_KINDS: readonly DecisionKind[] = [
  "question",
  "plan",
  "native",
];

export function isDecisionAnswerable(kind: DecisionKind): boolean {
  return ANSWERABLE_DECISION_KINDS.includes(kind);
}

/** A stable identity for one request across both list states. */
export function decisionKey(decision: {
  kind: string;
  source_id: string;
}): string {
  return `${decision.kind}:${decision.source_id}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableText(value: unknown): string | null {
  const text = asText(value).trim();
  return text === "" ? null : text;
}

/** The stored question list of a durable card, as the card table writes it. */
function readCardQuestions(value: unknown): AskPlanQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: AskPlanQuestion[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const prompt = asText(record?.prompt);
    if (record === null || prompt === "") continue;
    const options = Array.isArray(record.options) ? record.options : [];
    questions.push({
      prompt,
      multiple: record.multiple === true,
      options: options.flatMap((option) => {
        const item = asRecord(option);
        const label = asText(item?.label);
        if (label === "") return [];
        const description = asText(item?.description);
        return [description === "" ? { label } : { label, description }];
      }),
    });
  }
  return questions;
}

/** One stored answer on a card, as `cardResponse` serialises it. */
function readCardAnswers(value: unknown): AgentAnswerDraft[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = asRecord(entry);
    const selected = Array.isArray(record?.selected)
      ? record.selected.filter(
          (index): index is number => typeof index === "number",
        )
      : [];
    return { selected, text: asText(record?.text).trim() };
  });
}

export interface DecisionQuestionDetail {
  card: AskPlanQuestionCard;
  /** The card's questions in the shared form's shape. */
  questions: AgentQuestion[];
  /** Present once answered; the queue's answered state reads them. */
  answers: AgentAnswerDraft[];
  answeredBy: string | null;
  answeredAt: string | null;
}

/** A durable question card, or null when the body is not one. */
export function parseDecisionQuestion(
  detail: Record<string, unknown>,
): DecisionQuestionDetail | null {
  const id = asText(detail.id);
  const issueId = asText(detail.issue_id);
  if (id === "" || issueId === "") return null;
  const card: AskPlanQuestionCard = {
    id,
    issue_id: issueId,
    task_id: asText(detail.task_id),
    agent_id: asText(detail.agent_id),
    status: asText(detail.status),
    context: asNullableText(detail.context),
    questions: readCardQuestions(detail.questions),
  };
  return {
    card,
    questions: cardQuestionsToAgentQuestions(card),
    answers: readCardAnswers(detail.answers),
    answeredBy: asNullableText(detail.answered_by),
    answeredAt: asNullableText(detail.answered_at),
  };
}

export interface DecisionPlanReview {
  id: string;
  verdict: string;
  comments: string[];
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface DecisionPlanDetail {
  plan: AgentPlan;
  /** Present once a verdict was recorded, or null while it is in review. */
  review: DecisionPlanReview | null;
}

function readPlanSections(value: unknown): AgentPlan["sections"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const record = asRecord(entry);
    if (record === null) return [];
    const heading = asText(record.heading);
    const markdown = asText(record.markdown);
    if (heading === "" && markdown === "") return [];
    return [
      {
        sectionId: asText(record.sectionId) || `section-${index + 1}`,
        heading,
        markdown,
      },
    ];
  });
}

/** `{plan, review}` from the plan detail query, or null. */
export function parseDecisionPlan(
  detail: Record<string, unknown>,
): DecisionPlanDetail | null {
  const plan = asRecord(detail.plan);
  const id = asText(plan?.id);
  const issueId = asText(plan?.issue_id);
  if (plan === null || id === "" || issueId === "") return null;
  const revision = asNumber(plan.revision) ?? 0;
  const submitted = asNumber(plan.submitted_revision);
  const review = asRecord(detail.review);
  const reviewId = asText(review?.id);
  return {
    plan: {
      id,
      issue_id: issueId,
      task_id: asText(plan.task_id),
      title: asText(plan.title),
      status: asText(plan.status),
      revision,
      ...(submitted === null ? {} : { submitted_revision: submitted }),
      sections: readPlanSections(plan.sections),
      ...(asNullableText(plan.approved_by) === null
        ? {}
        : { approved_by: asNullableText(plan.approved_by) }),
    },
    review:
      review === null || reviewId === ""
        ? null
        : {
            id: reviewId,
            verdict: asText(review.verdict),
            comments: Array.isArray(review.comments)
              ? review.comments.map((comment) => asText(comment)).filter(Boolean)
              : [],
            reviewedBy: asNullableText(review.reviewed_by),
            reviewedAt: asNullableText(review.reviewed_at),
          },
  };
}

export interface DecisionNativeDetail {
  taskId: string;
  /** The transcript row the question arrived on — the source's identity. */
  seq: number;
  questions: AgentQuestion[];
  /** The rendered question the daemon wrote alongside the structured list. */
  content: string;
  requestedAt: string | null;
}

/** `{task_id, message}` for a native ask, or null. */
export function parseDecisionNative(
  detail: Record<string, unknown>,
): DecisionNativeDetail | null {
  const taskId = asText(detail.task_id);
  const message = asRecord(detail.message);
  const seq = asNumber(message?.seq);
  if (taskId === "" || message === null || seq === null) return null;
  return {
    taskId,
    seq,
    questions: parseAgentQuestions(message.input),
    content: asText(message.content),
    requestedAt: asNullableText(message.created_at),
  };
}

export interface DecisionStatusDetail {
  issueId: string;
  title: string;
  description: string;
  revision: number;
  status: string;
}

/** The issue behind a status-only handoff, or null. */
export function parseDecisionStatus(
  detail: Record<string, unknown>,
): DecisionStatusDetail | null {
  const issueId = asText(detail.id);
  if (issueId === "") return null;
  return {
    issueId,
    title: asText(detail.title),
    description: asText(detail.description),
    revision: asNumber(detail.revision) ?? 0,
    status: asText(detail.status),
  };
}
