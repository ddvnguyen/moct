import type { AgentTask } from "../src/fork";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSteerComposer } from "../src/client/steer-composer";
import type { HostCreateElement } from "../src/client/seat";
import {
  resetSteerStore,
  setAgentTasks,
  TASK_SUPPLEMENT_CAPABILITY,
} from "../src/client/steer-store";

// The host proxy resolves the workspace from this header; the composer must
// read it the same way the island does, without a token of its own.
vi.mock("../src/client/config", () => ({
  ISLAND_API_BASE: "/multica",
  islandConfig: async () => ({ wsPath: "/multica/ws", workspaceSlug: "demo", problem: null }),
}));

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A successful supplement POST: the comment id is the row's handle. */
function receipt(commentId = "comment-1"): Response {
  return jsonResponse({ id: commentId, supplements: [{ task_id: "task-1", status: "pending" }] });
}

function mount(sessionId = "sess-1") {
  // The shell hands the plugin its own `createElement`; React's is the same
  // shape and is what the test tree can render.
  const Composer = createSteerComposer(createElement as unknown as HostCreateElement);
  return render(createElement(Composer as never, { sessionId }));
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Message this run") as HTMLTextAreaElement;
}

describe("steer composer", () => {
  beforeEach(() => {
    resetSteerStore();
    setAgentTasks([task({ id: "task-1" })]);
  });

  afterEach(() => {
    resetSteerStore();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("mounts inside the host element it was handed", () => {
    const { container } = mount();
    const host = container.querySelector("[data-multica-steer-composer]");
    expect(host).not.toBeNull();
    expect(host?.querySelector("textarea")).not.toBeNull();
    expect(screen.getByText("Multica run")).toBeInTheDocument();
    // The run's short id is how a reader tells two chats apart.
    expect(screen.getByText("#task-1")).toBeInTheDocument();
  });

  it("is inert for a session no running turn owns", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mount("sess-not-ours");

    expect(textarea()).toBeDisabled();
    expect(textarea().placeholder).toBe("This run has ended.");
    expect(screen.getByRole("button", { name: "Queue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Steer" })).toBeDisabled();
    // Nothing to stop: the run is already over.
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queues with Enter, naming the exact turn and the workspace", async () => {
    const fetchMock = vi.fn(async () => receipt());
    vi.stubGlobal("fetch", fetchMock);
    mount();

    fireEvent.input(textarea(), { target: { value: "also run the linter" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });

    await waitFor(() => expect(screen.getByText("Queued for the next turn")).toBeInTheDocument());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/multica/api/issues/issue-1/tasks/task-1/supplements");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject({
      "X-Workspace-Slug": "demo",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ content: "also run the linter", mode: "queue" });
    expect(typeof body.client_request_id).toBe("string");

    // The draft is spent, and the message is listed as waiting for the next turn.
    expect(textarea().value).toBe("");
    expect(screen.getByText("also run the linter")).toBeInTheDocument();
    expect(screen.getByText("queued — next turn")).toBeInTheDocument();
  });

  it("steers with Cmd/Ctrl+Enter instead of queueing", async () => {
    const fetchMock = vi.fn(async () => receipt());
    vi.stubGlobal("fetch", fetchMock);
    mount();

    fireEvent.input(textarea(), { target: { value: "stop and do X" } });
    fireEvent.keyDown(textarea(), { key: "Enter", metaKey: true });

    await waitFor(() => expect(screen.getByText("Sent to the running turn")).toBeInTheDocument());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ mode: "steer" });
    // A steered message is not a queued row: it went into this turn.
    expect(screen.queryByText("queued — next turn")).not.toBeInTheDocument();
  });

  it("leaves a newline for Shift+Enter", async () => {
    const fetchMock = vi.fn(async () => receipt());
    vi.stubGlobal("fetch", fetchMock);
    mount();

    fireEvent.input(textarea(), { target: { value: "line one" } });
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(textarea().value).toBe("line one");
  });

  it("keeps the draft and shows the server's reason when the send is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "task_supplement_turn_ended" }, 409)),
    );
    mount();

    fireEvent.input(textarea(), { target: { value: "too late" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));

    await waitFor(() => expect(screen.getByText("task_supplement_turn_ended")).toBeInTheDocument());
    expect(textarea().value).toBe("too late");
  });

  it("stops only on the second click, never on the first", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByText("Stop this run?")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();

    // Backing out of the confirm sends nothing either.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Stop this run?")).not.toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(screen.getByText("Stop requested")).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/multica/api/issues/issue-1/tasks/task-1/cancel");
    expect(init.method).toBe("POST");
  });

  it("goes inert when the turn ends underneath it", async () => {
    mount();
    expect(textarea()).not.toBeDisabled();

    // The reporter's next snapshot no longer lists the run.
    setAgentTasks([]);

    expect(textarea()).toBeDisabled();
    expect(textarea().placeholder).toBe("This run has ended.");
    expect(screen.getByText("Multica run")).toBeInTheDocument();
    expect(screen.queryByText("#task-1")).not.toBeInTheDocument();
  });
});
