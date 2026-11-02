import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMoctGroup,
  minutesValue,
  MoctConnectionTab,
  MoctInteractionsTab,
  parseMoctInteractions,
  parseMoctMemorySettings,
  secondsFromMinutes,
} from "../src/client/moct-settings";
import type { MoctConnection } from "../src/client/moct-seam";

/**
 * The two S2-C tabs, driven the way the settings page mounts them: over a
 * stubbed fetch, with the server's answer — not a local guess — deciding what
 * the reader sees next.
 */

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION: MoctConnection = {
  workspaceSlug: "demo",
  workspaceId: WORKSPACE_ID,
  wsPath: "/multica/ws",
  workspaceFolder: "/srv/demo",
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

/**
 * Stub the transport. `answers` maps a path suffix to an answer; a function
 * answer receives the parsed request body and the method, so a route that both
 * reads and writes can be answered the way a server would — including from the
 * request it was just given.
 */
function stubApi(
  answers: Record<
    string,
    unknown | ((body: any, method: string) => { body: unknown; status?: number })
  >,
) {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const key = Object.keys(answers).find((candidate) => url.includes(candidate));
    if (key === undefined) return json({ ok: false, error: `no stub for ${url}` }, 404);
    const answer = answers[key];
    if (typeof answer === "function") {
      const result = answer(body, method);
      return json(result.body, result.status ?? 200);
    }
    return json(answer);
  });
  vi.stubGlobal("fetch", handler);
  return handler;
}

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

function memoryAnswers(overrides: Record<string, unknown> = {}) {
  return {
    "/moct/status": { ok: true, schema: 8, reachable: true },
    [`/api/workspaces/${WORKSPACE_ID}/moct`]: {
      memory_inject: false,
      memory_inject_set: true,
      editable: true,
      ...overrides,
    },
  };
}

describe("minutes and seconds", () => {
  it("renders whole minutes as integers and keeps a stray value visible", () => {
    expect(minutesValue(600)).toBe("10");
    expect(minutesValue(90)).toBe("1.5");
  });

  it("refuses an input that is not a positive number of minutes", () => {
    expect(secondsFromMinutes("15")).toBe(900);
    expect(secondsFromMinutes(" 2.5 ")).toBe(150);
    expect(secondsFromMinutes("")).toBeNull();
    expect(secondsFromMinutes("0")).toBeNull();
    expect(secondsFromMinutes("-5")).toBeNull();
    expect(secondsFromMinutes("soon")).toBeNull();
  });
});

describe("parseMoctInteractions", () => {
  it("reads the workspace default, its bounds and its overrides", () => {
    const parsed = parseMoctInteractions({
      timeout_seconds: 900,
      timeout_seconds_set: true,
      min_timeout_seconds: 60,
      max_timeout_seconds: 86400,
      editable: true,
      overrides: [
        { project_id: "p1", project_title: "Alpha", timeout_seconds: 1800 },
        { project_id: "", project_title: "nameless", timeout_seconds: 60 },
      ],
    });
    expect(parsed.timeoutSeconds).toBe(900);
    expect(parsed.timeoutSecondsSet).toBe(true);
    expect(parsed.editable).toBe(true);
    expect(parsed.overrides).toEqual([
      { projectId: "p1", projectTitle: "Alpha", timeoutSeconds: 1800 },
    ]);
  });

  it("falls back to the shipped default for a body that cannot carry a value", () => {
    const parsed = parseMoctInteractions({ timeout_seconds: 10_000_000, overrides: "nope" });
    expect(parsed.timeoutSeconds).toBe(600);
    expect(parsed.timeoutSecondsSet).toBe(false);
    expect(parsed.editable).toBe(false);
    expect(parsed.overrides).toEqual([]);
    expect(parsed.minTimeoutSeconds).toBe(60);
    expect(parsed.maxTimeoutSeconds).toBe(86400);
  });
});

describe("parseMoctMemorySettings", () => {
  it("defaults to on when the body says nothing", () => {
    expect(parseMoctMemorySettings({})).toEqual({
      memoryInject: true,
      memoryInjectSet: false,
      editable: false,
    });
  });

  it("reads an explicit off", () => {
    expect(parseMoctMemorySettings({ memory_inject: false, memory_inject_set: true, editable: true })).toEqual({
      memoryInject: false,
      memoryInjectSet: true,
      editable: true,
    });
  });
});

describe("MoctConnectionTab", () => {
  it("shows the plane's status and the stored switch", async () => {
    stubApi(memoryAnswers());
    render(<MoctConnectionTab connection={CONNECTION} />);

    await waitFor(() => expect(screen.getByText("Reachable")).toBeInTheDocument());
    expect(screen.getByText("8")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Off")).toBeInTheDocument());
    expect(screen.getByRole("switch", { name: "Inject memory into new runs" })).not.toBeChecked();
  });

  it("writes the switch and renders the server's answer, not the click", async () => {
    stubApi({
      ...memoryAnswers(),
      [`/api/workspaces/${WORKSPACE_ID}/moct`]: (body: any, method: string) =>
        method === "PUT"
          ? { body: { memory_inject: body.memory_inject, memory_inject_set: true, editable: true } }
          : { body: { memory_inject: false, memory_inject_set: true, editable: true } },
    });
    render(<MoctConnectionTab connection={CONNECTION} />);

    const toggle = await screen.findByRole("switch", { name: "Inject memory into new runs" });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByText("On")).toBeInTheDocument());
    const write = calls.find((call) => call.method === "PUT");
    expect(write?.url).toBe(`/multica/api/workspaces/${WORKSPACE_ID}/moct`);
    expect(write?.body).toEqual({ memory_inject: true });
  });

  it("keeps the stored value and explains a refusal", async () => {
    stubApi({
      ...memoryAnswers(),
      [`/api/workspaces/${WORKSPACE_ID}/moct`]: (_body: any, method: string) =>
        method === "PUT"
          ? { body: { error: "insufficient role" }, status: 403 }
          : { body: { memory_inject: false, memory_inject_set: true, editable: true } },
    });
    render(<MoctConnectionTab connection={CONNECTION} />);

    const toggle = await screen.findByRole("switch", { name: "Inject memory into new runs" });
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("insufficient role"));
    // The refused click must not flip the control: the server said no, and the
    // stored value is still off.
    expect(screen.getByText("Off")).toBeInTheDocument();
  });

  it("renders read-only for a member and says who can change it", async () => {
    stubApi(memoryAnswers({ editable: false }));
    render(<MoctConnectionTab connection={CONNECTION} />);

    const toggle = await screen.findByRole("switch", { name: "Inject memory into new runs" });
    await waitFor(() => expect(toggle).toHaveAttribute("data-disabled"));
    expect(screen.getByText("Only a workspace owner or admin can change this")).toBeInTheDocument();

    // A disabled switch must not become a write the server then refuses.
    fireEvent.click(toggle);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });
});

