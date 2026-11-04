"use client";

import { useMemo, useState } from "react";
import {
  agentAnswerText,
  isAnsweredDraft,
  isPlanReview,
  planApprovalAnswer,
  type AgentAnswerDraft,
  type AgentQuestion,
} from "@multica/core/issues/agent-question";
import { useAnswerNativeQuestion, useCreateTaskSupplement } from "@multica/core/issues/mutations";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Input } from "@multica/ui/components/ui/input";
import { cn } from "@multica/ui/lib/utils";
import { Check, ClipboardList, HelpCircle, Loader2 } from "@multica/ui/icons";
import { ReadonlyContent } from "../../editor";
import { useT } from "../../i18n";

/**
 * The ask/plan card: a parked run's question, answered in place.
 *
 * Ported from the team-room's decision card (moct-dsh-team-room), which already
 * proved this shape: an open card is a form answered once, and its answer is
 * not shown as given until the backend has taken it. What changed here is where
 * the answer goes — to one named running turn, as an additional message, rather
 * than through the comment router — and where the question comes from, which is
 * the daemon's `question` transcript row (M-109) rather than a team-service
 * call.
 *
 * Two shapes, one component, because they are one exchange: a question offers
 * its options, a plan review offers its plan and a verdict. The daemon maps a
 * plan review answered with exactly its approve label onto the bridge's
 * approval selection; every other reply reaches the backend as the member's own
 * words, which is why the pick is sent as the option's label rather than a
 * separate field.
 *
 * Three transports, one form. With `submit` (the S1-A1 card, M-120) the same
 * drafts go to `/question-cards/{id}/answer`. Without it, the answer goes to
 * the named turn: with `questionSeq` it names the question too, so the server
 * can refuse a stale tab or a second window (M-210), and without it the answer
 * is an ordinary supplement. The form, its readiness rule and its
 * pending/sent/error lifecycle are identical either way, which is the point of
 * the seam — the card has no idea which one it is.
 */
