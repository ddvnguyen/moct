import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@multica/core/api";
import type { AgentPlan } from "@multica/core/issues/ask-plan";
import { renderWithI18n } from "../../test/i18n";
import { PlanReviewPanel } from "./plan-review-panel";

vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    api: {
      addPlanComment: vi.fn(),
      resolvePlanComment: vi.fn(),
      reviewPlan: vi.fn(),
      writePlanSection: vi.fn(),
      listPlanSectionVersions: vi.fn(),
    },
  };
});
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: () => "Ada",
    hasActor: () => true,
  }),
}));
vi.mock("../../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => <p>{content}</p>,
}));

const PLAN: AgentPlan = {
  id: "plan-4",
  issue_id: "issue-3",
  task_id: "task-7",
  title: "Split the cutover",
  status: "in_review",
  revision: 6,
  submitted_revision: 6,
  sections: [
    { sectionId: "s1", heading: "Scope", markdown: "Two lanes, z first." },
    { sectionId: "s2", heading: "Rollout", markdown: "" },
  ],
  comments: [],
};

const COMMENTED: AgentPlan = {
  ...PLAN,
  comments: [
    {
      id: "comment-root",
      plan_id: "plan-4",
      section_id: "s1",
      quote: "Two lanes, z first.",
      body: "Start with the smaller lane.",
      parent_comment_id: null,
      author_user_id: "member-1",
      created_at: "2026-11-07T10:00:00Z",
    },
    {
      id: "comment-reply",
      plan_id: "plan-4",
      section_id: "s1",
      quote: "",
      body: "Agreed, z first.",
      parent_comment_id: "comment-root",
      author_user_id: "member-1",
      created_at: "2026-11-07T10:05:00Z",
    },
  ],
};

function renderPanel(plan: AgentPlan = PLAN) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = renderWithI18n(
    <QueryClientProvider client={client}>
      <PlanReviewPanel plan={plan} issueId="issue-3" />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** Select a section's rendered text the way a member drags over it. */
function selectPassage(sectionId: string): void {
  const body = document.querySelector(
    `[data-plan-section="${sectionId}"] [data-plan-section-body]`,
  );
  const target = body?.querySelector("p") ?? body;
  if (target === null || target === undefined) throw new Error("no section body");
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = window.getSelection();
  if (selection === null) throw new Error("no selection");
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PlanReviewPanel", () => {
  it("turns a selected passage into an anchored comment", async () => {
    vi.mocked(api.addPlanComment).mockResolvedValue({ comment: COMMENTED.comments![0]! });
    renderPanel();

    expect(await screen.findByText("Split the cutover")).toBeInTheDocument();
    selectPassage("s1");

    expect(await screen.findByText("“Two lanes, z first.”")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "What should change here?" }), {
      target: { value: "Start with the smaller lane." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect(api.addPlanComment).toHaveBeenCalledWith("ws-1", "plan-4", {
        base_revision: 6,
        section_id: "s1",
        quote: "Two lanes, z first.",
        body: "Start with the smaller lane.",
      }),
    );
  });

  it("threads a reply under its root and resolves the thread", async () => {
    vi.mocked(api.addPlanComment).mockResolvedValue({ comment: COMMENTED.comments![1]! });
    vi.mocked(api.resolvePlanComment).mockResolvedValue({
      comment: { ...COMMENTED.comments![0]!, resolved_at: "2026-11-07T11:00:00Z" },
    });
    renderPanel(COMMENTED);

    expect(await screen.findByText("Start with the smaller lane.")).toBeInTheDocument();
    // The reply renders in the same thread, indented under its root.
    expect(screen.getByText("Agreed, z first.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reply to this comment" }), {
      target: { value: "Then the bigger one." },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Reply to this comment" }), {
      key: "Enter",
    });

    await waitFor(() =>
      expect(api.addPlanComment).toHaveBeenCalledWith("ws-1", "plan-4", {
        base_revision: 6,
        section_id: "s1",
        quote: "Two lanes, z first.",
        body: "Then the bigger one.",
        parent_comment_id: "comment-root",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(api.resolvePlanComment).toHaveBeenCalledWith(
        "ws-1",
        "plan-4",
        "comment-root",
      ),
    );
  });

  it("reports a stale revision instead of claiming the comment landed", async () => {
    vi.mocked(api.addPlanComment).mockRejectedValue(
      new ApiError("plan changed since this revision", 409, "Conflict"),
    );
    const onRejected = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    renderWithI18n(
      <QueryClientProvider client={client}>
        <PlanReviewPanel plan={PLAN} issueId="issue-3" onRejected={onRejected} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Split the cutover")).toBeInTheDocument();
    selectPassage("s1");
    fireEvent.change(screen.getByRole("textbox", { name: "What should change here?" }), {
      target: { value: "Start with the smaller lane." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "The plan moved since you opened it.",
    );
    expect(onRejected).toHaveBeenCalled();
    // The draft stays so the member can re-send it on the new revision.
    expect(screen.getByRole("textbox", { name: "What should change here?" })).toHaveValue(
      "Start with the smaller lane.",
    );
  });

  it("shows every quote in the rail when the highlight API is unavailable", async () => {
    renderPanel(COMMENTED);
    expect(await screen.findByText("Start with the smaller lane.")).toBeInTheDocument();
    // jsdom has no CSS Custom Highlight API: the paint is skipped, the quote
    // is still readable in the rail's blockquote.
    const quotes = Array.from(document.querySelectorAll("blockquote")).map(
      (node) => node.textContent,
    );
    expect(quotes).toContain("Two lanes, z first.");
    expect(screen.getByText("Start with the smaller lane.")).toBeInTheDocument();
  });

  it("saves a section edit fenced on the page's revision", async () => {
    vi.mocked(api.writePlanSection).mockResolvedValue({ ...PLAN, revision: 7 });
    renderPanel();

    expect(await screen.findByText("Split the cutover")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit section Scope" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Section text" }), {
      target: { value: "Two lanes, z first, then web." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save section" }));

    await waitFor(() =>
      expect(api.writePlanSection).toHaveBeenCalledWith("ws-1", "plan-4", "s1", {
        base_revision: 6,
        heading: "Scope",
        markdown: "Two lanes, z first, then web.",
      }),
    );
  });

  it("keeps request changes back until a passage comment is waiting", async () => {
    renderPanel(COMMENTED);
    expect(await screen.findByText("Start with the smaller lane.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeEnabled();
  });
});