describe("MoctInteractionsTab", () => {
  function interactionsAnswers(overrides: Record<string, unknown> = {}) {
    return {
      [`/api/workspaces/${WORKSPACE_ID}/interactions`]: {
        timeout_seconds: 600,
        timeout_seconds_set: false,
        min_timeout_seconds: 60,
        max_timeout_seconds: 86400,
        editable: true,
        overrides: [
          { project_id: "p1", project_title: "Alpha", timeout_seconds: 1800 },
        ],
        ...overrides,
      },
      "/api/projects": {
        projects: [
          { id: "p1", title: "Alpha" },
          { id: "p2", title: "Beta" },
        ],
      },
    };
  }

  it("states the default, the bounds' unit and every override", async () => {
    stubApi(interactionsAnswers());
    render(<MoctInteractionsTab connection={CONNECTION} />);

    await waitFor(() => expect(screen.getByText("10 minutes is the default")).toBeInTheDocument());
    expect(screen.getByLabelText("Workspace ask/plan timeout in minutes")).toHaveValue("10");
    expect(screen.getByLabelText("Alpha ask/plan timeout in minutes")).toHaveValue("30");
    expect(screen.queryByText("Every project uses the workspace timeout")).not.toBeInTheDocument();
  });

  it("saves the workspace wait in seconds and re-renders the answer", async () => {
    stubApi({
      ...interactionsAnswers(),
      [`/api/workspaces/${WORKSPACE_ID}/interactions`]: (body: any, method: string) => ({
        body:
          method === "PUT"
            ? {
                timeout_seconds: body.timeout_seconds,
                timeout_seconds_set: true,
                min_timeout_seconds: 60,
                max_timeout_seconds: 86400,
                editable: true,
                overrides: [],
              }
            : {
                timeout_seconds: 600,
                timeout_seconds_set: false,
                min_timeout_seconds: 60,
                max_timeout_seconds: 86400,
                editable: true,
                overrides: [],
              },
      }),
    });
    render(<MoctInteractionsTab connection={CONNECTION} />);

    const input = await screen.findByLabelText("Workspace ask/plan timeout in minutes");
    fireEvent.change(input, { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Workspace ask/plan timeout in minutes" }));

    await waitFor(() => expect(screen.queryByText("10 minutes is the default")).not.toBeInTheDocument());
    const write = calls.find((call) => call.method === "PUT");
    expect(write?.url).toBe(`/multica/api/workspaces/${WORKSPACE_ID}/interactions`);
    expect(write?.body).toEqual({ timeout_seconds: 900 });
  });

  it("clears a project override through the project's own route", async () => {
    stubApi(interactionsAnswers());
    render(<MoctInteractionsTab connection={CONNECTION} />);

    const clear = await screen.findByRole("button", { name: "Clear the Alpha override" });
    fireEvent.click(clear);

    await waitFor(() =>
      expect(calls.some((call) => call.method === "PUT" && call.url.endsWith("/api/projects/p1/interactions"))).toBe(
        true,
      ),
    );
    const write = calls.find((call) => call.url.endsWith("/api/projects/p1/interactions"));
    expect(write?.body).toEqual({ timeout_seconds: null });
  });

  it("offers a project that has no override yet", async () => {
    stubApi(interactionsAnswers());
    render(<MoctInteractionsTab connection={CONNECTION} />);

    const trigger = await screen.findByRole("combobox", { name: "Project" });
    expect(trigger).toBeInTheDocument();
    fireEvent.click(trigger);
    // Alpha already has an override; Beta is the one a reader can add.
    await waitFor(() => expect(screen.queryByRole("option", { name: "Beta" })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: "Alpha" })).not.toBeInTheDocument();
  });

  it("renders read-only for a member without offering the picker", async () => {
    stubApi(interactionsAnswers({ editable: false }));
    render(<MoctInteractionsTab connection={CONNECTION} />);

    await waitFor(() => expect(screen.getByText("10 minutes")).toBeInTheDocument());
    expect(screen.queryByLabelText("Workspace ask/plan timeout in minutes")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Only a workspace owner or admin can change this")).toBeInTheDocument();
    expect(screen.getByText("30 minutes")).toBeInTheDocument();
  });
});

describe("createMoctGroup", () => {
  it("adds the third tab without disturbing the two S2-B ones", () => {
    const group = createMoctGroup(CONNECTION);
    expect(group.entries.map((entry) => entry.label)).toEqual([
      "Memory",
      "Connection",
      "Interactions",
    ]);
  });
});
