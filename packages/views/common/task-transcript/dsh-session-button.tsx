import { ExternalLink } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import type { AgentTask } from "@multica/core/types/agent";

interface DshSessionButtonProps {
  task: AgentTask;
  title: string;
  className?: string;
}

/**
 * Compact icon-button that opens the dsh web app for this run's session in a
 * new tab. Rendered ONLY when the server set `dsh_session_url` (dsh-runtime
 * tasks whose transcript is owned by the dsh session store); every other
 * runtime omits the field and the button renders nothing.
 */
export function DshSessionButton({ task, title, className }: DshSessionButtonProps) {
  if (!task.dsh_session_url) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={task.dsh_session_url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={title}
          />
        }
        className={cn(
          "flex items-center justify-center rounded-xs p-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors",
          className,
        )}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}
