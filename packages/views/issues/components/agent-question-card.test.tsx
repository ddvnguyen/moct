import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import type { AgentAnswerDraft, AgentQuestion } from "@multica/core/issues/agent-question";
import { renderWithI18n } from "../../test/i18n";
import { AgentQuestionCard } from "./agent-question-card";

vi.mock("@multica/core/api", () => ({ api: { createTaskSupplement: vi.fn(), answerNativeQuestion: vi.fn() } }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace" }));
vi.mock("../../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => <div data-testid="plan-detail">{content}</div>,
}));

const TASK = "turn-1";

function comment(content: string) {
  return {
    id: `comment-${content.length}`, issue_id: "issue", author_type: "member", author_id: "user",
    content, type: "comment", parent_id: null, created_at: "2026-10-26T12:00:10Z",
    updated_at: "2026-10-26T12:00:10Z", reactions: [], attachments: [], issue_revision: null,
  };
}

function question(overrides: Partial<AgentQuestion> = {}): AgentQuestion {
  return {
    id: "q1",
    question: "Which checkout should this land in?",
    options: [{ label: "Web", description: "The Next.js app" }, { label: "Mobile" }],
    multiSelect: false,
    ...overrides,
  } as AgentQuestion;
}

const plan: AgentQuestion = {
  id: "plan",
  question: "Approve this plan?",
  detail: "1. Read the fork\n2. Wire the card",
  options: [{ label: "Approve" }, { label: "Keep planning" }],
  multiSelect: false,
  intent: { kind: "plan-review", approve: "Approve" },
};

function render(
  questions: AgentQuestion[],
  submit?: (drafts: readonly AgentAnswerDraft[]) => Promise<void>,
  questionSeq?: number,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={client}>
      <AgentQuestionCard
        issueId="issue"
        taskId={TASK}
        questions={questions}
        submit={submit}
        questionSeq={questionSeq}
      />
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentQuestionCard", () => {
  it("shows the question with its options and descriptions", () => {
    render([question()]);
    expect(screen.getByText("Which checkout should this land in?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Web/ })).toBeInTheDocument();
    expect(screen.getByText("The Next.js app")).toBeInTheDocument();
    expect(screen.getByText("Pick one")).toBeInTheDocument();
  });

  it("answers a pick with the option's own label, steered into the running turn", async () => {
    vi.mocked(api.createTaskSupplement).mockResolvedValue(comment("Web") as never);
    render([question()]);
    fireEvent.click(screen.getByRole("radio", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(api.createTaskSupplement).toHaveBeenCalledWith(
      "issue", TASK, "Web", expect.any(String),
    ));
  });

  it("sends the member's own words when they do not pick an option", async () => {
    vi.mocked(api.createTaskSupplement).mockResolvedValue(comment("Neither") as never);
    render([question()]);
    fireEvent.change(screen.getByPlaceholderText("Or write your own answer"), { target: { value: "Neither — use the CLI" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(api.createTaskSupplement).toHaveBeenCalledWith(
      "issue", TASK, "Neither — use the CLI", expect.any(String),
    ));
  });

  it("offers a checkbox per option when the backend allows several", () => {
    render([question({ multiSelect: true })]);
    expect(screen.getByRole("checkbox", { name: /Web/ })).toBeInTheDocument();
    expect(screen.getByText("Pick any")).toBeInTheDocument();
  });

  it("keeps the answer button disabled until there is something to send", () => {
    render([question()]);
    expect(screen.getByRole("button", { name: "Answer" })).toBeDisabled();
  });

  it("shows the plan and approves with exactly the label the daemon matches", async () => {
    vi.mocked(api.createTaskSupplement).mockResolvedValue(comment("Approve") as never);
    render([plan]);
    expect(screen.getByTestId("plan-detail")).toHaveTextContent("1. Read the fork");
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await waitFor(() => expect(api.createTaskSupplement).toHaveBeenCalledWith(
      "issue", TASK, "Approve", expect.any(String),
    ));
  });

  it("sends a revision request as the member's words", async () => {
    vi.mocked(api.createTaskSupplement).mockResolvedValue(comment("Split step 2") as never);
    render([plan]);
    fireEvent.change(screen.getByPlaceholderText("Your answer"), { target: { value: "Split step 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(api.createTaskSupplement).toHaveBeenCalledWith(
      "issue", TASK, "Split step 2", expect.any(String),
    ));
  });

  it("fences the answer to the ask's own sequence when the card knows it", async () => {
    vi.mocked(api.answerNativeQuestion).mockResolvedValue(comment("Web") as never);
    render([question()], undefined, 7);
    fireEvent.click(screen.getByRole("radio", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(api.answerNativeQuestion).toHaveBeenCalledWith(
      "issue", TASK, 7, "Web", expect.any(String),
    ));
    expect(api.createTaskSupplement).not.toHaveBeenCalled();
  });

  it("fences a plan approval to the ask's sequence with exactly the approve label", async () => {
    vi.mocked(api.answerNativeQuestion).mockResolvedValue(comment("Approve") as never);
    render([plan], undefined, 3);
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await waitFor(() => expect(api.answerNativeQuestion).toHaveBeenCalledWith(
      "issue", TASK, 3, "Approve", expect.any(String),
    ));
    expect(api.createTaskSupplement).not.toHaveBeenCalled();
  });

  it("reuses the draft's request id after a transport failure", async () => {
    vi.mocked(api.answerNativeQuestion)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(comment("Web") as never);
    render([question()], undefined, 7);
    fireEvent.click(screen.getByRole("radio", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    await waitFor(() => expect(api.answerNativeQuestion).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(api.answerNativeQuestion).mock.calls;
    expect(second?.[4]).toBe(first?.[4]);
    expect(await screen.findByText("Answer sent")).toBeInTheDocument();
  });

  it("reports a send that failed instead of claiming it went through", async () => {
    vi.mocked(api.createTaskSupplement).mockRejectedValue(new Error("nope"));
    render([question()]);
    fireEvent.click(screen.getByRole("radio", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not send your answer. Try again.");
    expect(screen.queryByText("Answer sent")).not.toBeInTheDocument();
  });

  it("marks the answer as sent once the server took it", async () => {
    vi.mocked(api.createTaskSupplement).mockResolvedValue(comment("Web") as never);
    render([question()]);
    fireEvent.click(screen.getByRole("radio", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(await screen.findByText("Answer sent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Answer" })).not.toBeInTheDocument();
  });

  it("hands the drafts to a caller-supplied transport and leaves the supplement alone", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render([question()], submit);
    fireEvent.click(screen.getByRole("radio", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith([{ selected: [0], text: "" }]));
    expect(api.createTaskSupplement).not.toHaveBeenCalled();
    expect(await screen.findByText("Answer sent")).toBeInTheDocument();
  });

  it("reports the transport's refusal message rather than the generic one", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("the question card is no longer open"));
    render([question()], submit);
    fireEvent.click(screen.getByRole("radio", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "the question card is no longer open",
    );
    expect(screen.queryByText("Answer sent")).not.toBeInTheDocument();
  });

  it("does not submit a form that has nothing in it", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render([question()], submit);
    const [other] = screen.getAllByRole("textbox");
    fireEvent.keyDown(other!, { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
  });
});
