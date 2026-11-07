"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useAnswerQuestionCard } from "@multica/core/issues/mutations";
import type { AgentAnswerDraft } from "@multica/core/issues/agent-question";
import { issueAskPlanOptions } from "@multica/core/issues/queries";
import {
  cardQuestionsToAgentQuestions,
  draftsToCardAnswers,
  hasAskPlanState,
  type AskPlanQuestionCard,
} from "@multica/core/issues/ask-plan";
import { AgentQuestionCard } from "./agent-question-card";
import { PlanReviewPanel } from "./plan-review-panel";

/**
 * The issue's open ask/plan state, rendered where the member already reads
 * the issue (M-120, extended by M-275).
 *
 * S1-A1 parks a run on a question card or a submitted plan, and neither state
 * has a transcript row of its own — the card and the plan are their own tables
 * — so nothing on the timeline can show them. This panel is that surface: it
 * reads `GET /issues/{id}/ask-plan` once and renders whatever is open.
 *
 * It sits above the Activity section on the issue page, which is also the
 * Inbox detail pane (the pane renders `IssueDetail`), so both entry points —
 * board and inbox notification — land on the same card. Epically that is the
 * rule the S1-G mapping already set: the card is the fork's issue timeline,
 * not a new surface.
 */
export function AskPlanPanel({ issueId }: { issueId: string }) {
  const wsId = useWorkspaceId();
  const { data } = useQuery(issueAskPlanOptions(wsId, issueId));
  const answer = useAnswerQuestionCard(issueId);

  // Reading `undefined` (still loading) and the empty state the same way keeps
  // the panel out of the DOM until there is something to act on.
  if (!hasAskPlanState(data)) return null;

  const cards = data?.question_cards ?? [];
  const plan = data?.plan ?? null;

  return (
    <div className="space-y-4" data-testid="ask-plan-panel">
      {cards.map((card) => (
        <AskPlanQuestionForm
          key={card.id}
          card={card}
          onAnswer={(variables) => answer.mutateAsync(variables)}
        />
      ))}
      {plan !== null && <PlanReviewPanel key={plan.id} plan={plan} issueId={issueId} />}
    </div>
  );
}

/**
 * One open question card, through the shared form.
 *
 * `onAnswer` is the mutation itself so a failure rejects: the card awaits it,
 * marks its own error with the server's message, and the mutation's `onSuccess`
 * is what drops the card from the panel by invalidating the ask-plan read.
 *
 * Exported because the Decisions page (M-211) answers the same card from a
 * different surface — the form, its readiness rule and its error handling are
 * the card table's contract, not the issue page's.
 */
export function AskPlanQuestionForm({
  card,
  onAnswer,
}: {
  card: AskPlanQuestionCard;
  onAnswer: (variables: {
    cardId: string;
    answers: readonly AgentAnswerDraft[];
  }) => Promise<unknown>;
}) {
  const questions = cardQuestionsToAgentQuestions(card);

  return (
    <div>
      {card.context !== null && card.context !== undefined && card.context !== "" && (
        <p className="mb-1 text-caption text-muted-foreground">{card.context}</p>
      )}
      <AgentQuestionCard
        issueId={card.issue_id}
        taskId={card.task_id}
        questions={questions}
        submit={async (drafts) => {
          await onAnswer({ cardId: card.id, answers: draftsToCardAnswers(drafts) });
        }}
      />
    </div>
  );
}
