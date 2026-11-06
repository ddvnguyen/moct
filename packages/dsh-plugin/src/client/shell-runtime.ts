/**
 * The bridge between `apply` and the island (M-159).
 *
 * The island never imports dsh: the browser face's `apply` receives the shell
 * context and hands the island a small structural bridge — the same module
 * setter pattern `configureHostRuntime` uses for `createElement`. Nothing set
 * means no shell integration: the header keeps its plain layout and the
 * side-panel toggle does not render at all, so a host without these services
 * keeps applying cleanly.
 */

import type {
  SessionsLike,
  SidebarRightLike,
  WorkspacesLike,
} from "./shell-link";

/** What the island may call on the shell's sidebar faces. */
export interface ShellBridge {
  /** The dsh sidebarRight face; absent means the host has no right sidebar. */
  sidebarRight: SidebarRightLike | null;
  /** The dsh workspaces face; absent means folder matching is unavailable. */
  workspaces: WorkspacesLike | null;
  /** The dsh sessions face; absent means session creation is unavailable. */
  sessions: SessionsLike | null;
  /** The host's daemon id, used to filter `local_directory` refs; may be empty. */
  daemonId: string;
  /**
   * Session navigation, for the no-`hostPanel` case: the bound Session has to
   * be the on-screen one before the Sidebar has anything to draw, and selecting
   * a Session is the shell's navigation, not the controllers' (their selection
   * lives outside them). Absent when the host has no workspace UI to navigate
   * with.
   */
  selectSession: ((sessionId: string) => void) | null;
}

let bridge: ShellBridge | null = null;

/**
 * Hand this module the shell's faces. Called from `apply` exactly once per
 * page; repeated calls replace the bridge, which keeps a hot reload honest.
 */
export function configureHostShell(next: ShellBridge): void {
  bridge = next;
}

/** The bridge `apply` installed, or `null` before it has (tests only). */
export function hostShell(): ShellBridge | null {
  return bridge;
}

/** Drop the bridge. Tests only. */
export function resetHostShell(): void {
  bridge = null;
}
