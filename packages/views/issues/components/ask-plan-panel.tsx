"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useAnswerQuestionCard, useReviewPlan } from "@multica/core/issues/mutations";
import type { AgentAnswerDraft } from "@multica/core/issues/agent-question";
import { issueAskPlanOptions } from "@multica/core/issues/queries";
import {
  cardQuestionsToAgentQuestions,
  draftsToCardAnswers,
  hasAskPlanState,
  isPlanVerdictable,
  planVerdictBody,
  type AgentPlan,
  type AskPlanQuestionCard,
  type PlanVerdict,
} from "@multica/core/issues/ask-plan";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { ClipboardList, Loader2, Plus, X } from "@multica/ui/icons";
import { ReadonlyContent } from "../../editor";
import { useT } from "../../i18n";
import { AgentQuestionCard } from "./agent-question-card";

/**
 * The issue's open ask/plan state, rendered where the member already reads
 * the issue (M-120).
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
      {plan !== null && <PlanVerdictForm key={plan.id} plan={plan} issueId={issueId} />}
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

/**
 * The open plan: sections to read, comments to write, three verdicts.
 *
 * Verdicts are offered only while the plan is `in_review` — a `draft` or a
 * `changes_requested` plan is the agent's to revise, and posting a verdict at
 * those points is refused server-side with a 409. Showing them read-only with
 * no buttons is the honest rendering of that, and it is also the safe default
 * for a status this client does not recognise.
 *
 * `onRecorded` and `onRejected` let a second surface (the Decisions page,
 * M-211) refresh its own reads when a verdict lands or when the plan moved
 * under it; the panel passes neither, because its mutation already invalidates
 * the ask-plan query it renders from.
 */
export function PlanVerdictForm({
  plan,
  issueId,
  onRecorded,
  onRejected,
}: {
  plan: AgentPlan;
  issueId: string;
  onRecorded?: () => void;
  onRejected?: () => void;
}) {
  const { t } = useT("issues");
  const review = useReviewPlan(issueId);
  const [comments, setComments] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Cancelling frees the issue for a new plan and is not undoable, so the
  // button has to be pressed twice — armed, then taken.
  const [cancelArmed, setCancelArmed] = useState(false);

  const verdictable = isPlanVerdictable(plan);
  const busy = review.isPending;

  const addComment = (): void => {
    const text = draft.trim();
    if (text === "") return;
    setComments((current) => [...current, text]);
    setDraft("");
  };

  const removeComment = (index: number): void => {
    setComments((current) => current.filter((_, at) => at !== index));
  };

  const record = (verdict: PlanVerdict): void => {
    if (busy) return;
    setError(null);
    setCancelArmed(false);
    review.mutate(
      { planId: plan.id, verdict: planVerdictBody(plan, verdict, comments) },
      {
        onSuccess: () => onRecorded?.(),
        onError: (cause) => {
          // A 409 here means the plan moved under us — closed, superseded or
          // on another revision — so re-read as well as reporting, which is
          // what puts the current state back in front of the member.
          onRejected?.();
          setError(
            cause instanceof Error && cause.message !== ""
              ? cause.message
              : t(($) => $.ask_plan.failed),
          );
        },
      },
    );
  };

  return (
    <section
      aria-label={plan.title}
      data-agent-plan={plan.status}
      className="rounded-md border border-border bg-muted/40 px-3 py-2.5"
    >
      <p className="flex items-center gap-1.5 text-caption font-medium text-foreground">
        <ClipboardList aria-hidden className="size-3.5 shrink-0 text-info" />
        {plan.title}
      </p>

      {plan.sections.length > 0 && (
        <div className="mt-2 space-y-3">
          {plan.sections.map((section, index) => (
            <div key={`${index}:${section.sectionId}`}>
              <p className="text-body text-foreground">{section.heading}</p>
              {section.markdown.trim() === "" ? (
                <p className="mt-0.5 text-caption text-muted-foreground">
                  {t(($) => $.ask_plan.section_empty)}
                </p>
              ) : (
                <div className="mt-0.5 text-body">
                  <ReadonlyContent content={section.markdown} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!verdictable ? (
        <p className="mt-2.5 text-caption text-muted-foreground">
          {plan.status === "changes_requested"
            ? t(($) => $.ask_plan.plan_changes_requested)
            : t(($) => $.ask_plan.plan_draft)}
        </p>
      ) : (
        <>
          <p className="mt-3 text-caption font-medium text-foreground">
            {t(($) => $.ask_plan.comments_heading)}
          </p>
          {comments.length === 0 ? (
            <p className="mt-0.5 text-caption text-muted-foreground">
              {t(($) => $.ask_plan.comments_empty)}
            </p>
          ) : (
            <ul className="mt-1 space-y-1">
              {comments.map((comment, index) => (
                <li
                  key={`${index}:${comment}`}
                  className="flex items-start gap-1.5 rounded-xs bg-background/70 px-2 py-1.5 text-caption"
                >
                  <span className="min-w-0 flex-1 whitespace-pre-wrap text-foreground">{comment}</span>
                  <button
                    type="button"
                    aria-label={t(($) => $.ask_plan.remove_comment)}
                    onClick={() => removeComment(index)}
                    className="shrink-0 rounded-xs p-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-1.5 flex items-start gap-1.5">
            <Input
              value={draft}
              maxLength={4000}
              placeholder={t(($) => $.ask_plan.comment_placeholder)}
              aria-label={t(($) => $.ask_plan.comment_placeholder)}
              className="h-8 text-caption"
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                addComment();
              }}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={draft.trim() === ""}
              onClick={addComment}
            >
              <Plus aria-hidden className="size-3.5" />
              {t(($) => $.ask_plan.add_comment)}
            </Button>
          </div>

          {error !== null && (
            <p role="alert" className="mt-2 text-caption text-destructive">
              {error}
            </p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (!cancelArmed) {
                  setCancelArmed(true);
                  return;
                }
                record("cancel");
              }}
            >
              {busy && review.variables?.verdict.verdict === "cancel" && (
                <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />
              )}
              {cancelArmed ? t(($) => $.ask_plan.cancel_confirm) : t(($) => $.ask_plan.cancel)}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || comments.length === 0}
              onClick={() => record("changes_requested")}
            >
              {busy && review.variables?.verdict.verdict === "changes_requested" && (
                <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />
              )}
              {t(($) => $.agent_question.request_changes)}
            </Button>
            <Button
              size="xs"
              variant="default"
              disabled={busy}
              onClick={() => record("approve")}
            >
              {busy && review.variables?.verdict.verdict === "approve" && (
                <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />
              )}
              {t(($) => $.agent_question.approve)}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
