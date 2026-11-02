import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRef, type MemoryRecord } from "../src/client/moct-memory";
import type { Agent } from "@multica/core/types";
import {
  AgentMemoryTab,
  agentListPath,
  createAgentMemorySections,
  pendingListPath,
} from "../src/client/moct-agent-memory";
import type { MoctConnection } from "../src/client/moct-seam";

/**
 * The agent Memory tab, driven the way the agent pane mounts it: over a
 * stubbed `/moct` seam and a stubbed Multica API, with moct-be's own answer —
 * never a local guess — deciding what the reader sees next.
 *
 * The narrowing (M-125's hard condition) is asserted where it lives: a record
 * that does not name this agent may not render, not even transiently, and the
 * read that finds a tag-only pending write has no home filter at moct.
 *
 * Rows are addressed by their `data-agent-pending` / `data-agent-record` ids,
 * and groups by `data-agent-record-group`, because one record may legitimately
 * appear twice — waiting in the queue and filed in the ledger, which shows
 * every status.
 */

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const CONNECTION: MoctConnection = {
  workspaceSlug: "demo",
  workspaceId: WORKSPACE_ID,
  wsPath: "/multica/ws",
  workspaceFolder: "",
  problem: null,
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Responder = (call: Call) => { body: unknown; status?: number };

/** A responder that answers the same body every time. */
function ok(body: unknown): Responder {
  return () => ({ body });
}

/**
 * Stub the transport by `METHOD path`, with the query ignored: the assertions
 * that care about a query read it off the recorded call instead.
 */
function stubSeam(routes: Record<string, Responder>) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const call: Call = { url, method, body };
    calls.push(call);
    const path = url.split("?")[0] ?? url;
    const responder = routes[`${method} ${path}`];
    if (responder === undefined) {
      return json({ ok: false, error: `no stub for ${method} ${path}` }, 404);
    }
    const answer = responder(call);
    return json(answer.body, answer.status ?? 200);
  });
}

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

/** The one queue row a record is waiting in: null once it is not waiting. */
const pendingRow = (id: string) => document.querySelector(`[data-agent-pending="${id}"]`);
/** The one ledger row a record is filed in. */
const ledgerRow = (id: string) => document.querySelector(`[data-agent-record="${id}"]`);
/** The one group card a record type is filed under. */
const recordGroup = (type: string) => document.querySelector(`[data-agent-record-group="${type}"]`);

/** One record as moct sends it, with the fields a test does not care about defaulted. */
function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_1",
    workspaceId: "multica:ws:" + WORKSPACE_ID,
    type: "rule",
    title: "Always run the package suite",
    body: "Run the package suite before pushing.",
    attrs: null,
    home: { kind: "expert", ref: agentRef(AGENT_ID) },
    tags: [{ kind: "expert", ref: agentRef(AGENT_ID) }],
    priority: 0,
    pinned: false,
    status: "pending",
    flag: null,
    supersedes: null,
    supersededBy: null,
    conflictsWith: [],
    taskRef: null,
    authorKind: "member",
    authorId: agentRef(AGENT_ID),
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    lastUsedAt: null,
    useCount: 0,
    version: 1,
    tokens: 12,
    ...overrides,
  };
}

/**
 * The seam's store: pending writes the queue read finds, agent-homed records
 * the ledger read finds, and another agent's rows both reads must not show.
 */