export function AgentQuestionCard({
  issueId,
  taskId,
  questionSeq,
  questions,
  submit,
  onSent,
}: {
  issueId: string;
  /** The running turn this answer is delivered to. */
  taskId: string;
  /**
   * The transcript sequence this ask was asked at. When present the answer is
   * fenced to it, so it cannot land on a question the run already left.
   */
  questionSeq?: number;
  questions: readonly AgentQuestion[];
  /** Deliver the form's drafts somewhere other than the run's supplement path. */
  submit?: (drafts: readonly AgentAnswerDraft[]) => Promise<void>;
  /**
   * A surface that has to re-read after a send, and whose reads the answer
   * mutation does not own — the Decisions page (M-211). It runs after the
   * transport resolved, before the card shows its sent state.
   */
  onSent?: () => void;
}) {
  const { t } = useT("issues");
  const supplement = useCreateTaskSupplement(issueId);
  const fenced = useAnswerNativeQuestion(issueId);
  const [drafts, setDrafts] = useState<readonly AgentAnswerDraft[]>(() =>
    questions.map(() => ({ selected: [], text: "" })),
  );
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const plan = useMemo(() => isPlanReview(questions), [questions]);
  const approveLabel = useMemo(() => planApprovalAnswer(questions), [questions]);
  const ready = drafts.every(isAnsweredDraft);

  const pick = (index: number, option: number, multiple: boolean, checked: boolean) => {
    setDrafts((current) => current.map((draft, at) => {
      if (at !== index) return draft;
      if (!multiple) return { ...draft, selected: [option] };
      const selected = checked
        ? [...new Set([...draft.selected, option])].sort((left, right) => left - right)
        : draft.selected.filter((entry) => entry !== option);
      return { ...draft, selected };
    }));
  };

  const write = (index: number, text: string) => {
    setDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, text } : draft)));
  };

  /**
   * One submission: pending for its whole flight, then sent or an inline
   * error. Both transports run through it, so the disabled/enabled states and
   * the "sent" terminal state cannot drift apart between the two cards.
   *
   * With a caller-supplied transport the rejection carries the server's own
   * business message ("the question card is no longer open") and that is what
   * the member needs to read; the supplement path keeps its translated line,
   * since a supplement failure has nothing more specific to say.
   */
  const run = async (deliver: () => Promise<unknown>): Promise<void> => {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await deliver();
      setSent(true);
      onSent?.();
    } catch (cause) {
      const detail =
        submit !== undefined && cause instanceof Error && cause.message !== ""
          ? cause.message
          : null;
      setError(detail ?? t(($) => $.agent_question.failed));
    } finally {
      setPending(false);
    }
  };

  /**
   * The one delivery path for text: the caller's transport when there is one,
   * else the answer fenced to this question when the card knows its sequence,
   * else an ordinary supplement.
   */
  const deliver = (content: string): Promise<unknown> =>
    submit !== undefined
      ? submit(drafts)
      : questionSeq !== undefined
        ? fenced.mutateAsync({ taskId, questionSeq, content })
        : supplement.mutateAsync({ taskId, content });

  /** The plan review's two verdicts — the same transcript transport. */
  const send = (content: string): void => {
    if (content === "" || pending) return;
    void run(() => deliver(content));
  };

  /**
   * Answer the question form, through whichever transport this card was given.
   * An empty form is not a submission — that is the Enter key landing on a
   * field with nothing in it — and `agentAnswerText` is empty exactly then.
   */
  const answerForm = (): void => {
    const content = agentAnswerText(questions, drafts);
    if (content === "" || pending) return;
    void run(() => deliver(content));
  };

  // A plan review's two verdicts are buttons, not options: "request changes"
  // has to carry the member's words, so it shares the field below them.
  const planDetail = plan ? questions[0]?.detail : undefined;

  return (
    <section
      aria-label={plan ? t(($) => $.agent_question.plan_title) : t(($) => $.agent_question.ask_title)}
      data-agent-question={plan ? "plan" : "ask"}
      className="mt-2 min-w-0 rounded-md border border-border bg-muted/40 px-3 py-2.5"
    >
      <p className="flex items-center gap-1.5 text-caption font-medium text-foreground">
        {plan
          ? <ClipboardList aria-hidden className="size-3.5 shrink-0 text-info" />
          : <HelpCircle aria-hidden className="size-3.5 shrink-0 text-info" />}
        {plan ? t(($) => $.agent_question.plan_title) : t(($) => $.agent_question.ask_title)}
      </p>

      {planDetail !== undefined && (
        <div className="mt-2 max-h-56 overflow-y-auto rounded-xs bg-background/70 px-2.5 py-2 text-caption">
          <ReadonlyContent content={planDetail} />
        </div>
      )}

      <div className="mt-2 space-y-3">
        {questions.map((question, index) => {
          const draft = drafts[index] ?? { selected: [], text: "" };
          return (
            <fieldset key={question.id} disabled={pending || sent} data-agent-question-question={index}>
              <legend className="text-body text-foreground">
                {questions.length > 1 && (
                  <span className="mr-1.5 text-muted-foreground">{index + 1}.</span>
                )}
                {question.question}
              </legend>
              {!plan && question.options.length > 0 && (
                <>
                  <p className="mt-0.5 text-caption text-muted-foreground">
                    {question.multiSelect
                      ? t(($) => $.agent_question.multiple_choices)
                      : t(($) => $.agent_question.single_choice)}
                  </p>
                  <div className="mt-1.5 space-y-1">
                    {question.options.map((option, optionIndex) => {
                      const chosen = draft.selected.includes(optionIndex);
                      return (
                        <label
                          key={`${question.id}:${optionIndex}`}
                          data-chosen={chosen ? "" : undefined}
                          className={cn(
                            "flex cursor-pointer items-start gap-2 rounded-xs border px-2 py-1.5 text-caption",
                            chosen ? "border-brand/60 bg-brand/7 dark:bg-brand/12" : "border-transparent hover:bg-accent/40",
                          )}
                        >
                          {question.multiSelect ? (
                            <Checkbox
                              className="mt-0.5"
                              checked={chosen}
                              onCheckedChange={(value) => pick(index, optionIndex, true, value === true)}
                            />
                          ) : (
                            <input
                              type="radio"
                              className="mt-0.5 size-3.5 accent-brand"
                              name={`${question.id}:${index}`}
                              checked={chosen}
                              onChange={() => pick(index, optionIndex, false, true)}
                            />
                          )}
                          <span className="min-w-0">
                            <span className="block text-foreground">{option.label}</span>
                            {option.description !== undefined && (
                              <span className="block text-micro text-muted-foreground">{option.description}</span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </>
              )}
              {(plan || question.options.length === 0) && (
                <Input
                  className="mt-1.5 h-8 text-caption"
                  value={draft.text}
                  maxLength={2000}
                  placeholder={t(($) => $.agent_question.answer_placeholder)}
                  aria-label={t(($) => $.agent_question.answer_label, {
                    question: question.header ?? question.question,
                  })}
                  onChange={(event) => write(index, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing || plan) return;
                    event.preventDefault();
                    answerForm();
                  }}
                />
              )}
              {!plan && question.options.length > 0 && (
                <Input
                  className="mt-1.5 h-8 text-caption"
                  value={draft.text}
                  maxLength={2000}
                  placeholder={t(($) => $.agent_question.other_placeholder)}
                  aria-label={t(($) => $.agent_question.answer_label, {
                    question: question.header ?? question.question,
                  })}
                  onChange={(event) => write(index, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    answerForm();
                  }}
                />
              )}
            </fieldset>
          );
        })}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        {error !== null && (
          <span role="alert" className="mr-auto text-caption text-destructive">{error}</span>
        )}
        {sent ? (
          <span className="flex items-center gap-1.5 text-caption text-success">
            <Check aria-hidden className="size-3.5" />{t(($) => $.agent_question.sent)}
          </span>
        ) : plan ? (
          <>
            <span className="mr-auto text-caption text-muted-foreground">
              {t(($) => $.agent_question.plan_hint)}
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={pending || !ready}
              onClick={() => send(agentAnswerText(questions, drafts))}
            >
              {t(($) => $.agent_question.request_changes)}
            </Button>
            <Button
              size="xs"
              variant="default"
              disabled={pending || approveLabel === null}
              onClick={() => send(approveLabel ?? "")}
            >
              {pending && <Loader2 className="animate-spin motion-reduce:animate-none" />}
              {t(($) => $.agent_question.approve)}
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            variant="default"
            disabled={pending || !ready}
            onClick={() => answerForm()}
          >
            {pending && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {pending ? t(($) => $.agent_question.sending) : t(($) => $.agent_question.send)}
          </Button>
        )}
      </div>
    </section>
  );
}
