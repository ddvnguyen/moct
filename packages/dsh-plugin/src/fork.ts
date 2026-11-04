/**
 * The one module through which this plugin reaches the Multica fork.
 *
 * `scripts/check-fork-entry.mjs` fails the build when any other file under
 * `packages/dsh-plugin/src` imports an `@multica/*` specifier, and it also
 * checks that every specifier here is a public package export. That is the
 * provenance gate: the plugin depends on the fork's published surface, not on
 * whatever a file happens to export, so a refactor of the fork's internals can
 * never silently reach into the island.
 *
 * When the island needs another fork capability, add it here rather than at the
 * call site. Keep the list short: every entry is surface the island must keep
 * working across fork updates.
 */

// Providers and platform state.
export { CoreProvider, setCurrentWorkspace } from "@multica/core/platform";
export { WorkspaceSlugProvider } from "@multica/core/paths";
export { useWorkspaceList } from "@multica/core/workspace";

// The account-level inbox unread summary the rail dot reports on: the same
// options object `InboxPage` reads through `useInboxUnreadCount`, so the dot
// and the page share one cache entry and one request.
export {
  inboxUnreadSummaryEnabled,
  inboxUnreadSummaryOptions,
} from "@multica/core/inbox/queries";
export type { InboxWorkspaceUnread } from "@multica/core/types/inbox";

// Navigation and view state.
export { NavigationProvider } from "@multica/views/navigation";
export { IssueOpeningCapabilityProvider } from "@multica/views/issues/issue-opening-capability";
export {
  useTabPresentation,
  ResourceLeadingVisual,
} from "@multica/views/layout";
export type { TabPresentationResult } from "@multica/views/layout";
export { PageChromeProvider } from "@multica/views/layout";
export type { NavigationAdapter } from "@multica/views/navigation";
export { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
export { createIssueViewStore } from "@multica/core/issues/stores/view-store";
// The pull-based state-restoration channel the island serves its tabs'
// mementos through (M-174): the platform adapter interface the fork's views
// already consume on desktop, so the island mounts the same plumbing rather
// than a rival one.
export { ScrollRestorationProvider } from "@multica/views/platform";
export type { ScrollRestorationAdapter, ScrollRestorationEntry } from "@multica/views/platform";

// The five surfaces the sidebar menu opens, plus their detail depth.
export {
  IssuesPage,
  IssueDetailRoute,
} from "@multica/views/issues/components";
export { AgentsPage, AgentDetailPage } from "@multica/views/agents";
// The agent page's extension point, so a host-supplied section (the MOCT
// Memory tab) rides the fork's own layout instead of a second design.
export type { ExtraAgentSection } from "@multica/views/agents";
export { SkillsPage, SkillDetailPage } from "@multica/views/skills";
export { InboxPage } from "@multica/views/inbox";
export { DecisionsPage } from "@multica/views/decisions";
export { decisionsOptions } from "@multica/core/decisions";
export { ChatPage } from "@multica/views/chat";

// Dialogs. The fork's pages ask for a dialog through a module-level store and
// one component renders whatever the store names; the island has no layout that
// mounts it, so it mounts `ModalRegistry` itself (M-146). `useModalStore` is
// here for the other half of that contract: detaching the island has to close
// an open dialog, or the next attach brings it back with the panel.
export { ModalRegistry } from "@multica/views/modals/registry";
export { useModalStore } from "@multica/core/modals";

// The settings page itself, plus the layout it hands a host-supplied group, so
// the MOCT tabs look like every other settings page instead of a second design.
export {
  SettingsPage,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsTab,
} from "@multica/views/settings";
export type { ExtraSettingsGroup } from "@multica/views/settings";

// Form primitives the MOCT tabs edit with. Taken from the fork rather than
// styled here so a settings control looks and behaves like the web app's own,
// including the Base UI keyboard and popup behaviour the shell's event handling
// would otherwise have to reproduce.
export { Input } from "@multica/ui/components/ui/input";
export { Switch } from "@multica/ui/components/ui/switch";
export { cn } from "@multica/ui/lib/utils";
export {
  ArrowLeft,
  ArrowRight,
  ListX,
  Plus,
  RefreshCw,
  Server,
  X,
  Pin,
  PinOff,
  Search,
} from "@multica/ui/icons";
export { useScrollFade } from "@multica/ui/hooks/use-scroll-fade";
export { TruncatedTooltip } from "@multica/ui/components/common/truncated-tooltip";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";

// The header's project picker (M-173): the workspace's projects as the fork
// already loads them, and the one page-scope hook every MMX view narrows by.
export { usePageScope } from "@multica/views/layout";
export type { PageScope } from "@multica/views/layout";
export { projectListOptions } from "@multica/core/projects/queries";
export { projectResourcesOptions } from "@multica/core/projects";
export type { Project } from "@multica/core/types/project";
export type { ProjectResource } from "@multica/core/types/project";

// Search: reuse the fork's command palette for results instead of a second search.
export { SearchCommand, useSearchStore } from "@multica/views/search";

// Locale resolution. The island has no cookie and must not write one on dsh's
// origin, so it supplies its own `LocaleAdapter` over `createIslandStorage` and
// resolves it with the fork's own rule instead of a second implementation
// (`client/locale.ts`). Both are DOM-free and server-safe.
export { pickLocale } from "@multica/core/i18n";
export type { LocaleAdapter } from "@multica/core/i18n";

// Shared presentation the island has to own: translations, the error boundary,
// and the portal seat that keeps overlays inside the island's shadow root.
export { RESOURCES } from "@multica/views/locales";
export { ErrorBoundary } from "@multica/ui/components/common/error-boundary";
export { PortalContainerProvider } from "@multica/ui/components/ui/portal-container";

// The runtimes surface (M-174): the same page the desktop and web apps render,
// so the island's Settings can manage what the workspace actually runs on
// instead of only what it stores. The desktop's own wrapper adds daemon state
// its shell owns; a dsh panel has no local daemon, so the props stay unset.
export { RuntimesPage } from "@multica/views/runtimes";

// The stamped build identity (M-155): one string for one build, injected by
// this package's vite config, so the island's badge, the Settings row and the
// client identity sent to multica-be all read the same value.
export { mmxBuild } from "@multica/views/build-info";
