import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  islandConfig,
  ISLAND_API_BASE,
  islandWebSocketUrl,
  type IslandConfig,
} from "./config";
import {
  BOARD_ROUTE,
  createIslandNavigation,
  ISLAND_FAMILIES,
  islandPath,
  islandRouteKey,
  parseIslandRoute,
  type IslandRoute,
} from "./navigation";
import { createIslandStorage } from "./storage";
import { createTabsStore, familyOfRoute } from "./tabs";
import {
  createIslandScrollRestorationAdapter,
  watchScrollMemento,
} from "./memento-capture";
import { selectShellPanel } from "./shell";
import { TabBar } from "./tab-bar";
import { ProjectPicker } from "./project-picker";
import { readProjectScope, writeProjectScope } from "./project-scope";
import { createIslandLocaleAdapter, resolveIslandLocale } from "./locale";
import { PanelZoomRow } from "./zoom-row";
import { useZoom } from "./zoom-store";
import { createMoctGroup, HIDDEN_SETTINGS_TABS } from "./moct-settings";
import { ShellButtons } from "./shell-buttons";
import { createAgentMemorySections } from "./moct-agent-memory";
import { UnreadReporter } from "./unread-reporter";
import { IslandVersionBadge } from "./version-badge";
import {
  AgentDetailPage,
  AgentsPage,
  ChatPage,
  CoreProvider,
  createIssueViewStore,
  ErrorBoundary,
  InboxPage,
  IssueOpeningCapabilityProvider,
  IssueDetailRoute,
  IssuesPage,
  mmxBuild,
  ModalRegistry,
  SearchCommand,
  PageChromeProvider,
  NavigationProvider,
  PortalContainerProvider,
  ScrollRestorationProvider,
  projectListOptions,
  RESOURCES,
  setCurrentWorkspace,
  SettingsPage,
  SkillDetailPage,
  SkillsPage,
  useWorkspaceList,
  ViewStoreProvider,
  WorkspaceSlugProvider,
} from "../fork";

/**
 * The stamped build identity multica-be records for the panel (M-155):
 * `x.x.x-yyMMMdd.HH.mm`, the same string the Settings row and the bottom-right
 * badge show, so a server log line or API identity points at the exact build
 * that produced an error. "dev" only survives where a host built the island
 * without injecting a build — no real deployment does.
 */
export const ISLAND_VERSION = mmxBuild()?.stamp ?? "dev";

export interface IslandAppProps {
  /** Where Base UI portals render, inside the island's shadow root. */
  portalHost: HTMLElement;
  /** Workspace the panel opens; empty selects the first one the token sees. */
  preferredSlug?: string;
  /** Origin-less WebSocket URL on the dsh origin. */
  wsUrl: string;
  /** Same-origin path of the realtime channel, shown in settings. */
  wsPath: string;
  /** Why the host cannot proxy, when it cannot; shown in settings. */
  problem: string | null;
  /** Default folder for "All projects" (M-159); empty means none configured. */
  workspaceFolder?: string;
  /** Entry the seat asked for; the board unless a deep link named one issue. */
  route?: IslandRoute;
  /** True while a seat holds the island. */
  attached?: boolean;
}

/**
 * Boot gate.
 *
 * The workspace and the realtime path come from the host half, which is the
 * only face that knows its own configuration. The provider tree is built once
 * those arrive, so `CoreProvider` never has to change its WebSocket URL under a
 * live connection.
 */
export function IslandBoot({
  portalHost,
  route,
  attached = false,
}: {
  portalHost: HTMLElement;
  route?: IslandRoute;
  /** True while a seat holds the island; see `MountIslandOptions.attached`. */
  attached?: boolean;
}) {
  const [config, setConfig] = useState<IslandConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    islandConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== null) {
    return (
      <IslandMessage
        title="Multica did not start"
        body={`${error}. Check the plugin row's serverUrl and token.`}
      />
    );
  }
  if (config === null) return <IslandMessage title="Connecting to Multica…" />;
  if (config.problem !== null) {
    return (
      <IslandMessage
        title="Multica is not configured"
        body={`${config.problem}. Set the plugin row's serverUrl and token (or MULTICA_DSH_SERVER_URL and MULTICA_DSH_TOKEN).`}
      />
    );
  }
  return (
    <IslandApp
      portalHost={portalHost}
      preferredSlug={config.workspaceSlug}
      wsUrl={islandWebSocketUrl(config.wsPath, window.location)}
      wsPath={config.wsPath}
      problem={config.problem}
      workspaceFolder={config.workspaceFolder}
      route={route}
      attached={attached}
    />
  );
}

