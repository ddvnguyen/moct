// @vitest-environment node
import { describe, expect, it } from "vitest";
import parityCases from "./__fixtures__/agent-question-cases.json";
import type { TaskMessagePayload } from "../types/events";
import {
  agentAnswerText,
  isAgentQuestionPending,
  isAnsweredDraft,
  isPlanReview,
  latestAgentQuestion,
  parseAgentQuestions,
  planApprovalAnswer,
  type AgentQuestion,
} from "./agent-question";

const ASK: TaskMessagePayload = {
  task_id: "task",
  issue_id: "issue",
  seq: 4,
  type: "text",
  created_at: "2026-10-26T12:00:00Z",
  content: "❓ The agent needs your answer — reply to this issue mentioning the agent.",
  input: {
    questions: [
      {
        id: "q1",
        header: "Scope",
        question: "Which checkout should this land in?",
        detail: "The plan touches the payment adapter.",
        options: [
          { label: "Web", description: "The Next.js app" },
          { label: "Mobile" },
        ],
        multi_select: true,
        intent: { kind: "question", approve: "" },
      },
    ],
  },
};

const PLAN: TaskMessagePayload = {
  task_id: "task",
  issue_id: "issue",
  seq: 2,
  type: "text",
  created_at: "2026-10-26T12:00:00Z",
  content: "📋 Plan review",
  input: {
    questions: [
      {
        id: "plan",
        question: "Approve this plan?",
        detail: "1. Read the fork\n2. Wire the card",
        options: [{ label: "Approve" }, { label: "Keep planning" }],
        intent: { kind: "plan-review", approve: "Approve" },
      },
    ],
  },
};

function message(seq: number, over: Partial<TaskMessagePayload> = {}): TaskMessagePayload {
  return { task_id: "task", issue_id: "issue", seq, type: "text", ...over } as TaskMessagePayload;
}

const question: AgentQuestion = {
  id: "q1",
  question: "Which checkout?",
  options: [{ label: "Web" }, { label: "Mobile" }],
  multiSelect: false,
};

describe("parseAgentQuestions", () => {
  it("reads the question list off a transcript row", () => {
    const [parsed] = parseAgentQuestions(ASK.input);
    expect(parsed).toEqual({
      id: "q1",
      question: "Which checkout should this land in?",
      header: "Scope",
      detail: "The plan touches the payment adapter.",
      options: [{ label: "Web", description: "The Next.js app" }, { label: "Mobile" }],
      multiSelect: true,
      intent: { kind: "question", approve: "" },
    });
  });

  it("keeps a plan review's approval label", () => {
    expect(parseAgentQuestions(PLAN.input)[0]?.intent).toEqual({ kind: "plan-review", approve: "Approve" });
  });

  it("is empty for anything that is not an ask", () => {
    expect(parseAgentQuestions(undefined)).toEqual([]);
    expect(parseAgentQuestions(null)).toEqual([]);
    expect(parseAgentQuestions({ command: "pnpm test" })).toEqual([]);
    expect(parseAgentQuestions({ questions: "not a list" })).toEqual([]);
  });

  it("drops a question with no prompt but keeps its siblings", () => {
    const parsed = parseAgentQuestions({
      questions: [{ id: "empty" }, { id: "q2", question: "Which branch?" }],
    });
    expect(parsed.map((entry) => entry.id)).toEqual(["q2"]);
  });

  it("skips an option without a label rather than inventing one", () => {
    const [parsed] = parseAgentQuestions({
      questions: [{ question: "Pick", options: [{ label: "  " }, { label: "A", description: " " }] }],
    });
    expect(parsed?.options).toEqual([{ label: "A" }]);
  });
});

describe("latestAgentQuestion", () => {
  it("returns the newest ask in the transcript", () => {
    const older = message(1, { ...PLAN, seq: 1 });
    expect(latestAgentQuestion([ASK, older, message(9)])?.seq).toBe(4);
  });

  it("is null when the run never asked", () => {
    expect(latestAgentQuestion([message(1), message(2)])).toBeNull();
  });
});

