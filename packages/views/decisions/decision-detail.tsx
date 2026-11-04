"use client";

import { useQuery } from "@tanstack/react-query";
import type { Decision } from "@multica/core/decisions";
import {
  decisionDetailOptions,
  decisionKey,
  isDecisionAnswerable,
  parseDecisionNative,
  parseDecisionPlan,
  parseDecisionQuestion,
  parseDecisionStatus,
} from "@multica/core/decisions";
import type {
  AgentAnswerDraft,
  AgentQuestion,
} from "@multica/core/issues/agent-question";
import { useAnswerQuestionCard } from "@multica/core/issues/mutations";
import {
  draftsToCardAnswers,
  type AgentPlan,
} from "@multica/core/issues/ask-plan";
import { useWorkspaceId } from "@multica/core/hooks";
import { useActorName } from "@multica/core/workspace/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Flag, Loader2, RefreshCw } from "@multica/ui/icons";
import { ReadonlyContent } from "../editor";
import { AgentQuestionCard } from "../issues/components/agent-question-card";
import { PlanVerdictForm } from "../issues/components/ask-plan-panel";
import { AppLink } from "../navigation";
import { useTimeAgo, useT } from "../i18n";
import { decisionKind, type DecisionState } from "./decision-presentation";

/**
 * The selected request, read from its own source and answered where it lives.
 *
 * Every source keeps its own write path; this pane only decides which one to
 * show. That is the whole point of the Decisions read model: a question card and
 * a plan verdict keep their issued endpoints and release fences, a native ask
 * keeps the running turn's supplement route, and only the status handoff has no
 * operation yet — it is shown with its context and a link, never a form that
 * would 404.
 *
 * Answered rows render the same bodies read-only: the stored answer, the
 * recorded verdict and its comments. That is response history, not a second
 * queue, so nothing here can be answered twice.
 */