export function IslandApp({
  portalHost,
  preferredSlug,
  wsUrl,
  wsPath,
  problem,
  workspaceFolder = "",
  route,
  attached = false,
}: IslandAppProps) {
  const storage = useMemo(() => createIslandStorage(), []);
  // The adapter is what the fork's Preferences page reads its Language row
  // through; without it `useLocaleAdapter` throws and the page renders as the
  // error boundary (M-154). `syncUserLocale` stays off: the Language row still
  // PATCHes `/api/me` itself, and the dsh shell's own language is not ours.
  const localeAdapter = useMemo(
    () => createIslandLocaleAdapter(storage),
    [storage],
  );
  const locale = useMemo(
    () => resolveIslandLocale(localeAdapter),
    [localeAdapter],
  );
  const zoom = useZoom();
  return (
    // Zoom scales the panel's own surface, not the shell and not the overlays:
    // popups are portalled outside this tree (`popup-seat.ts`), so they keep
    // their size and their anchoring at every level. Percentage heights still
    // resolve, because the containing block is expressed in the zoomed space.
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{ zoom: zoom / 100 }}
      data-panel-zoom={zoom}
    >
      <CoreProvider
        apiBaseUrl={ISLAND_API_BASE}
        wsUrl={wsUrl}
        storage={storage}
        // Cookie mode: the host proxy authenticates every request and the
        // WebSocket upgrade with its own token, so the island sends nothing and
        // the sliding-renewal flow (a cookie-session concern) stays off.
        cookieAuth
        identity={{ platform: "dsh", version: ISLAND_VERSION, os: detectOs() }}
        locale={locale}
        localeAdapter={localeAdapter}
        resources={{ [locale]: RESOURCES[locale] }}
        syncUserLocale={false}
      >
        <PortalContainerProvider container={portalHost}>
          <WorkspaceGate
            preferredSlug={preferredSlug}
            wsPath={wsPath}
            problem={problem}
            workspaceFolder={workspaceFolder}
            route={route}
            attached={attached}
          />
        </PortalContainerProvider>
      </CoreProvider>
    </div>
  );
}

function detectOs(): string {
  const platform =
    typeof navigator === "undefined" ? "" : navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "unknown";
}

/**
 * Resolve the workspace the panel speaks as.
 *
 * The fork's pages read their workspace from a slug context and address every
 * query by the workspace id resolved from it, so one workspace has to be
 * chosen before either page mounts. `setCurrentWorkspace` is the same
 * platform-owned pointer the web layout maintains, and it is what puts
 * `X-Workspace-Slug` on the proxied requests.
 *
 * This deployment has exactly one workspace (M-173): the host's
 * `workspaceSlug` is the only source, and a slug it cannot read is an error
 * the reader has to fix — never a reason to quietly open a different
 * workspace's data under the same header.
 */
