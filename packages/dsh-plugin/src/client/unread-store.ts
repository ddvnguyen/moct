import type { InboxWorkspaceUnread } from "../fork";
import { islandConfig, UNREAD_SUMMARY_PATH } from "./config";

/**
 * The unread count behind the rail's inbox dot, outside React.
 *
 * The shell renders `seat.ts` with its own React 18 while every hook in this
 * package belongs to the bundled React 19, so the dot cannot read this store
 * through a hook. The store pushes outward instead: `setUnread` repaints every
 * attached badge, and the island's reporter plus the host poller push counts
 * in. Deliberately no React import anywhere in this file.
 */

/** The account-level total every reader shares. */
let unread = 0;

const listeners = new Set<() => void>();
const badges = new Set<HTMLElement>();

/** The current total. */
export function getUnread(): number {
  return unread;
}

/** Observe changes; the returned function unsubscribes. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publish a new total. Unchanged input is a no-op, and a negative (or
 * non-finite) input clamps to 0 — a bad count must never paint a bad badge.
 */
export function setUnread(count: number): void {
  const next = Number.isFinite(count) ? Math.max(0, count) : 0;
  if (next === unread) return;
  unread = next;
  for (const listener of [...listeners]) listener();
  for (const badge of badges) paintBadge(badge);
}

function paintBadge(badge: HTMLElement): void {
  badge.style.display = unread > 0 ? "block" : "none";
}

/**
 * Paint `node` from the store and keep it painted until detached.
 *
 * The paint is imperative on purpose. The rail icon is hook-free by the
 * seat.ts constraint, so there is no React state to hold this value; and
 * React only writes style properties that changed between renders — the
 * element's `style` prop is the same object on every render — so this
 * imperative `display` write survives re-renders untouched.
 */
export function attachUnreadBadge(node: HTMLElement): () => void {
  badges.add(node);
  paintBadge(node);
  return () => {
    badges.delete(node);
    node.style.display = "none";
  };
}

/**
 * Account-level unread total: the sum across every workspace's row, or 0 when
 * nothing has resolved. Rows whose `count` is not a finite number are skipped
 * so one malformed row cannot poison the total with NaN.
 */
export function totalUnreadCount(
  summary: readonly InboxWorkspaceUnread[] | null | undefined,
): number {
  if (summary == null) return 0;
  let total = 0;
  for (const entry of summary) {
    const count: unknown = entry?.count;
    if (typeof count === "number" && Number.isFinite(count)) total += count;
  }
  return total;
}

/** How often the host half re-reads the summary while the tab is visible. */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** The one live poller: repeated `startUnreadPoll` calls share its stop. */
let activePollStop: (() => void) | null = null;

/**
 * Poll the host's unread summary for the shell side of the rail.
 *
 * The island's reporter is the instant path, but the dot needs a value before
 * (and without) an island being open, so the plugin's `apply` starts this.
 *
 * Failure is always neutral: a non-ok response, a rejected fetch or a body
 * that does not parse leaves the stored count exactly as it was, because a
 * transient outage must never read as "everything is read". Nothing escapes
 * the poller — it runs on a bare timer.
 *
 * The request is workspace-scoped, and this half of the plugin runs before any
 * island exists, so it cannot read the platform's current-workspace pointer.
 * The slug therefore comes from the host's own config, and a host with no
 * workspace configured is not polled at all: a slugless request is a 400 the
 * server answers, not a count (M-198).
 *
 * The timer only runs while `document.visibilityState` is not `hidden`; coming
 * back on screen polls immediately instead of waiting out the interval.
 */
export function startUnreadPoll(
  options: { intervalMs?: number } = {},
): () => void {
  if (activePollStop !== null) return activePollStop;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const poll = async (): Promise<void> => {
    try {
      const slug = (await islandConfig()).workspaceSlug.trim();
      if (slug === "") return;
      const response = await fetch(UNREAD_SUMMARY_PATH, {
        credentials: "same-origin",
        headers: { accept: "application/json", "X-Workspace-Slug": slug },
      });
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (!Array.isArray(body)) return;
      setUnread(totalUnreadCount(body as InboxWorkspaceUnread[]));
    } catch {
      // Keep the last known count; see the doc comment above.
    }
  };

  // No document (a jsdom-less unit test): nothing to hide, so poll freely.
  const visible = (): boolean =>
    typeof document === "undefined" || document.visibilityState !== "hidden";

  const stopTimer = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const startTimer = (): void => {
    if (stopped || timer !== null || !visible()) return;
    timer = setInterval(() => {
      void poll();
    }, intervalMs);
  };

  const onVisibilityChange = (): void => {
    if (!visible()) {
      stopTimer();
      return;
    }
    // Back on screen: refresh at once, then resume the interval.
    stopTimer();
    startTimer();
    void poll();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stopTimer();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (activePollStop === stop) activePollStop = null;
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  startTimer();
  if (visible()) void poll();

  activePollStop = stop;
  return stop;
}