describe("isAgentQuestionPending", () => {
  const ask = { seq: 4, createdAt: "2026-10-26T12:00:00Z" };

  it("is pending while the parked run has produced nothing else", () => {
    expect(isAgentQuestionPending(ask, [ASK], true)).toBe(true);
  });

  it("is not pending once the run moved on", () => {
    expect(isAgentQuestionPending(ask, [ASK, message(5)], true)).toBe(false);
  });

  it("is not pending once the member's answer was delivered", () => {
    expect(isAgentQuestionPending(ask, [ASK], true, ["2026-10-26T12:00:05Z"])).toBe(false);
    // A steer delivered before the question is unrelated to it.
    expect(isAgentQuestionPending(ask, [ASK], true, ["2026-10-26T11:59:00Z"])).toBe(true);
  });

  it("is never pending on a run that is no longer live", () => {
    expect(isAgentQuestionPending(ask, [ASK], false)).toBe(false);
  });

  it("does not treat a missing timestamp as answered", () => {
    expect(isAgentQuestionPending({ seq: 4 }, [ASK], true, ["2026-10-26T12:00:05Z"])).toBe(false);
    expect(isAgentQuestionPending({ seq: 4 }, [ASK], true)).toBe(false);
  });
});

describe("agentAnswerText", () => {
  it("sends a single pick as its own label, which is what the daemon matches", () => {
    expect(agentAnswerText([question], [{ selected: [0], text: "" }])).toBe("Web");
  });

  it("joins a multi-select in option order", () => {
    expect(agentAnswerText([question], [{ selected: [1, 0], text: "" }])).toBe("Mobile, Web");
  });

  it("carries the member's own words alone", () => {
    expect(agentAnswerText([question], [{ selected: [], text: "  Neither — use the CLI " }])).toBe("Neither — use the CLI");
  });

  it("keeps the pick in front of the words so the choice survives", () => {
    expect(agentAnswerText([question], [{ selected: [1], text: "the app only" }])).toBe("Mobile — the app only");
  });

  it("answers several questions as separate paragraphs", () => {
    const second: AgentQuestion = { ...question, id: "q2", question: "Which branch?" };
    expect(agentAnswerText([question, second], [
      { selected: [0], text: "" },
      { selected: [], text: "main" },
    ])).toBe("Web\n\nmain");
  });
});

describe("plan review", () => {
  const questions = parseAgentQuestions(PLAN.input);

  it("is recognised only when every question carries a plan intent", () => {
    expect(isPlanReview(questions)).toBe(true);
    expect(isPlanReview(parseAgentQuestions(ASK.input))).toBe(false);
    expect(isPlanReview([])).toBe(false);
  });

  it("approves with exactly the label the daemon maps onto the selection", () => {
    expect(planApprovalAnswer(questions)).toBe("Approve");
    expect(planApprovalAnswer(parseAgentQuestions(ASK.input))).toBeNull();
  });

  it("has no single approve reply when the questions disagree", () => {
    const disagreeing: AgentQuestion[] = [
      { ...questions[0]!, id: "a" },
      { ...questions[0]!, id: "b", intent: { kind: "plan-review", approve: "Ship it" } },
    ];
    expect(planApprovalAnswer(disagreeing)).toBeNull();
  });
});

describe("isAnsweredDraft", () => {
  it("needs a pick or words", () => {
    expect(isAnsweredDraft({ selected: [], text: "   " })).toBe(false);
    expect(isAnsweredDraft({ selected: [0], text: "" })).toBe(true);
    expect(isAnsweredDraft({ selected: [], text: "ok" })).toBe(true);
  });
});

// Shared with the server projection test: both sides must agree on eligibility.
describe("native decision parity", () => {
  for (const entry of parityCases) {
    it(entry.name, () => {
      const messages = entry.messages.map((m) => ({ task_id: "task", issue_id: "issue", type: "text", ...m })) as TaskMessagePayload[];
      expect(isAgentQuestionPending(latestAgentQuestion(messages), messages, entry.live, entry.delivered)).toBe(entry.pending);
    });
  }
});