function WorkspaceGate({
  preferredSlug,
  wsPath,
  problem,
  workspaceFolder,
  route,
  attached,
}: {
  preferredSlug?: string;
  wsPath: string;
  problem: string | null;
  workspaceFolder?: string;
  route?: IslandRoute;
  attached: boolean;
}) {
  const { workspaces, ready } = useWorkspaceList();
  const workspace = useMemo(() => {
    const preferred = preferredSlug?.trim();
    if (!preferred) return null;
    return workspaces.find((entry) => entry.slug === preferred) ?? null;
  }, [preferredSlug, workspaces]);

  const slug = workspace?.slug;
  const id = workspace?.id;
  // The pointer every descendant request is stamped from, so it has to be set
  // before the first descendant mounts. A passive effect here does not do that:
  // child effects run before the parent's, so the pages' first queries — and
  // the reporter's unread summary — used to leave without `X-Workspace-Slug`,
  // and the server answered 400 to each of them until react-query retried
  // (M-198). A layout effect runs after the DOM is committed and before any
  // passive effect in the tree, and `armed` keeps the children out of the
  // render that precedes it, so nothing below ever queries while the pointer
  // still belongs to another workspace.
  const [armed, setArmed] = useState<{ slug: string; id: string } | null>(null);
  useLayoutEffect(() => {
    if (slug === undefined || id === undefined) return;
    setCurrentWorkspace(slug, id);
    setArmed({ slug, id });
    return () => setCurrentWorkspace(null, null);
  }, [slug, id]);

  if (!ready) return <IslandMessage title="Connecting to Multica…" />;
  if (workspace === null) {
    return (
      <IslandMessage
        title="No Multica workspace"
        body={
          preferredSlug?.trim()
            ? `The configured workspace "${preferredSlug}" is not readable with this token.`
            : "This deployment has no Multica workspace configured."
        }
      />
    );
  }
  // One frame, before the layout effect above has armed this workspace: the
  // pages wait here rather than query against a pointer that is not theirs.
  if (armed === null || armed.slug !== workspace.slug || armed.id !== workspace.id) {
    return <IslandMessage title="Connecting to Multica…" />;
  }
  return (
    <WorkspaceSlugProvider slug={workspace.slug}>
      {/* Beside the app itself, inside CoreProvider's QueryClientProvider:
          the reporter observes the summary key the inbox page reads and
          writes the rail dot's store. */}
      <UnreadReporter workspaceId={workspace.id} />
      <IslandPages
        slug={workspace.slug}
        workspaceId={workspace.id}
        wsPath={wsPath}
        problem={problem}
        workspaceFolder={workspaceFolder}
        route={route}
        attached={attached}
      />
    </WorkspaceSlugProvider>
  );
}

/**
 * The places the island renders without host-supplied props, plus their detail
 * depth. Settings is the one entry mounted separately: it needs the MOCT group
 * and the hidden-page list above.
 *
 * The rail row decides where an island opens; from there the fork's pages
 * navigate the way they do in the web app, so a link between two of these views
 * (an inbox row falling back to its issue, an agent's "message" link) lands on
 * the matching page instead of doing nothing. The island keeps the shell's rail
 * selection on the row that owns the active tab's family (`selectShellPanel`),
 * so a tab that moves the reader into another family moves the highlight with
 * it (M-197).
 */
function IslandPage({
  route,
  /** The agent page's host sections (the MOCT Memory tab); absent, a stock page. */
  extraAgentSections,
}: {
  /** Settings is mounted by `IslandPages`; it needs props this switch lacks. */
  route: Exclude<IslandRoute, { view: "settings" }>;
  extraAgentSections?: ReturnType<typeof createAgentMemorySections>;
}) {
  switch (route.view) {
    case "board":
      return <IssuesPage />;
    case "issue":
      return <IssueDetailRoute routeId={route.issueId} />;
    case "agents":
      return <AgentsPage />;
    case "agent":
      return (
        <AgentDetailPage
          agentId={route.agentId}
          extraSections={extraAgentSections}
        />
      );
    case "skills":
      return <SkillsPage />;
    case "skill":
      return <SkillDetailPage skillId={route.skillId} />;
    case "inbox":
      return <InboxPage />;
    case "chat":
      return <ChatPage />;
  }
}