export function DecisionDetail({
  decision,
  state,
  onChanged,
}: {
  decision: Decision | null;
  state: DecisionState;
  onChanged: () => void;
}) {
  const { t } = useT("decisions");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const kind = decision ? decisionKind(decision.kind) : null;
  const { data, isLoading, isError, refetch, isFetching } = useQuery(
    decision
      ? decisionDetailOptions(wsId, decision.kind, decision.source_id)
      : decisionDetailOptions(wsId, "", ""),
  );

  if (decision === null) {
    return (
      <CenteredState
        title={t(($) => $.list.none_selected_title)}
        hint={t(($) => $.list.none_selected_hint)}
      />
    );
  }

  const header = (
    <header className="shrink-0 border-b px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-body font-medium">
          {decision.issue_title}
        </span>
        <Badge variant="secondary" className="shrink-0">
          {kind === null
            ? t(($) => $.list.unknown_kind)
            : kind === "question"
              ? t(($) => $.kind.question)
              : kind === "plan"
                ? t(($) => $.kind.plan)
                : kind === "native"
                  ? t(($) => $.kind.native)
                  : t(($) => $.kind.status)}
        </Badge>
        {state === "answered" && (
          <Badge variant="outline" className="shrink-0">
            {decision.status}
          </Badge>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
        <span>
          {t(($) => $.detail.requested, {
            age: timeAgo(decision.requested_at),
          })}
        </span>
        <AppLink
          href={paths.issueDetail(decision.issue_id)}
          className="rounded-xs underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t(($) => $.detail.issue_link)}
        </AppLink>
      </div>
    </header>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-decision-detail={decisionKey(decision)}>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {isLoading ? (
          <div className="space-y-2" aria-busy="true">
            <span className="sr-only">{t(($) => $.detail.loading)}</span>
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-4 w-32" />
          </div>
        ) : isError || data === undefined ? (
          <div role="alert" className="rounded-md border border-destructive/40 px-3 py-3">
            <p className="text-caption font-medium text-destructive">
              {t(($) => $.detail.error_title)}
            </p>
            <p className="mt-1 text-caption text-muted-foreground">
              {t(($) => $.detail.error_hint)}
            </p>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="mt-2"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {isFetching ? (
                <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              {t(($) => $.detail.retry)}
            </Button>
          </div>
        ) : (
          <SourceBody
            decision={decision}
            state={state}
            detail={data}
            onChanged={onChanged}
          />
        )}
      </div>
    </div>
  );
}

function SourceBody({
  decision,
  state,
  detail,
  onChanged,
}: {
  decision: Decision;
  state: DecisionState;
  detail: Record<string, unknown>;
  onChanged: () => void;
}) {
  const { t } = useT("decisions");
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const actorLabel = useActorLabel();
  const issueLink = (
    <AppLink
      href={paths.issueDetail(decision.issue_id)}
      className="mt-2 inline-block rounded-xs text-caption underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {t(($) => $.detail.issue_link)}
    </AppLink>
  );

  switch (decisionKind(decision.kind)) {
    case "question": {
      const parsed = parseDecisionQuestion(detail);
      if (parsed === null) return <UnreadableSource />;
      if (state === "answered" || !isDecisionAnswerable("question")) {
        return (
          <StoredAnswers
            questions={parsed.questions.map((question) => question.question)}
            answers={parsed.answers}
            actor={actorLabel(parsed.answeredBy)}
            at={parsed.answeredAt}
            hint={t(($) => $.detail.answered_hint)}
          />
        );
      }
      return (
        <QuestionForm
          issueId={parsed.card.issue_id}
          cardId={parsed.card.id}
          context={parsed.card.context ?? null}
          questions={parsed.questions}
          onChanged={onChanged}
        />
      );
    }
    case "plan": {
      const parsed = parseDecisionPlan(detail);
      if (parsed === null) return <UnreadableSource />;
      const reviewedBy =
        parsed.review === null ? null : actorLabel(parsed.review.reviewedBy);
      if (state === "answered" || !isDecisionAnswerable("plan")) {
        return (
          <ReadOnlyPlan plan={parsed.plan}>
            {parsed.review !== null && (
              <section className="mt-4 rounded-md border px-3 py-2.5">
                <p className="text-caption font-medium text-foreground">
                  {t(($) => $.detail.review_title)}
                </p>
                <p className="mt-1 text-caption text-muted-foreground">
                  {parsed.review.verdict}
                  {reviewedBy !== null
                    ? ` · ${t(($) => $.detail.by, { actor: reviewedBy })}`
                    : ""}
                  {parsed.review.reviewedAt !== null
                    ? ` · ${t(($) => $.detail.answered, {
                        age: timeAgo(parsed.review.reviewedAt),
                      })}`
                    : ""}
                </p>
                <p className="mt-2 text-caption font-medium text-foreground">
                  {t(($) => $.detail.review_comments)}
                </p>
                {parsed.review.comments.length === 0 ? (
                  <p className="mt-0.5 text-caption text-muted-foreground">
                    {t(($) => $.detail.review_no_comments)}
                  </p>
                ) : (
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-caption text-foreground">
                    {parsed.review.comments.map((comment, index) => (
                      <li key={`${index}:${comment}`}>{comment}</li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            <p className="mt-3 text-caption text-muted-foreground">
              {t(($) => $.detail.answered_hint)}
            </p>
          </ReadOnlyPlan>
        );
      }
      return (
        <PlanVerdictForm
          plan={parsed.plan}
          issueId={parsed.plan.issue_id}
          onRecorded={onChanged}
          onRejected={onChanged}
        />
      );
    }
    case "native": {
      const parsed = parseDecisionNative(detail);
      if (parsed === null) return <UnreadableSource />;
      if (state === "answered") {
        return (
          <div className="space-y-3">
            <ReadonlyContent content={parsed.content} />
            <p className="text-caption text-muted-foreground">
              {t(($) => $.detail.answered_hint)}
            </p>
          </div>
        );
      }
      if (parsed.questions.length === 0 || !isDecisionAnswerable("native")) {
        return (
          <div className="space-y-3">
            <p className="text-caption font-medium text-foreground">
              {t(($) => $.detail.native_no_form_title)}
            </p>
            <p className="text-caption text-muted-foreground">
              {t(($) => $.detail.native_no_form_hint)}
            </p>
            <ReadonlyContent content={parsed.content} />
            {issueLink}
          </div>
        );
      }
      // No `submit`: this is the transcript card's own transport — the answer
      // reaches the parked turn as a supplement, exactly as it does on the
      // issue page. The sequence fence that hardens it is M-210.
      return (
        <AgentQuestionCard
          issueId={decision.issue_id}
          taskId={parsed.taskId}
          questions={parsed.questions}
          onSent={onChanged}
        />
      );
    }
    case "status": {
      const parsed = parseDecisionStatus(detail);
      if (parsed === null) return <UnreadableSource />;
      return (
        <div className="space-y-3">
          <p className="flex items-center gap-1.5 text-caption font-medium text-foreground">
            <Flag aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
            {t(($) => $.detail.status_title)}
          </p>
          <p className="text-caption text-muted-foreground">
            {t(($) => $.detail.status_hint)}
          </p>
          {parsed.description.trim() !== "" && (
            <div className="rounded-md border px-3 py-2.5">
              <ReadonlyContent content={parsed.description} />
            </div>
          )}
          {issueLink}
        </div>
      );
    }
    default:
      return (
        <div className="space-y-2">
          <p className="text-caption font-medium text-foreground">
            {t(($) => $.detail.unknown_title)}
          </p>
          <p className="text-caption text-muted-foreground">
            {t(($) => $.detail.unknown_hint)}
          </p>
          {issueLink}
        </div>
      );
  }
}

function QuestionForm({
  issueId,
  cardId,
  context,
  questions,
  onChanged,
}: {
  issueId: string;
  cardId: string;
  context: string | null;
  questions: readonly AgentQuestion[];
  onChanged: () => void;
}) {
  const answer = useAnswerQuestionCard(issueId);
  return (
    <div>
      {context !== null && context.trim() !== "" && (
        <p className="mb-1 text-caption text-muted-foreground">{context}</p>
      )}
      <AgentQuestionCard
        issueId={issueId}
        taskId={cardId}
        questions={questions}
        submit={async (drafts: readonly AgentAnswerDraft[]) => {
          await answer.mutateAsync({ cardId, answers: draftsToCardAnswers(drafts) });
        }}
        onSent={onChanged}
      />
    </div>
  );
}

/**
 * A member id as a name, from the workspace directory this app already reads.
 *
 * The projections store the acting member's user id and nothing else, so the
 * name comes from the directory, and an id it does not hold (a member who left)
 * falls back to the translated generic rather than an English "Unknown" or the
 * raw id.
 */
function useActorLabel(): (id: string | null) => string | null {
  const { t } = useT("decisions");
  const { getActorName, hasActor } = useActorName();
  return (id) => {
    if (id === null) return null;
    return hasActor("member", id) === true
      ? getActorName("member", id)
      : t(($) => $.detail.unknown_actor);
  };
}

/** A plan's sections, with no verdict controls — every read-only plan state. */
function ReadOnlyPlan({
  plan,
  children,
}: {
  plan: AgentPlan;
  children?: React.ReactNode;
}) {
  const { t } = useT("decisions");
  return (
    <section aria-label={plan.title} data-agent-plan={plan.status}>
      <p className="text-body font-medium text-foreground">{plan.title}</p>
      <div className="mt-2 space-y-3">
        {plan.sections.map((section, index) => (
          <div key={`${index}:${section.sectionId}`}>
            <p className="text-body text-foreground">{section.heading}</p>
            {section.markdown.trim() === "" ? (
              <p className="mt-0.5 text-caption text-muted-foreground">
                {t(($) => $.detail.answers_empty)}
              </p>
            ) : (
              <div className="mt-0.5 text-body">
                <ReadonlyContent content={section.markdown} />
              </div>
            )}
          </div>
        ))}
      </div>
      {children}
    </section>
  );
}

function StoredAnswers({
  questions,
  answers,
  actor,
  at,
  hint,
}: {
  questions: readonly string[];
  answers: readonly AgentAnswerDraft[];
  actor: string | null;
  at: string | null;
  hint: string;
}) {
  const { t } = useT("decisions");
  const timeAgo = useTimeAgo();
  if (answers.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-caption font-medium text-foreground">
          {t(($) => $.detail.answers_title)}
        </p>
        <p className="text-caption text-muted-foreground">
          {t(($) => $.detail.answers_empty)}
        </p>
        <p className="text-caption text-muted-foreground">{hint}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-caption font-medium text-foreground">
        {t(($) => $.detail.answers_title)}
        {at !== null ? ` · ${t(($) => $.detail.answered, { age: timeAgo(at) })}` : ""}
      </p>
      <ol className="space-y-2">
        {questions.map((question, index) => {
          const answer = answers[index];
          const written = answer?.text?.trim() ?? "";
          const picks = (answer?.selected ?? [])
            .map((option) => `${index + 1}.${option + 1}`)
            .join(", ");
          return (
            <li key={`${index}:${question}`} className="rounded-md border px-3 py-2">
              <p className="text-caption text-muted-foreground">{question}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-body text-foreground">
                {written !== ""
                  ? written
                  : picks !== ""
                    ? picks
                    : t(($) => $.detail.no_answer)}
              </p>
            </li>
          );
        })}
      </ol>
      {actor !== null && (
        <p className="text-caption text-muted-foreground">
          {t(($) => $.detail.by, { actor })}
        </p>
      )}
      <p className="text-caption text-muted-foreground">{hint}</p>
    </div>
  );
}

function UnreadableSource() {
  const { t } = useT("decisions");
  return (
    <div className="space-y-2">
      <p className="text-caption font-medium text-foreground">
        {t(($) => $.detail.unknown_title)}
      </p>
      <p className="text-caption text-muted-foreground">
        {t(($) => $.detail.unknown_hint)}
      </p>
    </div>
  );
}

function CenteredState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <p className="text-body font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-caption text-muted-foreground">{hint}</p>
    </div>
  );
}