function store() {
  const records: Record<string, MemoryRecord> = {
    // The agent's own pending rule: homed on it, tagged to it, written by it.
    mem_pending_agent: record({
      id: "mem_pending_agent",
      title: "Run the lane suite before pushing",
      status: "pending",
      tokens: 12,
    }),
    // A pending rule that only tags the agent from an issue home: the queue
    // read has no home filter, so this must still surface.
    mem_pending_tagged: record({
      id: "mem_pending_tagged",
      title: "Tag-only convention from an issue",
      type: "convention",
      home: { kind: "task", ref: "multica:issue:44444444-4444-4444-8444-444444444444" },
      tags: [
        { kind: "task", ref: "multica:issue:44444444-4444-4444-8444-444444444444" },
        { kind: "expert", ref: agentRef(AGENT_ID) },
      ],
      status: "pending",
      tokens: 8,
    }),
    // Another agent's pending write: the hard condition — never rendered.
    mem_pending_other: record({
      id: "mem_pending_other",
      title: "Another agent's pending rule",
      home: { kind: "expert", ref: agentRef(OTHER_AGENT_ID) },
      tags: [{ kind: "expert", ref: agentRef(OTHER_AGENT_ID) }],
      authorId: agentRef(OTHER_AGENT_ID),
      status: "pending",
      tokens: 9,
    }),
    // The agent's decided records, homed on it.
    mem_rule_active: record({
      id: "mem_rule_active",
      title: "Lane z keeps its own database",
      status: "active",
      tokens: 30,
      version: 3,
    }),
    mem_odd_active: record({
      id: "mem_odd_active",
      title: "A type this build has never heard of",
      type: "zeta_custom",
      status: "active",
      tokens: 5,
    }),
    // Another agent's decided record: narrowed out of the ledger too.
    mem_rule_other: record({
      id: "mem_rule_other",
      title: "Review the diff before merging",
      home: { kind: "expert", ref: agentRef(OTHER_AGENT_ID) },
      tags: [{ kind: "expert", ref: agentRef(OTHER_AGENT_ID) }],
      authorId: agentRef(OTHER_AGENT_ID),
      status: "active",
      tokens: 31,
    }),
  };

  function page(status: string, home: string | null, cursor: string | null) {
    const matches = Object.values(records).filter(
      (entry) =>
        (status === "all" || entry.status === status) && (home === null || entry.home.kind === home),
    );
    return {
      results: matches.slice(Number(cursor ?? "0")),
      total: matches.length,
      nextCursor: null,
    };
  }

  return {
    records,
    decide(id: string, verb: "approve" | "retract", call: Call) {
      const entry = records[id];
      if (entry === undefined) return { status: 404, body: { ok: false, error: "no such record" } };
      const baseVersion = (call.body as { baseVersion?: unknown } | null)?.baseVersion;
      if (baseVersion !== entry.version) {
        return { status: 409, body: { ok: false, error: "record changed underneath you" } };
      }
      const decided: MemoryRecord = {
        ...entry,
        status: verb === "approve" ? "active" : "retracted",
        version: entry.version + 1,
        updatedAt: "2026-10-28T09:00:00.000Z",
      };
      records[id] = decided;
      return { body: decided };
    },
    pendingPage: (cursor: string | null) => page("pending", null, cursor),
    ledgerPage: (cursor: string | null) => page("all", "expert", cursor),
  };
}

function routes(seam: ReturnType<typeof store>): Record<string, Responder> {
  return {
    "GET /moct/team/v1/memory/usage": ok({
      capTokens: 500,
      homes: [{ home: "team:demo", usedTokens: 640, records: 3, blockedPending: 0, largest: [] }],
    }),
    "GET /multica/api/agents": ok([
      { id: AGENT_ID, name: "Claude" },
      { id: OTHER_AGENT_ID, name: "DeepSeek" },
    ]),
    "GET /multica/api/projects": ok([{ id: "p1", title: "Memory plane" }]),
    "GET /moct/team/v1/memory": (call) => {
      const query = new URLSearchParams(call.url.split("?")[1]);
      if (query.get("status") === "pending") return { body: seam.pendingPage(query.get("cursor")) };
      if (query.get("status") === "all" && query.get("homes") === "expert") {
        return { body: seam.ledgerPage(query.get("cursor")) };
      }
      return { status: 400, body: { ok: false, error: `unexpected read ${call.url}` } };
    },
    "POST /moct/team/v1/memory/mem_pending_agent/approve": (call) =>
      seam.decide("mem_pending_agent", "approve", call),
    "POST /moct/team/v1/memory/mem_pending_agent/retract": (call) =>
      seam.decide("mem_pending_agent", "retract", call),
    "POST /moct/team/v1/memory/mem_pending_tagged/retract": (call) =>
      seam.decide("mem_pending_tagged", "retract", call),
  };
}

function renderTab(connection: MoctConnection = CONNECTION) {
  return render(<AgentMemoryTab agentId={AGENT_ID} connection={connection} />);
}

