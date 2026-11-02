import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentRef,
  homeLabel,
  homeName,
  MEMORY_DEFAULT_FILTERS,
  type MemoryRecord,
  memoryDecisionPath,
  memoryGetPath,
  memoryListPath,
  memoryVersionsPath,
  MoctMemoryTab,
  parseMemoryGet,
  parseMemoryPage,
  parseMemoryRecord,
  parseMemoryVersions,
  statusLabel,
  typeLabel,
  visibleRecords,
} from "../src/client/moct-memory";
import type { MoctConnection } from "../src/client/moct-seam";

/**
 * The S2-D memory page, driven the way the settings page mounts it: over a
 * stubbed `/moct` seam and a stubbed Multica API, with moct-be's own answer —
 * never a local guess — deciding what the reader sees next.
 *
 * The Agent filter is exercised through `visibleRecords` rather than the fork's
 * `Select`: Base UI's picker selects on pointer events jsdom does not deliver,
 * so the row-level narrowing is asserted where it lives and the picker's
 * end-to-end behaviour is a browser concern (`e2e/moct-memory.spec.ts`).
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
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
  vi.stubGlobal("fetch", handler);
  return handler;
}

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

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

const ROUTES: Record<string, Responder> = {
  "GET /moct/status": ok({ ok: true, schema: 8, reachable: true }),
  "GET /moct/team/v1/memory/usage": ok({
    workspaceId: "multica:ws:" + WORKSPACE_ID,
    capTokens: 1200,
    injectLayerTokens: { min: 200, max: 4000 },
    homes: [{ home: "team:demo", usedTokens: 640, records: 3, blockedPending: 1, largest: [] }],
  }),
  "GET /multica/api/agents": ok([
    { id: AGENT_ID, name: "Claude" },
    { id: OTHER_AGENT_ID, name: "DeepSeek" },
  ]),
  "GET /multica/api/projects": ok([{ id: "p1", title: "Memory plane" }]),
};

describe("parsers", () => {
  it("reads a record, keeping the vocabulary moct sent", () => {
    const parsed = parseMemoryRecord({
      id: "mem_1",
      workspaceId: "multica:ws:x",
      type: "who_knows",
      title: "Title",
      body: "Body",
      attrs: { decidedBy: "human" },
      home: { kind: "expert", ref: "multica:agent:a" },
      tags: [{ kind: "expert", ref: "multica:agent:a" }, { kind: "" }],
      priority: 3,
      pinned: true,
      status: "pending",
      flag: "blocked_budget",
      conflictsWith: ["mem_2", 7],
      authorKind: "member",
      authorId: "multica:agent:a",
      createdAt: "2026-10-27T10:00:00Z",
      updatedAt: "2026-10-27T11:00:00Z",
      useCount: 2,
      version: 4,
      tokens: 20,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("who_knows");
    expect(parsed?.title).toBe("Title");
    expect(parsed?.attrs).toEqual({ decidedBy: "human" });
    expect(parsed?.tags).toEqual([{ kind: "expert", ref: "multica:agent:a" }]);
    expect(parsed?.conflictsWith).toEqual(["mem_2"]);
    expect(parsed?.flag).toBe("blocked_budget");
    expect(parsed?.version).toBe(4);
    // An absent field is not invented: no workspace, no text, no last use.
    const bare = parseMemoryRecord({ id: "mem_2", type: "rule" });
    expect(bare?.workspaceId).toBeNull();
    expect(bare?.body).toBeNull();
    expect(bare?.attrs).toBeNull();
    expect(bare?.lastUsedAt).toBeNull();
  });

  it("drops a record that cannot be addressed", () => {
    expect(parseMemoryRecord({ type: "rule" })).toBeNull();
    expect(parseMemoryRecord(null)).toBeNull();
    expect(parseMemoryPage({ results: [{ type: "rule" }, { id: "mem_2" }] }).records).toHaveLength(1);
  });

  it("reads a page, its total and its cursor", () => {
    const page = parseMemoryPage({
      results: [{ id: "mem_1" }],
      total: 21,
      nextCursor: "20",
    });
    expect(page.records.map((entry) => entry.id)).toEqual(["mem_1"]);
    expect(page.total).toBe(21);
    expect(page.nextCursor).toBe("20");
    // The last page has no cursor, and a body that is not a page is empty.
    expect(parseMemoryPage({ results: [], total: 0, nextCursor: null }).nextCursor).toBeNull();
    expect(parseMemoryPage(undefined)).toEqual({ records: [], total: 0, nextCursor: null });
  });

  it("reads a get with its links and its missing ids", () => {
    const got = parseMemoryGet({
      records: [
        {
          id: "mem_1",
          links: [
            { kind: "blocks", id: "mem_2", type: "decision", title: "Blocked" },
            { kind: "relates", id: "" },
          ],
        },
      ],
      missing: ["mem_9"],
    });
    expect(got.records[0]?.links).toEqual([
      { kind: "blocks", id: "mem_2", type: "decision", title: "Blocked" },
    ]);
    expect(got.missing).toEqual(["mem_9"]);
  });

  it("reads versions and drops a row that names no record", () => {
    const versions = parseMemoryVersions({
      versions: [
        { memoryId: "mem_1", version: 2, action: "approve", status: "active", reason: "ok" },
        { version: 1, action: "note" },
      ],
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 2, action: "approve", status: "active", reason: "ok" });
  });
});

describe("paths", () => {
  it("asks moct for the page and the filters it was given", () => {
    expect(memoryListPath(MEMORY_DEFAULT_FILTERS, null)).toBe(
      "/moct/team/v1/memory?limit=20&status=pending",
    );
    const filtered = memoryListPath(
      { q: "  card.tsx ", type: "rule", status: "all", home: "expert", agent: AGENT_ID },
      "20",
    );
    const query = new URLSearchParams(filtered.split("?")[1]);
    expect(query.get("q")).toBe("card.tsx");
    expect(query.get("types")).toBe("rule");
    expect(query.get("homes")).toBe("expert");
    expect(query.get("status")).toBe("all");
    expect(query.get("cursor")).toBe("20");
    // The agent filter is the page's own: moct never sees it.
    expect(query.get("agent")).toBeNull();
    expect(filtered.startsWith("/moct/team/v1/memory?")).toBe(true);
  });

  it("addresses one record's reads and its two decisions", () => {
    expect(memoryVersionsPath("mem_1")).toBe("/moct/team/v1/memory/mem_1/versions");
    expect(memoryGetPath()).toBe("/moct/team/v1/memory/get");
    expect(memoryDecisionPath("mem_1", "approve")).toBe("/moct/team/v1/memory/mem_1/approve");
    expect(memoryDecisionPath("mem_1", "retract")).toBe("/moct/team/v1/memory/mem_1/retract");
    expect(memoryVersionsPath("mem 1/../x")).toBe("/moct/team/v1/memory/mem%201%2F..%2Fx/versions");
  });
});

describe("labels and the agent narrowing", () => {
  it("labels the vocabulary and tells an unknown value as it is", () => {
    expect(typeLabel("how_to_work")).toBe("How to work");
    expect(typeLabel("something_new")).toBe("something_new");
    expect(statusLabel("pending")).toBe("Waiting for approval");
    expect(statusLabel("odd")).toBe("odd");
    expect(homeLabel("channel")).toBe("Project");
    expect(homeLabel("odd")).toBe("odd");
  });

  it("shows a home with the name Multica knows it by", () => {
    const directory = {
      agents: [{ id: AGENT_ID, name: "Claude" }],
      projects: [{ id: "p1", name: "Memory plane" }],
      team: "demo",
    };
    expect(homeName({ kind: "expert", ref: agentRef(AGENT_ID) }, directory)).toBe("Claude");
    expect(homeName({ kind: "channel", ref: "multica:project:p1" }, directory)).toBe("Memory plane");
    expect(homeName({ kind: "team", ref: "multica:ws:" + WORKSPACE_ID }, directory)).toBe("demo");
    // An unrecognised ref is shown by its own tail: the record stays visible.
    expect(homeName({ kind: "expert", ref: agentRef("44444444-4444-4444-8444-444444444444") }, directory)).toBe(
      "44444444",
    );
  });

  it("narrows to a record that is homed on, tagged with, or written by the agent", () => {
    const ref = agentRef(AGENT_ID);
    const homed = record({ id: "mem_home" });
    const tagged = record({
      id: "mem_tag",
      home: { kind: "team", ref: "multica:ws:" + WORKSPACE_ID },
      tags: [{ kind: "team", ref: "multica:ws:" + WORKSPACE_ID }, { kind: "expert", ref }],
      authorId: "multica:user:someone",
    });
    const written = record({
      id: "mem_written",
      home: { kind: "task", ref: "multica:issue:1" },
      tags: [],
    });
    const other = record({
      id: "mem_other",
      home: { kind: "expert", ref: agentRef(OTHER_AGENT_ID) },
      tags: [],
      authorId: agentRef(OTHER_AGENT_ID),
    });
    const all = [homed, tagged, written, other];
    expect(visibleRecords(all, "").map((entry) => entry.id)).toEqual([
      "mem_home",
      "mem_tag",
      "mem_written",
      "mem_other",
    ]);
    expect(visibleRecords(all, AGENT_ID).map((entry) => entry.id)).toEqual([
      "mem_home",
      "mem_tag",
      "mem_written",
    ]);
    expect(visibleRecords(all, OTHER_AGENT_ID).map((entry) => entry.id)).toEqual(["mem_other"]);
  });
});

describe("MoctMemoryTab", () => {
  function renderPage(routes: Record<string, Responder> = {}) {
    stubSeam({ ...ROUTES, ...routes });
    const view = render(<MoctMemoryTab connection={CONNECTION} />);
    return view;
  }

  function listCalls(): Call[] {
    return calls.filter((call) => call.url.includes("/moct/team/v1/memory?"));
  }

  it("opens on the queue that needs a human", async () => {
    renderPage({
      "GET /moct/team/v1/memory": ok({
        results: [record({ id: "mem_1" }), record({ id: "mem_2", title: "Never force-push" })],
        total: 2,
        nextCursor: null,
      }),
    });

    await waitFor(() => expect(screen.getByText("Never force-push")).toBeInTheDocument());
    // One read, of pending records, at the seam's own page size.
    expect(listCalls()).toHaveLength(1);
    const query = new URLSearchParams(listCalls()[0]!.url.split("?")[1]);
    expect(query.get("status")).toBe("pending");
    expect(query.get("limit")).toBe("20");
    expect(query.get("cursor")).toBeNull();
    expect(screen.getByText("2 of 2 records")).toBeInTheDocument();
    // S2-B's read-only view of the same plane stays above the records.
    expect(screen.getByText("Reachable")).toBeInTheDocument();
    expect(await screen.findByText("1200 tokens")).toBeInTheDocument();
    expect(screen.getByText("1 waiting for approval")).toBeInTheDocument();
  });

  it("says nothing is waiting rather than showing an empty list", async () => {
    renderPage({ "GET /moct/team/v1/memory": ok({ results: [], total: 0, nextCursor: null }) });

    expect(
      await screen.findByText("Nothing is waiting for approval. Choose All to read the whole memory."),
    ).toBeInTheDocument();
    expect(screen.getByText("0 of 0 records")).toBeInTheDocument();
  });

  it("searches moct when the reader submits, not on every keystroke", async () => {
    renderPage({
      "GET /moct/team/v1/memory": ok({
        results: [record({ id: "mem_1", title: "Suite before push" })],
        total: 1,
        nextCursor: null,
      }),
    });
    await waitFor(() => expect(screen.getByText("Suite before push")).toBeInTheDocument());
    expect(listCalls()).toHaveLength(1);

    const box = screen.getByLabelText("Search memory");
    fireEvent.change(box, { target: { value: "pu" } });
    fireEvent.change(box, { target: { value: "push" } });
    expect(listCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(new URLSearchParams(listCalls()[1]!.url.split("?")[1]).get("q")).toBe("push");
    // The status filter is still the one the reader opened the page with.
    expect(new URLSearchParams(listCalls()[1]!.url.split("?")[1]).get("status")).toBe("pending");
  });

  it("pages with the cursor and never repeats a record that moved pages", async () => {
    renderPage({
      "GET /moct/team/v1/memory": (call) => {
        const cursor = new URLSearchParams(call.url.split("?")[1]).get("cursor");
        return cursor === null
          ? { body: { results: [record({ id: "mem_1" })], total: 3, nextCursor: "1" } }
          : {
              body: {
                results: [record({ id: "mem_1" }), record({ id: "mem_3", title: "Second page" })],
                total: 3,
                nextCursor: null,
              },
            };
      },
    });

    await waitFor(() => expect(screen.getByText("1 of 3 records")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Load more records" }));
    await waitFor(() => expect(screen.getByText("Second page")).toBeInTheDocument());
    expect(new URLSearchParams(listCalls()[1]!.url.split("?")[1]).get("cursor")).toBe("1");
    // mem_1 arrived twice; the row is rendered once, and the count says so.
    expect(screen.getAllByText("Always run the package suite")).toHaveLength(1);
    expect(screen.getByText("2 of 3 records")).toBeInTheDocument();
    // The last page carries no cursor, so the control is gone.
    expect(screen.queryByRole("button", { name: "Load more records" })).not.toBeInTheDocument();
  });

  it("opens a record, reads its versions, and comes back to the list", async () => {
    renderPage({
      "GET /moct/team/v1/memory": ok({
        results: [record({ id: "mem_1" })],
        total: 1,
        nextCursor: null,
      }),
      "POST /moct/team/v1/memory/get": ok({
        records: [
          {
            ...record({ id: "mem_1" }),
            body: "Run the package suite before pushing.",
            links: [{ kind: "blocks", id: "mem_2", type: "decision", title: "Never force-push" }],
          },
        ],
        missing: [],
      }),
      "GET /moct/team/v1/memory/mem_1/versions": ok({
        versions: [
          {
            memoryId: "mem_1",
            version: 1,
            action: "note",
            type: "rule",
            home: { kind: "expert", ref: agentRef(AGENT_ID) },
            status: "pending",
            title: "Always run the package suite",
            body: null,
            actorKind: "member",
            actorId: agentRef(AGENT_ID),
            reason: "",
            at: "2026-10-27T10:00:00.000Z",
          },
        ],
      }),
    });

    await waitFor(() => expect(screen.getByText("Always run the package suite")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open Always run the package suite" }));

    await waitFor(() =>
      expect(screen.getByText("Run the package suite before pushing.")).toBeInTheDocument(),
    );
    // The reader's version is the seam's answer, read by id.
    const get = calls.find((call) => call.url === "/moct/team/v1/memory/get");
    expect(get?.method).toBe("POST");
    expect(get?.body).toEqual({ ids: ["mem_1"] });
    expect(await screen.findByText("Never force-push")).toBeInTheDocument();
    expect(await screen.findByText("v1")).toBeInTheDocument();
    expect(screen.getByText("member · multica:agent:" + AGENT_ID + " · 2026-10-27T10:00:00.000Z")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    await waitFor(() => expect(screen.getByText("1 of 1 records")).toBeInTheDocument());
  });

  it("approves a pending record as the seam's human, and follows the answer", async () => {
    renderPage({
      "GET /moct/team/v1/memory": ok({
        results: [record({ id: "mem_1" })],
        total: 1,
        nextCursor: null,
      }),
      "POST /moct/team/v1/memory/mem_1/approve": ok(record({ id: "mem_1", status: "active", version: 2 })),
    });

    await waitFor(() => expect(screen.getByText("Always run the package suite")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open Always run the package suite" }));
    const approve = await screen.findByRole("button", { name: "Approve Always run the package suite" });
    fireEvent.click(approve);

    await waitFor(() =>
      expect(screen.getByText("Approved. The record injects from here on.")).toBeInTheDocument(),
    );
    const decision = calls.find((call) => call.url === "/moct/team/v1/memory/mem_1/approve");
    expect(decision?.method).toBe("POST");
    // The version the reader was shown, and nothing the browser may not choose:
    // no workspace, no actor, no status.
    expect(decision?.body).toEqual({ baseVersion: 1 });
    // The record is no longer pending, so the decision row is gone.
    expect(screen.queryByRole("button", { name: "Approve Always run the package suite" })).not.toBeInTheDocument();
    expect(screen.getByText("version 2")).toBeInTheDocument();
    // The list's copy of the row moved with it.
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
  });

  it("rejects a pending record through the seam's retract verb", async () => {
    renderPage({
      "GET /moct/team/v1/memory": ok({
        results: [record({ id: "mem_1" })],
        total: 1,
        nextCursor: null,
      }),
      "POST /moct/team/v1/memory/mem_1/retract": ok(record({ id: "mem_1", status: "retracted", version: 2 })),
    });

    await waitFor(() => expect(screen.getByText("Always run the package suite")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open Always run the package suite" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject Always run the package suite" }));

    await waitFor(() =>
      expect(
        screen.getByText("Rejected. The record stays in the store and does not inject."),
      ).toBeInTheDocument(),
    );
    // The seam has no `reject`: the reader's rejection is moct's retraction.
    expect(calls.some((call) => call.url.endsWith("/retract"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/reject"))).toBe(false);
    // The status is said in the header and on the decision row, moct's own word.
    expect(screen.getAllByText("Retracted").length).toBeGreaterThan(0);
  });

  it("shows the server's refusal and re-reads the record it was refused for", async () => {
    renderPage({
      "GET /moct/team/v1/memory": ok({
        results: [record({ id: "mem_1" })],
        total: 1,
        nextCursor: null,
      }),
      "POST /moct/team/v1/memory/mem_1/approve": () => ({
        body: { ok: false, error: "approving memory needs a workspace owner or admin" },
        status: 403,
      }),
    });

    await waitFor(() => expect(screen.getByText("Always run the package suite")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open Always run the package suite" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve Always run the package suite" }));

    expect(
      await screen.findByText("approving memory needs a workspace owner or admin"),
    ).toBeInTheDocument();
    // The record may have moved under the reader, so its version is re-read.
    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/moct/team/v1/memory/get").length).toBeGreaterThan(1),
    );
    // Still pending: a refusal decides nothing.
    expect(screen.getAllByText("Waiting for approval").length).toBeGreaterThan(0);
  });

  it("will not offer a decision for a record that belongs to no workspace", async () => {
    renderPage({
      "GET /moct/team/v1/memory": ok({
        results: [record({ id: "mem_1", workspaceId: null })],
        total: 1,
        nextCursor: null,
      }),
    });

    await waitFor(() => expect(screen.getByText("Always run the package suite")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open Always run the package suite" }));

    expect(
      await screen.findByText(
        "This record belongs to no workspace, so it is decided where it is homed, not from here.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve Always run the package suite" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject Always run the package suite" })).not.toBeInTheDocument();
  });

  it("names the agent filter's limit instead of pretending it is moct's", async () => {
    renderPage({
      "GET /moct/team/v1/memory": ok({ results: [record({ id: "mem_1" })], total: 9, nextCursor: null }),
    });

    await waitFor(() => expect(screen.getByText("Always run the package suite")).toBeInTheDocument());
    expect(screen.getByText(/Narrows the loaded records to one agent/)).toBeInTheDocument();
    // The filter is offered with the workspace's own agents.
    fireEvent.click(screen.getByRole("combobox", { name: "Agent" }));
    expect(await screen.findByRole("option", { name: "Claude" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "DeepSeek" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Any agent" })).toBeInTheDocument();
  });

  it("reports a page that could not be read rather than an empty list", async () => {
    renderPage({
      "GET /moct/team/v1/memory": () => ({ body: { ok: false, error: "moct-be is unreachable" }, status: 502 }),
    });

    expect(await screen.findByText("moct-be is unreachable")).toBeInTheDocument();
    expect(screen.queryByText("Nothing is waiting for approval. Choose All to read the whole memory.")).not.toBeInTheDocument();
    // Retry is the reader's way back; the seam is asked again.
    fireEvent.click(screen.getByRole("button", { name: "Retry loading the records" }));
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(1));
  });
});
