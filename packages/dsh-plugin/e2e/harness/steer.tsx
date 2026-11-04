import { createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api";
import type { AgentTask } from "../../src/fork";
import { createSteerComposer, STEER_COMPOSER_ENTRY } from "../../src/client/steer-composer";
import { SteerReporter } from "../../src/client/steer-reporter";
import { subscribe, TASK_SUPPLEMENT_CAPABILITY } from "../../src/client/steer-store";
import type { HostCreateElement } from "../../src/client/seat";
import { installBackend } from "./backend";

/**
 * M-136 harness: the composer takeover against a fake dsh shell.
 *
 * The takeover is a `conversation.composer` chain entry, so what a browser has
 * to prove is not the component's markup (jsdom covers that) but the chain
 * contract around it: the entry is elected only while one running turn owns
 * the session, the shell's own composer stays mounted underneath with its
 * draft, and the three writes go to the issue-scoped routes the server serves.
 *
 * The shell half here is deliberately small and faithful to the two rules the
 * chain relies on: elect by ascending `priority` with the first non-null
 * selector result, and keep the fallback mounted (`overlay: true`). The slot
 * runtime itself lives in dsh, which this package does not depend on; the entry
 * is the exported one `apply` registers, so the selector under test is the
 * production selector.
 *
 * `window.__steer.setSnapshot(rows)` stands in for the task events that arrive
 * while a turn streams: it swaps what `GET /api/agent-task-snapshot` answers
 * and refetches, which is the only input the takeover reads.
 */

const SESSION_ID = "sess-1";

const RUNNING_TASK = {
  id: "task-1",
  issue_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "agent-1",
  status: "running",
  session_id: SESSION_ID,
  supplement_capability: TASK_SUPPLEMENT_CAPABILITY,
  can_supplement: true,
} as unknown as AgentTask;

declare global {
  interface Window {
    /** Drive the snapshot the way a live turn's task events would. */
    __steer?: {
      setSnapshot(rows: unknown[]): void;
      sessionId: string;
    };
  }
}

// The writes are real requests to the host proxy path; this stubs their
// answers and records what was sent.
installBackend();

let snapshot: AgentTask[] = [RUNNING_TASK];
// The reporter is the only reader of the snapshot query; the takeover itself
// reads the store. Stubbing the api keeps the page free of a server while the
// query, the store write and the repaint stay the production ones.
setApiInstance({
  getAgentTaskSnapshot: async () => snapshot,
} as unknown as ApiClient);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

window.__steer = {
  setSnapshot(rows: unknown[]): void {
    snapshot = rows as AgentTask[];
    void queryClient.invalidateQueries();
  },
  sessionId: SESSION_ID,
};

const SteerComposer = createSteerComposer(createElement as unknown as HostCreateElement);

/** Repaint when the ownership map changes, as the shell does per render. */
function useStoreVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribe(() => setVersion((value) => value + 1)), []);
  return version;
}

function ComposerSlot({ sessionId }: { sessionId: string }) {
  useStoreVersion();
  const owner = { sessionId };
  const matched = STEER_COMPOSER_ENTRY.select(owner);

  return (
    <div id="composer-slot">
      {/* The shell's own composer, kept mounted the way `overlay: true` keeps
          it: hidden, never unmounted, so a draft typed before the takeover is
          still there after it. */}
      <div
        data-testid="shell-composer"
        data-elected={matched === null ? "false" : "true"}
        style={matched === null ? undefined : { display: "none" }}
      >
        <span data-testid="shell-composer-label">dsh composer</span>
        <textarea data-testid="shell-input" aria-label="Message dsh" rows={2} />
      </div>
      {matched === null
        ? null
        : createElement(SteerComposer as never, { ...owner, matched })}
    </div>
  );
}

function Shell() {
  return (
    <div id="shell">
      <header data-testid="shell-header">session {SESSION_ID}</header>
      <QueryClientProvider client={queryClient}>
        <SteerReporter workspaceId="ws-1" />
        <ComposerSlot sessionId={SESSION_ID} />
      </QueryClientProvider>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  createElement(Shell, null),
);
