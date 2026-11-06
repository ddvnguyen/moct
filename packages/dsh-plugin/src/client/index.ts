import { createElement as bundledCreateElement } from "react";
import type { DshClientContext } from "../dsh";
import { startIsland } from "./island";
import type { IslandRoute } from "./navigation";
import { FAMILY_ROOTS } from "./navigation";
import { bindShell, startBoundSidebarAutoCollapse } from "./shell";
import { configureHostShell } from "./shell-runtime";
import type {
  SessionNavigationLike,
  SessionsLike,
  SidebarRightLike,
  WorkspacesLike,
} from "./shell-link";
import { familyOfRoute } from "./tabs";
import {
  createRailIcon,
  createSeatComponent,
  type HostCreateElement,
  type RailGlyph,
} from "./seat";
import { startUnreadPoll } from "./unread-store";
import { createSteerComposer, STEER_COMPOSER_ENTRY } from "./steer-composer";

/**
 * Browser face of the Multica panel.
 *
 * One rail row per Multica view, additive and without shadowing:
 *
 * - `sidebar.panellist` (a `list`) renders one sidebar button per registration
 *   and addresses the matching `main` cell by list id. Each entry below is one
 *   of those rows; the sidebar owns the button, the label and the selection
 *   state, which is why the menu is seven rows rather than a dropdown the plugin
 *   would have to position inside someone else's column. The list has no
 *   grouping API, so the grouping is expressed by adjacent order (30–36) and a
 *   shared glyph family, and each label carries the product name because the
 *   collapsed rail shows only a glyph and a tooltip.
 * - `main` (a `keyed` slot) gets one cell per entry: the seat the React 19
 *   island mounts into, opening at that entry's own view. `priority: -100` is
 *   the additive convention the shipped panels use; nothing shipped is replaced.
 *
 * The seventh row is Settings: the fork's own page, with the surfaces this panel
 * does not render hidden and one MOCT group added. It is a rail row and not a
 * route inside another row because a settings page is a destination a reader
 * returns to, and the shell's rail is where destinations live.
 *
 * The rows are also the shell's record of which MMX view is showing: the island
 * selects the row that owns the active tab's family (`client/shell.ts`), so the
 * highlight can never disagree with the tab strip (M-197).
 */
export interface MulticaEntry {
  /** `sidebar.panellist` list id, and the `main` cell key it addresses. */
  id: string;
  /** Rail row label: the button's accessible name and its tooltip. */
  label: string;
  /** Where the island opens when this row is selected. */
  route: IslandRoute;
  /** Glyph drawn inside the shell's rail button. */
  glyph: RailGlyph;
}

/** The seven entries, with Decisions beside Inbox. */
export const MULTICA_ENTRIES: readonly MulticaEntry[] = [
  {
    id: "multica",
    label: "Multica Issues",
    route: FAMILY_ROOTS.issues,
    glyph: "issues",
  },
  {
    id: "multica-agents",
    label: "Multica Agents",
    route: FAMILY_ROOTS.agents,
    glyph: "agents",
  },
  {
    id: "multica-skills",
    label: "Multica Skills",
    route: FAMILY_ROOTS.skills,
    glyph: "skills",
  },
  {
    id: "multica-inbox",
    label: "Multica Inbox",
    route: FAMILY_ROOTS.inbox,
    glyph: "inbox",
  },
  {
    id: "multica-decisions",
    label: "Multica Decisions",
    route: FAMILY_ROOTS.decisions,
    glyph: "decisions",
  },
  {
    id: "multica-chat",
    label: "Multica Chat",
    route: FAMILY_ROOTS.chat,
    glyph: "chat",
  },
  {
    id: "multica-settings",
    label: "Multica Settings",
    route: FAMILY_ROOTS.settings,
    glyph: "settings",
  },
];

/** The entry the panel opened with; kept as the first row's id. */
export const MULTICA_PANEL_ID = "multica";

/** First rail row's order; the entries follow in sequence. */
const FIRST_ORDER = 30;

/**
 * Services dsh resolves before calling `apply`.
 *
 * `layout` is dsh's own ui-layout service: the package already declares that
 * module as a client dependency, and injecting the service is what guarantees
 * `ctx.layout` exists when `apply` binds it (M-197) instead of depending on
 * which plugin was applied first.
 *
 * `sidebarRight`, `workspaces` and `sessions` are the side-panel bridge's
 * sources (M-159). Injecting them documents the edge the loader reads for
 * ordering; the apply body still reads each one tolerantly, so a host built
 * without the right sidebar keeps the rail rows anyway.
 *
 * `uiWorkspace` is the same kind of edge one step further out: the service the
 * shell's own session lists call to put a Session on screen. It has to be
 * declared here because `ctx.get()` only answers for injected services — an
 * undeclared read is `undefined` even on a host that provides it, which turned
 * the toggle's "no Session on screen" fallback into "this dsh build cannot
 * select a session" on lane z (M-159).
 */
export const inject = [
  "slots",
  "layout",
  "sidebarRight",
  "workspaces",
  "sessions",
  "uiWorkspace",
];

let hostCreateElement: HostCreateElement | null = null;

/** A face the shell context carries: undefined when the host does not provide it. */
type Face = Record<string, unknown>;

/** Read one service off the shell context without assuming it exists. */
function face(ctx: DshClientContext, name: string): unknown {
  const source = ctx as unknown as { get?: (name: string) => unknown } & Face;
  if (typeof source.get === "function") {
    return source.get(name);
  }
  return (source as Face)[name];
}

/**
 * Hand this module the shell's `createElement`.
 *
 * The bundle wrapper calls it with `require("react")` from the shell's module
 * table before `apply` runs. Without it the plugin assumes a React 19 host and
 * uses its own bundled `createElement`, which is what the unit tests do.
 */