/** The list reads the tab made once it has settled, queries as sent. */
async function listReads(): Promise<URLSearchParams[]> {
  await waitFor(() => {
    expect(calls.filter((call) => call.url.startsWith("/moct/team/v1/memory?")).length).toBeGreaterThan(0);
  });
  return calls
    .filter((call) => call.url.startsWith("/moct/team/v1/memory?"))
    .map((call) => new URLSearchParams(call.url.split("?")[1] ?? ""));
}

describe("paths the tab reads", () => {
  it("queues with no home filter and ledgers with expert homes", () => {
    expect(pendingListPath(null)).toBe("/moct/team/v1/memory?limit=20&status=pending");
    const ledger = new URLSearchParams(agentListPath(null).split("?")[1]);
    expect(ledger.get("status")).toBe("all");
    expect(ledger.get("homes")).toBe("expert");
    // The agent narrowing is the page's own: moct never sees it.
    expect(ledger.get("agent")).toBeNull();
  });

  it("hands one section to the pane, beside Settings, labelled Memory", () => {
    const sections = createAgentMemorySections(CONNECTION);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.id).toBe("memory");
    expect(sections[0]?.label).toBe("Memory");
    expect(sections[0]?.render({ id: AGENT_ID } as Agent)).toMatchObject({
      props: { agentId: AGENT_ID, connection: CONNECTION },
    });
  });
});

