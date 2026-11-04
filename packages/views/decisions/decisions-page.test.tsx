// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { DecisionsPage } from "./decisions-page";

/**
 * The Decisions page against stubbed reads and stubbed transports.
 *
 * What this file is for is the wiring the page owns: which request is selected,
 * which source body is read, which operation answers it, and what the four
 * states (loading, error, empty, answered) look like. The sources' own contracts
 * are tested where they live — this page must not re-test `/question-cards/:id`
 * or `/plans/:id/verdict`, only that it routes to them and never invents a
 * transport for a source that has none.
 */

const apiMock = vi.hoisted(() => ({
  listDecisions: vi.fn(),
  getDecisionDetail: vi.fn(),
}));

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: apiMock,
}));

const transports = vi.hoisted(() => ({
  answer: vi.fn(async () => undefined),
  review: vi.fn(),
  supplement: vi.fn(async () => undefined),
}));

vi.mock("@multica/core/issues/mutations", () => ({
  useAnswerQuestionCard: () => ({
    mutateAsync: transports.answer,
    isPending: false,
  }),
  useReviewPlan: () => ({
    mutate: transports.review,
    isPending: false,
    variables: undefined,
  }),
  useCreateTaskSupplement: () => ({
    mutateAsync: transports.supplement,
    isPending: false,
  }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws1",
}));

// The projections store the acting member's id; the name comes from the
// workspace directory this app already reads.
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) =>
      id === "member-1" ? "Ada Lovelace" : "Unknown",
    hasActor: (_type: string, id: string) => id === "member-1",
  }),
}));

