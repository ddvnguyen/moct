import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { RunSteerControls } from "./run-steer-controls";

const apiMock = vi.hoisted(() => ({
  createTaskSupplement: vi.fn(),
  listRuntimes: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({ api: apiMock }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace" }));

const DSH_RUNTIME = { id: "runtime-dsh", provider: "dsh" };
const CLAUDE_RUNTIME = { id: "runtime-claude", provider: "claude" };

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "0123456789abcdef",
    issue_id: "issue-1",
    agent_id: "agent-1",
    runtime_id: "runtime-dsh",
    status: "running",
    supplement_capability: "task-supplement-v1",
    can_supplement: true,
    ...overrides,
  } as unknown as AgentTask;
}

function render(taskRow: AgentTask) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <RunSteerControls task={taskRow} issueId="issue-1" />
    </QueryClientProvider>,
  );
}

/** Open the popover and type a draft; both actions read the same box. */
async function openWithDraft(text: string): Promise<HTMLTextAreaElement> {
  fireEvent.click(screen.getByRole("button", { name: "Send a message to this run" }));
  const box = await screen.findByPlaceholderText("Message this run…");
  fireEvent.change(box, { target: { value: text } });
  return box as HTMLTextAreaElement;
}

describe("RunSteerControls", () => {
  beforeEach(() => {
    apiMock.createTaskSupplement.mockReset();
    apiMock.listRuntimes.mockReset();
    apiMock.listRuntimes.mockResolvedValue([DSH_RUNTIME, CLAUDE_RUNTIME]);
  });

  it("renders nothing for a turn that cannot take a message", () => {
    const cases = [
      task({ status: "completed" }),
      task({ supplement_capability: undefined }),
      task({ supplement_capability: "task-supplement-v0" }),
      task({ can_supplement: false }),
      task({ can_supplement: undefined }),
    ];
    for (const row of cases) {
      const { unmount } = render(row);
      expect(screen.queryByRole("button", { name: "Steer this run" })).not.toBeInTheDocument();
      unmount();
    }
    // No point asking which runtime it is: the control is not there.
    expect(apiMock.listRuntimes).not.toHaveBeenCalled();
  });

  it("queues by default on a dsh runtime", async () => {
    apiMock.createTaskSupplement.mockResolvedValue({ id: "comment-1" });
    render(task());

    const box = await openWithDraft("also run the linter");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Queue" })).toBeInTheDocument(),
    );

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(apiMock.createTaskSupplement).toHaveBeenCalledTimes(1));
    expect(apiMock.createTaskSupplement.mock.calls[0]?.slice(0, 3)).toEqual([
      "issue-1",
      "0123456789abcdef",
      "also run the linter",
    ]);
    // The mode is the last argument; the client id is generated inside.
    expect(apiMock.createTaskSupplement.mock.calls[0]?.[4]).toBe("queue");
  });

  it("steers on Cmd/Ctrl+Enter instead", async () => {
    apiMock.createTaskSupplement.mockResolvedValue({ id: "comment-1" });
    render(task());

    const box = await openWithDraft("stop and do X");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Queue" })).toBeInTheDocument(),
    );

    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(apiMock.createTaskSupplement).toHaveBeenCalledTimes(1));
    expect(apiMock.createTaskSupplement.mock.calls[0]?.[4]).toBe("steer");
  });

  it("offers only Steer when the runtime cannot queue", async () => {
    apiMock.listRuntimes.mockResolvedValue([CLAUDE_RUNTIME]);
    apiMock.createTaskSupplement.mockResolvedValue({ id: "comment-1" });
    render(task({ runtime_id: "runtime-claude" }));

    const box = await openWithDraft("stop and do X");
    await waitFor(() => expect(screen.getByRole("button", { name: "Steer" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Queue" })).not.toBeInTheDocument();

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(apiMock.createTaskSupplement).toHaveBeenCalledTimes(1));
    expect(apiMock.createTaskSupplement.mock.calls[0]?.[4]).toBe("steer");
  });

  it("keeps the draft when the send is refused", async () => {
    apiMock.createTaskSupplement.mockRejectedValue(new Error("task_supplement_turn_ended"));
    render(task());

    const box = await openWithDraft("too late");
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));

    await waitFor(() => expect(apiMock.createTaskSupplement).toHaveBeenCalledTimes(1));
    expect(box.value).toBe("too late");
  });

  it("does nothing on an empty draft", async () => {
    render(task());
    fireEvent.click(screen.getByRole("button", { name: "Send a message to this run" }));
    const box = (await screen.findByPlaceholderText("Message this run…")) as HTMLTextAreaElement;

    fireEvent.keyDown(box, { key: "Enter" });
    expect(apiMock.createTaskSupplement).not.toHaveBeenCalled();
  });
});