describe("the tab on a wired plane", () => {
  it("narrows the queue to this agent and shows nothing of another agent's", async () => {
    const seam = store();
    stubSeam(routes(seam));
    renderTab();

    // The agent's own pending writes, including the tag-only one, are the queue.
    await waitFor(() => expect(pendingRow("mem_pending_agent")).not.toBeNull());
    expect(pendingRow("mem_pending_tagged")).not.toBeNull();
    // The hard condition: another agent's pending write never renders.
    expect(pendingRow("mem_pending_other")).toBeNull();
    // And the ledger never shows another agent's decided record either.
    expect(ledgerRow("mem_rule_other")).toBeNull();

    const reads = await listReads();
    const queued = reads.find((read) => read.get("status") === "pending");
    expect(queued).toBeDefined();
    // No homes filter: a tag-only pending write must be reachable at moct.
    expect(queued?.get("homes")).toBeNull();
    const ledgerRead = reads.find((read) => read.get("status") === "all");
    expect(ledgerRead?.get("homes")).toBe("expert");
    // Neither read asks moct to narrow by agent; the page does that itself.
    for (const read of reads) {
      expect(read.get("agent")).toBeNull();
    }
  });

  it("groups the agent's records by type, unknown types shown as sent, with honest counts", async () => {
    const seam = store();
    stubSeam(routes(seam));
    renderTab();

    await screen.findByText("3 of the 5 records loaded (5 in total)");
    // moct's vocabulary first; an unknown type is shown as it was sent.
    expect(recordGroup("rule")).not.toBeNull();
    expect(recordGroup("zeta_custom")).not.toBeNull();
    expect(recordGroup("convention")).toBeNull(); // tag-only pending write is queue-only
    // The decided ledger: rule has the pending rule and the decided one…
    expect(recordGroup("rule")?.textContent).toContain("2 records");
    // …and the unknown type its single member.
    expect(recordGroup("zeta_custom")?.textContent).toContain("1 record");
    // The agent's decided records are filed, whatever their status.
    expect(ledgerRow("mem_rule_active")).not.toBeNull();
    expect(ledgerRow("mem_odd_active")).not.toBeNull();
  });

  it("derives the loaded spend and pairs it with moct's cap", async () => {
    const seam = store();
    stubSeam(routes(seam));
    renderTab();

    await screen.findByText("3 of the 5 records loaded (5 in total)");
    // Queue 12 + 8; ledger 12 + 30 + 5. Another agent's rows stay out.
    expect(screen.getByText("67 tokens")).toBeInTheDocument();
    // The cap is the seam's answer, not a local figure.
    expect(screen.getByText("500 tokens")).toBeInTheDocument();
    // And it says what the spend is made of, honestly.
    expect(screen.getByText("2 pending · 3 filed, narrowed to this agent")).toBeInTheDocument();
  });

  it("approves with the version it was shown and moves the record out of the queue", async () => {
    const seam = store();
    stubSeam(routes(seam));
    renderTab();

    await waitFor(() => expect(pendingRow("mem_pending_agent")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Approve Run the lane suite before pushing" }));

    expect(
      await screen.findByText("Approved. Run the lane suite before pushing injects from here on."),
    ).toBeInTheDocument();
    // Decided: the queue is for waiting records, so the row moves on — into
    // the ledger, which shows every status, not into silence.
    await waitFor(() => expect(pendingRow("mem_pending_agent")).toBeNull());
    expect(ledgerRow("mem_pending_agent")).not.toBeNull();

    const decisions = calls.filter((call) => call.url.endsWith("/mem_pending_agent/approve"));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.body).toEqual({ baseVersion: 1 });
  });

  it("rejects are retractions through the seam, and they leave the queue too", async () => {
    const seam = store();
    stubSeam(routes(seam));
    renderTab();

    await waitFor(() => expect(pendingRow("mem_pending_tagged")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Reject Tag-only convention from an issue" }));

    expect(
      await screen.findByText(
        "Rejected. Tag-only convention from an issue stays in the store and does not inject.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(pendingRow("mem_pending_tagged")).toBeNull());
    const decisions = calls.filter((call) => call.url.endsWith("/mem_pending_tagged/retract"));
    expect(decisions).toHaveLength(1);
  });

  it("refuses to decide on a record that moved underneath, and keeps the row readable", async () => {
    const seam = store();
    stubSeam({
      ...routes(seam),
      // By the time the reader clicks, the record's version no longer matches
      // what the tab was shown: moct-be's 409 is the page's answer.
      "POST /moct/team/v1/memory/mem_pending_agent/approve": () => ({
        status: 409,
        body: { ok: false, error: "record changed underneath you" },
      }),
    });
    renderTab();

    await waitFor(() => expect(pendingRow("mem_pending_agent")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Approve Run the lane suite before pushing" }));

    expect(
      await screen.findByText(/Run the lane suite before pushing: record changed underneath you/),
    ).toBeInTheDocument();
    // A stale row stays readable — a refresh is the fix, not a silent vanish.
    expect(pendingRow("mem_pending_agent")).not.toBeNull();
  });

  it("says so when nothing pending names the agent, and keeps the ledger count", async () => {
    const seam = store();
    // Everything decided, so the queue is genuinely empty.
    for (const key of Object.keys(seam.records)) {
      seam.records[key] = { ...seam.records[key]!, status: "active" };
    }
    stubSeam(routes(seam));
    renderTab();

    expect(await screen.findByText("Nothing is waiting for approval.")).toBeInTheDocument();
    // The ledger is untouched by the queue's emptiness.
    await waitFor(() => expect(ledgerRow("mem_rule_active")).not.toBeNull());
    expect(screen.getByText("3 of the 5 records loaded (5 in total)")).toBeInTheDocument();
  });

  it("shows a cross-agent answer as absent, not as silence, and never leaks the other rows", async () => {
    const seam = store();
    // Pending writes exist at moct, but all of them belong to the other agent.
    for (const key of Object.keys(seam.records)) {
      if (key !== "mem_pending_other") {
        seam.records[key] = { ...seam.records[key]!, status: "active" };
      }
    }
    stubSeam(routes(seam));
    renderTab();

    expect(
      await screen.findByText("No pending record on the loaded pages names this agent."),
    ).toBeInTheDocument();
    // The other agent's row is still not rendered — the absence is stated, not leaked.
    expect(pendingRow("mem_pending_other")).toBeNull();
  });
});

describe("the tab on an unwired plane", () => {
  it("shows the reason instead of rendering an empty picture as the truth", async () => {
    stubSeam({});
    renderTab({ ...CONNECTION, problem: "moctUrl is not set" });

    expect(screen.getByText("moctUrl is not set")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The memory plane is not wired to this panel, so this agent's records cannot be read here.",
      ),
    ).toBeInTheDocument();
    // Nothing is waiting on a plane that does not exist.
    expect(screen.queryByText("Nothing is waiting for approval.")).not.toBeInTheDocument();
    // No memory read left home on a plane the panel cannot reach.
    await waitFor(() => {
      expect(calls.every((call) => call.url.startsWith("/multica/api/"))).toBe(true);
    });
  });
});