vi.mock("@multica/core/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/paths")>()),
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/acme/issues/${id}`,
  }),
}));

vi.mock("@multica/core/workspace/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/workspace/queries")>()),
  agentListOptions: (wsId: string) => ({
    queryKey: ["agents", wsId],
    queryFn: async () => [{ id: "agent-1", name: "Scout" }],
  }),
}));

vi.mock("../navigation", () => ({
  AppLink: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => (
    <div data-readonly-content={content} />
  ),
}));

function interpolate(template: string, values?: Record<string, unknown>) {
  if (!values) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    values[key] === undefined ? match : String(values[key]),
  );
}

vi.mock("../i18n", async () => {
  const decisions = (await import("../locales/en/decisions.json")).default;
  const issues = (await import("../locales/en/issues.json")).default;
  const bundles: Record<string, unknown> = { decisions, issues };
  return {
    useT: (namespace: string) => ({
      t: (
        select: (bundle: Record<string, unknown>) => string,
        values?: Record<string, unknown>,
      ) => interpolate(select(bundles[namespace] as Record<string, unknown>), values),
    }),
    useTimeAgo: () => () => "2 hours ago",
  };
});

const DECISIONS = [
  {
    kind: "question",
    source_id: "card-1",
    issue_id: "issue-1",
    issue_title: "Which store?",
    project_id: null,
    issue_revision: 3,
    agent_id: "agent-1",
    task_id: "task-1",
    question_seq: null,
    sort_at: "2026-11-03T09:00:00Z",
    requested_at: "2026-11-03T09:00:00Z",
    status: "open",
    response_id: null,
    actor_id: null,
  },
  {
    kind: "status",
    source_id: "issue-2",
    issue_id: "issue-2",
    issue_title: "Migrate the store",
    project_id: null,
    issue_revision: 12,
    agent_id: "agent-1",
    task_id: null,
    question_seq: null,
    sort_at: "2026-11-03T10:00:00Z",
    requested_at: "2026-11-03T10:00:00Z",
    status: "wait_for_decision",
    response_id: null,
    actor_id: null,
  },
  {
    kind: "plan",
    source_id: "plan-1",
    issue_id: "issue-1",
    issue_title: "Which store?",
    project_id: null,
    issue_revision: 3,
    agent_id: "agent-1",
    task_id: "task-1",
    question_seq: null,
    sort_at: "2026-11-03T11:00:00Z",
    requested_at: "2026-11-03T11:00:00Z",
    status: "in_review",
    response_id: null,
    actor_id: null,
  },
];

const DETAILS: Record<string, Record<string, unknown>> = {
  "question:card-1": {
    id: "card-1",
    issue_id: "issue-1",
    task_id: "task-1",
    agent_id: "agent-1",
    status: "open",
    context: "Picked up from the board",
    questions: [
      {
        prompt: "Which store?",
        multiple: false,
        options: [{ label: "Postgres" }, { label: "SQLite" }],
      },
    ],
  },
  "plan:plan-1": {
    plan: {
      id: "plan-1",
      issue_id: "issue-1",
      task_id: "task-1",
      title: "Ship the migration",
      status: "in_review",
      revision: 2,
      submitted_revision: 2,
      sections: [{ sectionId: "s1", heading: "Approach", markdown: "Do the thing." }],
    },
    review: null,
  },
  "status:issue-2": {
    id: "issue-2",
    title: "Migrate the store",
    description: "Waiting on the plan in the thread.",
    revision: 12,
    status: "wait_for_decision",
  },
};

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderPage(client = makeClient()) {
  const view = render(
    <QueryClientProvider client={client}>
      <DecisionsPage />
    </QueryClientProvider>,
  );
  // The list and the detail can both contain the issue title or the kind name,
  // so assertions about the selected request read the detail pane only.
  const detail = (): HTMLElement => {
    const node = view.container.querySelector<HTMLElement>("[data-decision-detail]");
    if (node === null) throw new Error("no detail pane is mounted");
    return node;
  };
  return { ...view, detail };
}

beforeEach(() => {
  apiMock.listDecisions.mockReset();
  apiMock.getDecisionDetail.mockReset();
  transports.answer.mockClear();
  transports.review.mockClear();
  transports.supplement.mockClear();
  apiMock.listDecisions.mockImplementation(async (_ws: string, params: { state?: string }) => ({
    items: params.state === "answered" ? ANSWERED : DECISIONS,
    pending_count: 3,
    next_cursor: null,
  }));
  apiMock.getDecisionDetail.mockImplementation(async (_ws: string, kind: string, sourceId: string) => {
    const detail = DETAILS[`${kind}:${sourceId}`];
    if (!detail) throw new Error("not found");
    return detail;
  });
});

const ANSWERED = [
  {
    ...DECISIONS[0],
    source_id: "card-9",
    status: "answered",
    response_id: "card-9",
    actor_id: "member-1",
    sort_at: "2026-11-03T12:00:00Z",
  },
];

describe("DecisionsPage", () => {
  it("groups the queue by issue and keeps every request as its own row", async () => {
    renderPage();
    // Two requests on "Which store?" and one handoff on "Migrate the store".
    await waitFor(() => {
      expect(screen.getAllByText("Which store?").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Migrate the store")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    const rows = screen.getAllByRole("option").map((row) => row.textContent ?? "");
    // Grouped by issue: the two requests on one issue stay together even
    // though the handoff on the other issue was asked between them.
    expect(rows[0]).toContain("Question");
    expect(rows[1]).toContain("Plan");
    expect(rows[2]).toContain("Workflow handoff");
  });

  it("selects the first request and reads its source body", async () => {
    const view = renderPage();
    await waitFor(() => expect(view.detail()).toBeTruthy());
    await waitFor(() =>
      expect(within(view.detail()).getByText("Picked up from the board")).toBeTruthy(),
    );
    // The selected row's body is the card's own question form.
    expect(within(view.detail()).getAllByText(/Which store\?/).length).toBeGreaterThan(0);
    expect(apiMock.getDecisionDetail).toHaveBeenCalledWith("ws1", "question", "card-1");
  });

  it("answers a question card through the card's own operation", async () => {
    const view = renderPage();
    await waitFor(() =>
      expect(within(view.detail()).getByText("Picked up from the board")).toBeTruthy(),
    );
    fireEvent.change(within(view.detail()).getByRole("textbox"), {
      target: { value: "Postgres, please" },
    });
    fireEvent.click(within(view.detail()).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(transports.answer).toHaveBeenCalledTimes(1));
    expect(transports.answer).toHaveBeenCalledWith({
      cardId: "card-1",
      answers: [{ selected: [], text: "Postgres, please" }],
    });
  });

  it("offers a verdict for a plan and records it on the plan endpoint", async () => {
    const view = renderPage();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    fireEvent.click(screen.getAllByRole("option")[1]!);
    await waitFor(() =>
      expect(within(view.detail()).getByText("Ship the migration")).toBeTruthy(),
    );
    fireEvent.click(within(view.detail()).getByRole("button", { name: "Approve plan" }));
    await waitFor(() => expect(transports.review).toHaveBeenCalledTimes(1));
    const [variables] = transports.review.mock.calls[0] as unknown as [
      { planId: string; verdict: { verdict: string; revision: number } },
    ];
    expect(variables.planId).toBe("plan-1");
    expect(variables.verdict.verdict).toBe("approve");
    // The fence is the submitted revision, not the plan's working revision.
    expect(variables.verdict.revision).toBe(2);
  });

  it("shows a status handoff read-only, with the way to its issue", async () => {
    const view = renderPage();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    fireEvent.click(screen.getAllByRole("option")[2]!);
    await waitFor(() =>
      expect(within(view.detail()).getByText("Waiting on a workflow decision")).toBeTruthy(),
    );
    expect(
      within(view.detail())
        .getAllByRole("link", { name: "Open issue" })
        .some((link) => link.getAttribute("href") === "/acme/issues/issue-2"),
    ).toBe(true);
    // No answer operation exists for this source yet: there is no form to press.
    expect(within(view.detail()).queryByRole("button", { name: "Answer" })).toBeNull();
    expect(within(view.detail()).queryByRole("button", { name: "Approve plan" })).toBeNull();
  });

  it("shows recorded answers read-only on the Answered tab", async () => {
    apiMock.getDecisionDetail.mockImplementation(async () => ({
      ...DETAILS["question:card-1"],
      status: "answered",
      answers: [{ selected: [0], text: "Postgres, please" }],
      answered_by: "member-1",
      answered_at: "2026-11-03T12:00:00Z",
    }));
    renderPage();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    fireEvent.click(screen.getByRole("tab", { name: /Answered/ }));
    await waitFor(() => expect(screen.getByText("Postgres, please")).toBeTruthy());
    // Actor and time come with the stored answer, not just the text.
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(
      screen.getByText(
        "Recorded answers are read-only. A new request arrives as its own row.",
      ),
    ).toBeTruthy();
  });

  it("answers a native ask through the parked turn, and shows its receipt", async () => {
    apiMock.listDecisions.mockResolvedValue({
      items: [
        {
          ...DECISIONS[0],
          kind: "native",
          source_id: "task-1:42",
          issue_title: "Wire the bridge",
          task_id: "task-1",
          question_seq: 42,
          status: "open",
        },
      ],
      pending_count: 1,
      next_cursor: null,
    });
    apiMock.getDecisionDetail.mockResolvedValue({
      task_id: "task-1",
      message: {
        seq: 42,
        created_at: "2026-11-03T09:00:00Z",
        content: "The agent asked which runtime to use.",
        input: {
          questions: [
            {
              question: "Which runtime?",
              options: [{ label: "dsh" }, { label: "local" }],
            },
          ],
        },
      },
    });
    const view = renderPage();
    await waitFor(() =>
      expect(within(view.detail()).getByText("Which runtime?")).toBeTruthy(),
    );
    fireEvent.click(within(view.detail()).getByRole("radio", { name: /dsh/ }));
    fireEvent.click(within(view.detail()).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(transports.supplement).toHaveBeenCalledTimes(1));
    // The transcript's own route: the answer reaches the running turn as a
    // supplement, never a second write path the queue invents for it.
    expect(transports.supplement).toHaveBeenCalledWith({ taskId: "task-1", content: "dsh" });
    expect(transports.answer).not.toHaveBeenCalled();
    await waitFor(() => expect(within(view.detail()).getByText("Answer sent")).toBeTruthy());
  });

  it("keeps a question draft and the server's reason when the answer is refused", async () => {
    transports.answer.mockRejectedValueOnce(new Error("the question card is no longer open"));
    const view = renderPage();
    await waitFor(() =>
      expect(within(view.detail()).getByText("Picked up from the board")).toBeTruthy(),
    );
    fireEvent.change(within(view.detail()).getByRole("textbox"), {
      target: { value: "SQLite" },
    });
    fireEvent.click(within(view.detail()).getByRole("button", { name: "Answer" }));
    await waitFor(() =>
      expect(within(view.detail()).getByRole("alert").textContent).toBe(
        "the question card is no longer open",
      ),
    );
    // A refused answer is not a lost one: the member re-sends what they wrote.
    expect(
      (within(view.detail()).getByRole("textbox") as HTMLTextAreaElement).value,
    ).toBe("SQLite");
    expect(
      within(view.detail()).getByRole("button", { name: "Answer" }),
    ).not.toHaveProperty("disabled", true);
  });

  it("re-reads the queue when a plan verdict loses its fence", async () => {
    transports.review.mockImplementationOnce(
      (_variables: unknown, options?: { onError?: (cause: Error) => void }) => {
        options?.onError?.(new Error("the plan moved to another revision"));
      },
    );
    const view = renderPage();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    fireEvent.click(screen.getAllByRole("option")[1]!);
    await waitFor(() =>
      expect(within(view.detail()).getByText("Ship the migration")).toBeTruthy(),
    );
    const reads = apiMock.getDecisionDetail.mock.calls.length;
    fireEvent.click(within(view.detail()).getByRole("button", { name: "Approve plan" }));
    await waitFor(() =>
      expect(within(view.detail()).getByText("the plan moved to another revision")).toBeTruthy(),
    );
    // A 409 says the row on screen is stale, so the page has to ask again.
    await waitFor(() =>
      expect(apiMock.getDecisionDetail.mock.calls.length).toBeGreaterThan(reads),
    );
  });

  it("shows a recorded verdict and its comments read-only", async () => {
    apiMock.listDecisions.mockImplementation(
      async (_ws: string, params: { state?: string }) => ({
        items:
          params.state === "answered"
            ? [{ ...DECISIONS[2], status: "approved", response_id: "review-1", actor_id: "member-1" }]
            : DECISIONS,
        pending_count: 2,
        next_cursor: null,
      }),
    );
    apiMock.getDecisionDetail.mockResolvedValue({
      plan: {
        id: "plan-1",
        issue_id: "issue-1",
        task_id: "task-1",
        title: "Ship the migration",
        status: "approved",
        revision: 2,
        submitted_revision: 2,
        sections: [{ sectionId: "s1", heading: "Approach", markdown: "Do the thing." }],
        approved_by: "member-1",
      },
      review: {
        id: "review-1",
        verdict: "approve",
        comments: ["Ship it"],
        reviewed_by: "member-1",
        reviewed_at: "2026-11-03T12:00:00Z",
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    fireEvent.click(screen.getByRole("tab", { name: /Answered/ }));
    await waitFor(() => expect(screen.getByText("Ship it")).toBeTruthy());
    expect(screen.getByText(/Ada Lovelace/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
  });

  it("renders a failed read as an error with a retry, never as an empty queue", async () => {
    apiMock.listDecisions.mockRejectedValue(new Error("boom"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Decisions could not be loaded")).toBeTruthy(),
    );
    expect(screen.queryByText("Nothing waiting")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Retry/ }).length).toBeGreaterThan(0);
  });
});