export function IslandPages({
  slug,
  workspaceId,
  wsPath,
  problem,
  workspaceFolder = "",
  route: entryRoute = BOARD_ROUTE,
  attached = false,
}: {
  slug: string;
  workspaceId: string;
  wsPath: string;
  problem: string | null;
  /** Default folder for "All projects" (M-159); empty means none configured. */
  workspaceFolder?: string;
  route?: IslandRoute;
  /** True while a seat holds the island; the rail only follows a seated tab. */
  attached?: boolean;
}) {
  const storage = useMemo(() => createIslandStorage(), []);
  // One workspace, one tab set (M-173): the persisted key no longer varies by
  // slug, so switching the host's slug can never strand a second history.
  const tabsStore = useMemo(() => createTabsStore(storage, slug), [storage, slug]);

  // The global project filter: the header picker's selection, read back from
  // storage on mount and reconciled against the live list below. The fork's
  // own project query is shared with the pages, so the picker costs no request
  // of its own once a page has loaded the list.
  const { data: projects } = useQuery(projectListOptions(workspaceId));
  const [projectId, setProjectId] = useState<string | null>(() =>
    readProjectScope(storage, undefined),
  );
  useEffect(() => {
    const resolved = readProjectScope(storage, projects);
    if (resolved !== projectId) setProjectId(resolved);
  }, [projectId, projects, storage]);
  function selectProject(next: string | null) {
    setProjectId(next);
    writeProjectScope(storage, next);
  }

  const [entry, setEntry] = useState<string | null>(null);

  // initial tab
  useEffect(() => {
    const st = tabsStore.getState();
    const url = islandPath(slug, entryRoute);
    const isRailEntry = !("issueId" in entryRoute || "agentId" in entryRoute || "skillId" in entryRoute) && (entryRoute.query === undefined || entryRoute.query === "");
    if (isRailEntry) st.railEntry(entryRoute);
    else st.openOrFocus(url);
  }, [tabsStore, entryRoute, slug]);

  // rail click handling
  const requested = islandRouteKey(entryRoute);
  if (entry !== requested) {
    setEntry(requested);
    const st = tabsStore.getState();
    const url = islandPath(slug, entryRoute);
    const isRailEntry = !("issueId" in entryRoute || "agentId" in entryRoute || "skillId" in entryRoute) && (entryRoute.query === undefined || entryRoute.query === "");
    if (isRailEntry) st.railEntry(entryRoute);
    else st.openOrFocus(url);
  }

  const tabsState = useStore(tabsStore);
  const activeTab = tabsState.tabs.find((t) => t.id === tabsState.activeId) ?? null;
  const route: IslandRoute =
    activeTab !== null ? (parseIslandRoute(activeTab.url) ?? entryRoute) : entryRoute;

  // The rail and the strip must never disagree (M-197): whatever the active
  // tab shows — after a tab click, Back/Forward across tabs, a closed tab, or
  // a restored session — the sidebar selects the row that owns its family.
  // Only while a seat holds the island: the warm-up build has no seat, and the
  // shell is showing whatever the reader left it on.
  const family = familyOfRoute(route);
  useEffect(() => {
    if (!attached) return;
    selectShellPanel(family);
  }, [attached, family]);

  const viewStore = useState(() => createIssueViewStore("dsh-issues"))[0];

  const moctGroup = useMemo(
    () => createMoctGroup({ workspaceSlug: slug, workspaceId, wsPath, workspaceFolder, problem }),
    [slug, workspaceId, wsPath, workspaceFolder, problem],
  );
  const agentMemorySections = useMemo(
    () => createAgentMemorySections({ workspaceSlug: slug, workspaceId, wsPath, workspaceFolder, problem }),
    [slug, workspaceId, wsPath, workspaceFolder, problem],
  );

  const navigation = useMemo(
    () =>
      createIslandNavigation({
        slug,
        tabs: tabsStore,
        onRefused: setRefusedState,
      }),
    [slug, tabsStore],
  );

  const [refused, setRefused] = useState<string | null>(null);
  function setRefusedState(v: string) {
    setRefused(v);
  }

  useEffect(() => {
    if (refused === null) return;
    console.info(
      `[multica] ${refused} is not one of the dsh panel's views (${ISLAND_FAMILIES.join(", ")})`,
    );
  }, [refused]);

  // What a re-mounted tab's views come back as (M-174): the capture pass
  // above serves offsets from the store at mount, straight through the fork's
  // own restoration protocol — no rival scroll store to keep in step.
  const restoration = useMemo(
    () => createIslandScrollRestorationAdapter(tabsStore),
    [tabsStore],
  );
  const pageRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(
    () => watchScrollMemento(tabsStore, () => pageRootRef.current),
    [tabsStore],
  );

  // Reload (M-174) = remount + mark the current page's queries stale.
  // `type: "active"` is exactly the mounted observers — the current page and
  // its shared header queries — and `refetchType: "none"` avoids fetching
  // into the tree that is about to unmount; the remounted page refetches its
  // now-stale queries. desktop's Coordinator does the same on generation
  // change.
  const queryClient = useQueryClient();
  const seenGeneration = useRef(tabsState.mountGeneration);
  useEffect(() => {
    const generation = tabsState.mountGeneration;
    if (generation === seenGeneration.current) return;
    seenGeneration.current = generation;
    queryClient.invalidateQueries({ type: "active", refetchType: "none" });
  }, [tabsState.mountGeneration, tabsStore, queryClient]);

  return (
    <ViewStoreProvider store={viewStore}>
      <NavigationProvider value={navigation}>
        <PageChromeProvider titleInHostChrome projectId={projectId}>
          <TabBar
            tabsStore={tabsStore}
            navigation={navigation}
            slug={slug}
            projectPicker={
              <ProjectPicker
                projects={projects ?? []}
                projectId={projectId}
                onSelect={selectProject}
              />
            }
            headerExtras={
              <ShellButtons
                workspaceId={workspaceId}
                projects={projects}
                projectId={projectId}
                workspaceFolder={workspaceFolder}
              />
            }
          />
          <IssueOpeningCapabilityProvider supportsTabs supportsPeek={false}>
            <ScrollRestorationProvider adapter={restoration}>
            <ErrorBoundary
              resetKeys={[
                tabsState.activeId ?? "none",
                islandRouteKey(route),
                tabsState.mountGeneration,
              ]}
            >
              {/* The page the active tab mounts into. The key re-mounts the
                  page on reload (mountGeneration), and `contents` keeps every
                  layout property the pages had as direct children of the
                  island's flex column. The capture pass reads only this
                  element, so the strip and rail never pollute a capture. */}
              <div
                ref={pageRootRef}
                key={`${tabsState.activeId ?? "none"}:${tabsState.mountGeneration}`}
                className="contents"
                data-island-page-root=""
              >
              {route.view === "settings" ? (
                // The fork's page, scoped to what this shell can actually render:
                // no billing, integrations, plugins or shortcut reference, plus the
                // one group that only exists here.
                <SettingsPage
                  extraGroups={[moctGroup]}
                  hiddenTabs={HIDDEN_SETTINGS_TABS}
                  preferencesExtraRows={<PanelZoomRow />}
                />
              ) : (
                <IslandPage route={route} extraAgentSections={agentMemorySections} />
              )}
              </div>
            </ErrorBoundary>
            </ScrollRestorationProvider>
          </IssueOpeningCapabilityProvider>
          {/* The fork's pages ask for a dialog through `useModalStore` and one
              component renders whatever it names; the web and desktop layouts
              mount it, and the island had no equivalent, so every dialog in the
              panel (create issue, delete confirm, set parent, …) was a no-op
              (M-146). It sits here rather than beside `UnreadReporter` because
              the dialogs navigate — `CreateIssueDialog` calls `useNavigation()`
              (`packages/views/modals/create-issue.tsx:244`) and would throw
              outside `NavigationProvider`. Inside `IslandPages` it is also
              outside the route switch, so a dialog survives a page change; the
              portal container comes from `IslandApp`, so it renders into the
              island's shadow root and not the shell's document. */}
          <ModalRegistry />
          <SearchCommand />
          {/* The build stamp (M-155): a sibling of the route switch, so it
              survives page changes and renders even when the boundary shows
              its fallback — the one moment an error report needs it most. */}
          <IslandVersionBadge />
        </PageChromeProvider>
      </NavigationProvider>
    </ViewStoreProvider>
  );
}

function IslandMessage({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-body font-medium text-foreground">{title}</p>
      {body === undefined ? null : (
        <p className="max-w-sm text-caption text-muted-foreground">{body}</p>
      )}
    </div>
  );
}
