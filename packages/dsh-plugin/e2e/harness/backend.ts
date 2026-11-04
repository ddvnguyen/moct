/**
 * The `/multica` backend stub every harness page runs against.
 *
 * The island talks to the host's proxy path, so a harness page replaces
 * `window.fetch` with this and lets the production client, query cache and
 * pages run unchanged. It lives in one module because three harness pages now
 * need the same answers — the keep-alive page (M-130, M-146) and the
 * route-driven page the smoke/locale/zoom specs open (M-154) — and two copies
 * would drift.
 *
 * Shapes matter more than contents: a page that reads `.issues.map` breaks on
 * `{}` even though the empty state would have been fine, so each endpoint
 * answers with the envelope its client parses.
 */

export const WORKSPACE = {
  id: "ws-1",
  slug: "demo",
  name: "Demo",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const ISSUE_TITLES = [
  "Rail click stays warm",
  "Detached DOM sizing",
  "Overlays close on leave",
];

function issue(index: number) {
  return {
    id: `11111111-1111-4111-8111-11111111111${index}`,
    workspace_id: "ws-1",
    number: index,
    identifier: `MUL-${index}`,
    title: ISSUE_TITLES[index - 1] ?? `Issue ${index}`,
    description: null,
    status: "todo",
    priority: "medium",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    project_id: null,
    position: index * 1000,
    stage: null,
    start_date: null,
    due_date: null,
    metadata: {},
    properties: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** One row of the workspace's status catalog: the board's columns. */
function status(key: string, name: string, category: string, position: number) {
  return {
    id: `status-${key}`,
    workspace_id: "ws-1",
    key,
    name,
    description: "",
    category,
    color: "#6b7280",
    icon: null,
    is_system: true,
    position,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function inboxItem(index: number) {
  return {
    id: `inbox-${index}`,
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "user-1",
    type: "new_comment",
    severity: "info",
    issue_id: issue(index).id,
    title: `Inbox row ${index}`,
    body: null,
    read: false,
    archived: false,
    created_at: "2026-01-01T00:00:00Z",
  };
}

/** The one agent every agent surface addresses. */
const AGENT = {
  id: "agent-1",
  workspace_id: "ws-1",
  runtime_id: "runtime-1",
  runtime_bound: true,
  name: "Ada",
  description: "Test agent",
  instructions: "Be useful.",
  avatar_url: null,
  runtime_mode: "auto",
  runtime_config: {},
  custom_args: [],
  has_custom_env: false,
  custom_env_key_count: 0,
  mcp_config: null,
  skills: [],
  visibility: "workspace",
  permission_mode: "workspace",
  invocation_targets: [],
  status: "idle",
  // The agents list defaults to the "mine" scope, so the row only renders when
  // the agent belongs to the signed-in member (`/api/me` → user-1).
  owner_id: "user-1",
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

/** `MemberWithUser` is flat: the user's fields sit on the membership row. */
const MEMBER = {
  id: "member-1",
  workspace_id: "ws-1",
  user_id: "user-1",
  role: "owner",
  name: "Ada",
  email: "ada@example.test",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00Z",
};

const SKILL = {
  id: "skill-1",
  workspace_id: "ws-1",
  name: "Release notes",
  description: "Writes the release notes.",
  source: "manual",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

export interface BackendOptions {
  workspaces?: unknown[];
  /** A boot problem the island renders instead of the app. */
  problem?: string | null;
  /** The folder the "All projects" default addresses (M-159); empty means none. */
  workspaceFolder?: string;
}

declare global {
  interface Window {
    /** Every `/multica` call the island makes, so a spec can inspect them. */
    __requests?: string[];
  }
}

export function installBackend(options: BackendOptions = {}): void {
  const requests: string[] = [];
  window.__requests = requests;

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push(url);
    const body = (): Record<string, unknown> => {
      try {
        return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const path = url.split("?")[0] ?? "";

    if (url.startsWith("/multica/config")) {
      // M-173: the host's slug is the only source the WorkspaceGate reads;
      // an empty slug boots every page into the no-workspace boundary.
      // M-159: workspaceFolder is the "All projects" default the header's
      // Files/Terminal buttons address; the shell harness page names/srv/demo.
      return json({
        wsPath: "/multica/ws",
        workspaceSlug: "demo",
        workspaceFolder: options.workspaceFolder ?? "",
        problem: options.problem ?? null,
      });
    }
    // Members are addressed under a workspace, so this has to be matched
    // before the workspace list or it would answer with the workspace itself.
    if (/^\/multica\/api\/workspaces\/[^/]+\/members/.test(path)) {
      return json([MEMBER]);
    }
    if (/^\/multica\/api\/workspaces\/[^/]+\/decisions(?:\?|$)/.test(url)) {
      return json({
        items: [
          {
            kind: "question",
            source_id: "question-1",
            issue_id: issue(1).id,
            issue_title: issue(1).title,
            project_id: null,
            issue_revision: 1,
            agent_id: "agent-1",
            response_id: null,
            actor_id: null,
            requested_at: "2026-01-01T00:00:00Z",
            task_id: null,
            question_seq: 1,
            sort_at: "2026-01-01T00:00:00Z",
            status: "pending",
            receipt_reason: null,
          },
        ],
        pending_count: 1,
        next_cursor: null,
      });
    }
    if (/^\/multica\/api\/workspaces\/[^/]+\/decisions\//.test(path)) {
      return json({ question: "Which option should we use?" });
    }
    if (url.startsWith("/multica/api/workspaces")) {
      return json(options.workspaces ?? [WORKSPACE]);
    }
    if (url.startsWith("/multica/api/me")) {
      return json({ id: "user-1", name: "Ada", email: "ada@example.test" });
    }
    if (url.startsWith("/multica/api/members")) return json([MEMBER]);
    if (url.startsWith("/multica/api/inbox")) {
      return json([inboxItem(1), inboxItem(2), inboxItem(3)]);
    }
    if (url.startsWith("/multica/api/issue-view-preferences")) {
      return json({
        scope_type: "workspace",
        scope_id: null,
        prefs: { hidden: [], order: [] },
        updated_at: "",
      });
    }
    if (url.startsWith("/multica/api/issue-statuses")) {
      return json({
        statuses: [
          status("todo", "Todo", "unstarted", 0),
          status("in_progress", "In Progress", "started", 1),
          status("in_review", "In Review", "started", 2),
          status("done", "Done", "done", 3),
          status("cancelled", "Cancelled", "closed", 4),
        ],
        categories: ["unstarted", "started", "done", "closed"],
        total: 5,
      });
    }
    if (url.startsWith("/multica/api/properties")) {
      return json({ properties: [], total: 0 });
    }
    if (url.startsWith("/multica/api/issue-workflows")) {
      return json({ workflows: [], total: 0 });
    }
    if (url.startsWith("/multica/api/labels")) {
      return json({ labels: [], total: 0 });
    }
    if (url.startsWith("/multica/api/projects")) return json({ projects: [], total: 0 });
    if (url.startsWith("/multica/api/pins")) return json([]);
    if (url.startsWith("/multica/api/wakeups")) return json({ wakeups: [], total: 0 });
    if (url.startsWith("/multica/api/agents/agent-1/env")) {
      return json({ custom_env: {}, inherited_env: {} });
    }
    if (url.startsWith("/multica/api/agents/agent-1/skills")) return json([]);
    if (url.startsWith("/multica/api/agents/agent-1")) return json(AGENT);
    if (url.startsWith("/multica/api/agents")) return json([AGENT]);
    if (url.startsWith("/multica/api/runtimes")) return json([]);
    if (url.startsWith("/multica/api/skills/skill-1")) return json(SKILL);
    // `GET /api/skills` is a bare array, not an envelope.
    if (url.startsWith("/multica/api/skills")) return json([SKILL]);
    if (url.startsWith("/multica/api/chat/sessions")) {
      return json({ sessions: [], total: 0 });
    }
    if (url.startsWith("/multica/api/chat")) return json({ messages: [], total: 0 });
    if (url.startsWith("/multica/api/agent-task-snapshot")) return json([]);
    if (url.startsWith("/multica/api/agent-tasks")) return json([]);
    // The board is the table surface: one cursor page per column, addressed by
    // the group key the descriptor named.
    if (url.startsWith("/multica/api/issues/table/groups")) {
      return json({
        query_fingerprint: "fp",
        total: 3,
        groups: [
          { key: "todo", value: { kind: "status", status: "todo" }, count: 3 },
        ],
        next_cursor: null,
      });
    }
    if (url.startsWith("/multica/api/issues/table/rows")) {
      const key = String(body().group_key ?? "");
      const mine = key === "" || key.includes("todo") || key.includes("unstarted");
      const rows = mine
        ? [1, 2, 3].map((index) => ({ issue: issue(index), direct_child_count: 0 }))
        : [];
      return json({
        query_fingerprint: "fp",
        group_key: body().group_key ?? null,
        parent_id: null,
        total: rows.length,
        rows,
        branch_total: rows.length,
        next_cursor: null,
      });
    }
    if (url.startsWith("/multica/api/issues/table/facets")) {
      // Status totals are server-authoritative: the board trusts this facet to
      // decide a column is non-empty, so it has to agree with the rows.
      return json({
        query_fingerprint: "fp",
        total: 3,
        facets: [{ kind: "status", values: [{ key: "todo", count: 3 }] }],
      });
    }
    // The issue detail page addresses one issue by identifier (M-146's second
    // dialog opens from its actions menu), and reads its comments beside it.
    if (/^\/multica\/api\/issues\/[^/?]+$/.test(path)) {
      return json(issue(1));
    }
    if (url.includes("/comments")) return json([]);
    if (url.startsWith("/multica/api/issues")) {
      const issues = [issue(1), issue(2), issue(3)];
      return json({ issues, total: issues.length, comments: [] });
    }
    if (url.startsWith("/multica/api/config") || url.startsWith("/multica/api/onboarding")) {
      return json({});
    }
    // The MOCT plane the settings tabs read through the host's /moct prefix.
    if (url.startsWith("/moct/status")) {
      return json({ ok: true, schema: 8, reachable: true });
    }
    if (url.startsWith("/moct/team/v1/memory/usage")) {
      return json({
        workspaceId: "multica:ws:ws-1",
        capTokens: 1200,
        injectLayerTokens: { min: 200, max: 4000 },
        homes: [
          { home: "team:demo", usedTokens: 640, records: 3, blockedPending: 1, largest: [] },
        ],
      });
    }
    if (url.startsWith("/moct/team/v1/memory?")) {
      return json({ results: [], total: 0, nextCursor: null });
    }
    if (url.startsWith("/moct/team/v1/memory/get")) {
      return json({ records: [], missing: [] });
    }
    if (url.startsWith("/moct/team/v1/memory")) {
      return json({ records: [], total: 0, nextCursor: null });
    }
    if (url.startsWith("/moct/")) return json({});
    // Everything else the fork reads on mount is a list.
    return json([]);
  };
}
