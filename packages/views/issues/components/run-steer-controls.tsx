"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, MessageSquarePlus } from "@multica/ui/icons";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { TASK_SUPPLEMENT_CAPABILITY } from "@multica/core/issues/run-steering";
import { useCreateTaskSupplement } from "@multica/core/issues/mutations";
import { runtimeListOptions } from "@multica/core/runtimes/queries";
import type { AgentTask } from "@multica/core/types";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";

/**
 * Steer or queue one message into one exact running turn (M-136).
 *
 * Two actions, one draft:
 *
 * - **Queue** is the default wherever the runtime supports it: the message is
 *   stored against this run and read at the agent's next turn. Nothing about
 *   the running turn is interrupted.
 * - **Steer** is the explicit override: the same message, delivered into the
 *   turn at its next step.
 *
 * Both name this task id, so two concurrent runs of one agent can never cross.
 * The controls render only for a running turn whose daemon negotiated
 * `task-supplement-v1` and whose viewer may supplement it — the server's own
 * verdict, not a client guess. Queue additionally needs a `dsh` runtime,
 * because the server rejects `mode=queue` for every other provider.
 */
export function RunSteerControls({
  task,
  issueId,
  className,
}: {
  task: AgentTask;
  issueId: string;
  className?: string;
}) {
  // Every hook below needs the workspace route and a React Query client, and a
  // finished run can never be steered. Deciding that here keeps a completed
  // row — the common case in the runs list — from subscribing to anything.
  const steerable =
    task.status === "running" &&
    task.supplement_capability === TASK_SUPPLEMENT_CAPABILITY &&
    task.can_supplement === true;
  if (!steerable) return null;
  return <SteerableRun task={task} issueId={issueId} className={className} />;
}

function SteerableRun({
  task,
  issueId,
  className,
}: {
  task: AgentTask;
  issueId: string;
  className?: string;
}) {
  const { t } = useT("issues");
  const workspaceId = useWorkspaceId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<"steer" | "queue" | null>(null);
  const createSupplement = useCreateTaskSupplement(issueId);

  const { data: runtimes = [] } = useQuery(runtimeListOptions(workspaceId));
  const provider = runtimes.find((runtime) => runtime.id === task.runtime_id)?.provider;
  const queueSupported = provider === "dsh";
  const defaultMode: "steer" | "queue" = queueSupported ? "queue" : "steer";

  const submit = async (mode: "steer" | "queue") => {
    const content = draft.trim();
    if (content === "" || sending !== null) return;
    setSending(mode);
    try {
      await createSupplement.mutateAsync({ taskId: task.id, content, mode });
      setDraft("");
      setOpen(false);
      toast.success(
        mode === "queue"
          ? t(($) => $.execution_log.steer_queued)
          : t(($) => $.execution_log.steer_sent),
      );
    } catch (error) {
      // The draft stays: a refused or failed send is retried from here.
      toast.error(error instanceof Error ? error.message : t(($) => $.execution_log.steer_failed));
    } finally {
      setSending(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverTrigger
          render={
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t(($) => $.execution_log.steer_aria)}
                  className={cn(
                    "flex items-center justify-center rounded-xs p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    className,
                  )}
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                </button>
              }
            />
          }
        />
        <TooltipContent>{t(($) => $.execution_log.steer_tooltip)}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" side="top" className="w-80 p-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-micro text-muted-foreground">
            <span className="truncate">
              {t(($) => $.execution_log.steer_target, { id: task.id.slice(0, 8) })}
            </span>
            <span className="shrink-0">
              {defaultMode === "queue"
                ? t(($) => $.execution_log.steer_hint_queue)
                : t(($) => $.execution_log.steer_hint_steer)}
            </span>
          </div>
          <textarea
            autoFocus
            value={draft}
            rows={3}
            placeholder={t(($) => $.execution_log.steer_placeholder)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              if (event.shiftKey) return;
              event.preventDefault();
              // Enter takes the default action; the modifier takes the other
              // one. Without a queue-capable runtime there is no other one, so
              // both chords steer rather than swallowing the key.
              const wantsOther = event.metaKey || event.ctrlKey;
              void submit(queueSupported && !wantsOther ? "queue" : "steer");
            }}
            className="max-h-40 min-h-16 w-full resize-none rounded-md border border-border bg-transparent px-2 py-1.5 text-caption outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <div className="flex items-center justify-end gap-1">
            {queueSupported && (
              <button
                type="button"
                disabled={sending !== null || draft.trim() === ""}
                onClick={() => void submit("queue")}
                className={cn(
                  "flex h-7 items-center gap-1 rounded-md px-2 text-caption transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  defaultMode === "queue"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {sending === "queue" && <Loader2 className="h-3 w-3 animate-spin" />}
                {t(($) => $.execution_log.steer_queue)}
              </button>
            )}
            <button
              type="button"
              disabled={sending !== null || draft.trim() === ""}
              onClick={() => void submit("steer")}
              className={cn(
                "flex h-7 items-center gap-1 rounded-md px-2 text-caption transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                defaultMode === "steer"
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {sending === "steer" && <Loader2 className="h-3 w-3 animate-spin" />}
              {t(($) => $.execution_log.steer_now)}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