export function configureHostRuntime(createElement: HostCreateElement | null): void {
  hostCreateElement = createElement;
}

export function apply(ctx: DshClientContext): void {
  // The side-panel bridge (M-159): the sidebar faces, read tolerantly so a host
  // without the right sidebar still reaches the rail registration below.
  const sidebarRight = (face(ctx, "sidebarRight") ?? null) as SidebarRightLike | null;
  const workspaces = (face(ctx, "workspaces") ?? null) as WorkspacesLike | null;
  const sessions = (face(ctx, "sessions") ?? null) as SessionsLike | null;
  // Session selection is the shell's navigation (`uiWorkspace`), not a
  // controller method. It is injected like the shell's own sidebar plugin
  // injects it; the read stays tolerant so a host whose face lacks
  // `openSession` still keeps the rail rows and only the reveal fallback
  // reports the missing navigation.
  const sessionNavigation = (face(ctx, "uiWorkspace") ?? null) as SessionNavigationLike | null;
  const layoutFace = ctx.layout ?? null;
  configureHostShell({
    sidebarRight,
    workspaces,
    sessions,
    daemonId: "",
    selectSession:
      typeof sessionNavigation?.openSession === "function"
        ? (sessionId) => sessionNavigation.openSession(sessionId)
        : null,
  });

  // Card C's opt-in: the right sidebar may render beside a hosted `main`
  // panel. Register every MMX panel id inside `ctx.effect` — the disposer is
  // the plugin's teardown — so an MMX view keeps the side panel next to it.
  // Hosting only keeps the column drawn: which Session's folder it edits is
  // named per press by the toggle's `retarget` plan, because the project (and
  // so the folder) changes while MMX stays in the main column. A face without
  // `hostPanel` has to put a Session on screen instead — `reveal` — and the
  // island's tabs survive leaving MMX through keep-alive.
  if (sidebarRight !== null && typeof sidebarRight.hostPanel === "function") {
    ctx.effect?.(() => {
      const disposers = MULTICA_ENTRIES.map((entry) =>
        sidebarRight.hostPanel?.(entry.id) ?? null,
      ).filter((dispose): dispose is () => void => dispose !== null);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "multica: sidebarRight.hostPanel for the seven MMX panels");
  }

  // The rail dot's baseline count. The browser half has no teardown path —
  // `apply` returns void and the slot registrations below are unregistered by
  // the shell, not by this module — so the poller lives as long as the page;
  // the store's own guard makes a repeated `apply` share it rather than start
  // a second timer.
  startUnreadPoll();

  // The shell's own two surfaces this plugin keeps in step with the island
  // (M-197): the rail row that must mark the active tab's family, and the
  // sidebar that collapses while an MMX view is showing. One binding, read by
  // the island and by the auto-collapse subscription below.
  const layout = layoutFace;
  if (layout !== null) {
    bindShell({
      layout,
      panelOfFamily: new Map(
        MULTICA_ENTRIES.map((entry) => [familyOfRoute(entry.route), entry.id]),
      ),
    });
    // Page-lifetime, like the rail dot's poller: `apply` returns void and the
    // shell unloads a plugin with the page.
    startBoundSidebarAutoCollapse();
  }

  const createElement = hostCreateElement ?? (bundledCreateElement as HostCreateElement);

  // The dsh chat's composer for an MMX-owned session (M-136).
  //
  // The selector is the whole safety story: it declines unless exactly one
  // *running* MMX turn pins this session and negotiated `task-supplement-v1`
  // with permission for this viewer. A session with no owner, two owners, or a
  // run that cannot take a message keeps the shell's composer and M-142's
  // banner.
  ctx.slots.inject("conversation.composer", () =>
    ctx.slots.register(
      { ...STEER_COMPOSER_ENTRY },
      createSteerComposer(createElement),
    ),
  );

  MULTICA_ENTRIES.forEach((entry, index) => {
    const railIcon = createRailIcon(createElement, entry.glyph);
    const seat = createSeatComponent(createElement, {
      panelId: entry.id,
      route: entry.route,
    });

    ctx.slots.inject("sidebar.panellist", () =>
      ctx.slots.register(
        {
          name: "sidebar.panellist",
          id: entry.id,
          order: FIRST_ORDER + index,
          label: entry.label,
        },
        railIcon,
      ),
    );

    ctx.slots.inject("main", () =>
      ctx.slots.register(
        {
          name: "main",
          key: entry.id,
          priority: -100,
        },
        seat,
      ),
    );
  });

  warmIsland();
}

/** One warm-up per page: `apply` runs once, and a retry would only duplicate it. */
let warming = false;

/**
 * Build the island ahead of the first rail click.
 *
 * The shell keeps only the selected `main` cell mounted, so the island is not
 * created until something claims a seat — and that claim is the click that used
 * to pay for the whole boot: config, workspace, ~30 queries, a WebSocket and
 * 292 KB of stylesheet. `apply` runs during shell boot, so the build waits for
 * an idle window instead of competing with the shell's first paint. A browser
 * without an idle scheduler falls back to a short timer; the island is created
 * detached either way, and `attachIsland` picks up whatever is already there.
 */
function warmIsland(): void {
  if (warming || typeof document === "undefined") return;
  warming = true;
  const idle = (globalThis as { requestIdleCallback?: (fn: () => void, options?: { timeout: number }) => unknown })
    .requestIdleCallback;
  if (typeof idle === "function") {
    idle(() => startIsland(document), { timeout: 2000 });
    return;
  }
  setTimeout(() => startIsland(document), 200);
}
