import type { AgentTask } from "../src/fork";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addQueued,
  isSteerableTask,
  queuedFor,
  removeQueued,
  resetSteerStore,
  selectOwnedSession,
  setAgentTasks,
  subscribe,
  TASK_SUPPLEMENT_CAPABILITY,
  updateQueued,
} from "../src/client/steer-store";

/** Only the fields the ownership map reads; the rest of the row is noise here. */
function task(overrides: Partial<AgentTask> & { id: string }): AgentTask {
  return {
    issue_id: "issue-1",
    agent_id: "agent-1",
    status: "running",
    supplement_capability: TASK_SUPPLEMENT_CAPABILITY,
    can_supplement: true,
    session_id: "sess-1",
    ...overrides,
  } as unknown as AgentTask;
}

describe("isSteerableTask", () => {
  it("accepts a running task that negotiated the capability", () => {
    expect(isSteerableTask(task({ id: "t-1" }))).toBe(true);
  });

  it("declines a run that is not running", () => {
    for (const status of ["queued", "dispatched", "completed", "failed", "cancelled"] as const) {
      expect(isSteerableTask(task({ id: "t-1", status }))).toBe(false);
    }
  });

  it("declines a run without the capability or without permission", () => {
    expect(isSteerableTask(task({ id: "t-1", supplement_capability: null as never }))).toBe(false);
    expect(isSteerableTask(task({ id: "t-1", supplement_capability: "task-supplement-v0" }))).toBe(false);
    expect(isSteerableTask(task({ id: "t-1", can_supplement: false }))).toBe(false);
    // Undefined is "the server did not say", which is not a yes.
    expect(isSteerableTask(task({ id: "t-1", can_supplement: undefined }))).toBe(false);
  });
});

describe("ownership map", () => {
  beforeEach(() => {
    resetSteerStore();
  });

  it("maps a running task's session to the turn that owns it", () => {
    setAgentTasks([task({ id: "t-1" })]);
    expect(selectOwnedSession("sess-1")).toEqual({
      taskId: "t-1",
      issueId: "issue-1",
      agentId: "agent-1",
    });
  });

  it("declines a session with no running owner", () => {
    setAgentTasks([task({ id: "t-1", status: "completed" })]);
    expect(selectOwnedSession("sess-1")).toBeNull();
    expect(selectOwnedSession("sess-other")).toBeNull();
    expect(selectOwnedSession(undefined)).toBeNull();
    expect(selectOwnedSession(null)).toBeNull();
  });

  it("ignores rows whose session is missing or blank", () => {
    setAgentTasks([
      task({ id: "t-1", session_id: undefined }),
      task({ id: "t-2", session_id: "   " }),
    ]);
    expect(selectOwnedSession("")).toBeNull();
    expect(selectOwnedSession("   ")).toBeNull();
  });

  it("declines a session two running tasks claim, rather than guessing", () => {
    setAgentTasks([task({ id: "t-1" }), task({ id: "t-2" })]);
    expect(selectOwnedSession("sess-1")).toBeNull();
  });

  it("takes the session over again once the clash resolves", () => {
    setAgentTasks([task({ id: "t-1" }), task({ id: "t-2" })]);
    expect(selectOwnedSession("sess-1")).toBeNull();
    setAgentTasks([task({ id: "t-2" })]);
    expect(selectOwnedSession("sess-1")?.taskId).toBe("t-2");
  });

  it("replaces the map from each snapshot instead of accumulating", () => {
    setAgentTasks([task({ id: "t-1" })]);
    setAgentTasks([task({ id: "t-2", session_id: "sess-2" })]);
    expect(selectOwnedSession("sess-1")).toBeNull();
    expect(selectOwnedSession("sess-2")?.taskId).toBe("t-2");
  });

  it("clears the map for a null or empty snapshot", () => {
    setAgentTasks([task({ id: "t-1" })]);
    setAgentTasks(null);
    expect(selectOwnedSession("sess-1")).toBeNull();
  });

  it("notifies subscribers only when the ownership actually changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    setAgentTasks([task({ id: "t-1" })]);
    expect(listener).toHaveBeenCalledTimes(1);

    // Same owner, fresh objects: the poller re-reads every 30s and must not
    // repaint the composer for a snapshot that says nothing new.
    setAgentTasks([task({ id: "t-1" })]);
    expect(listener).toHaveBeenCalledTimes(1);

    setAgentTasks([task({ id: "t-1", agent_id: "agent-2" })]);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setAgentTasks([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("queued supplements", () => {
  beforeEach(() => {
    resetSteerStore();
  });

  const row = {
    commentId: "c-1",
    taskId: "t-1",
    content: "please also fix the tests",
    mode: "queue" as const,
    status: "pending",
  };

  it("keeps rows per task, oldest first", () => {
    addQueued(row);
    addQueued({ ...row, commentId: "c-2", content: "second" });
    expect(queuedFor("t-1").map((r) => r.commentId)).toEqual(["c-1", "c-2"]);
    expect(queuedFor("t-2")).toEqual([]);
  });

  it("ignores a row it already holds", () => {
    addQueued(row);
    const listener = vi.fn();
    subscribe(listener);
    addQueued(row);
    expect(queuedFor("t-1")).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("applies a promote receipt to the row", () => {
    addQueued(row);
    updateQueued("t-1", "c-1", { mode: "steer", status: "pending" });
    expect(queuedFor("t-1")[0]).toMatchObject({ mode: "steer", status: "pending" });
  });

  it("does not notify for an unchanged or unknown row", () => {
    addQueued(row);
    const listener = vi.fn();
    subscribe(listener);

    updateQueued("t-1", "c-1", { mode: "queue", status: "pending" });
    updateQueued("t-1", "c-missing", { status: "delivered" });
    updateQueued("t-unknown", "c-1", { status: "delivered" });
    expect(listener).not.toHaveBeenCalled();

    updateQueued("t-1", "c-1", { status: "delivered" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops a row on remove, and ignores an unknown one", () => {
    addQueued(row);
    removeQueued("t-1", "c-missing");
    expect(queuedFor("t-1")).toHaveLength(1);
    removeQueued("t-1", "c-1");
    expect(queuedFor("t-1")).toEqual([]);
  });
});
