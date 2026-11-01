/**
 * The island's half of the shell contract beyond the panel itself (M-197).
 *
 * Two things only the host face can do, because they are dsh's own UI:
 *
 * - keep the sidebar's MMX row and the island's active tab agreeing on which
 *   view is showing, by selecting the rail row that owns the tab's family;
 * - collapse the sidebar while an MMX view is active and give the reader back
 *   the sidebar they had when they leave.
 *
 * `apply` binds the layout service once (`context.layout`); the island calls
 * `selectShellPanel` and the auto-collapse subscription lives for the page. A
 * host without the layout service (a unit test, a shell built without
 * ui-layout) leaves both inert rather than failing the panel.
 */

import type { DshLayout } from "../dsh";

interface ShellBinding {
  readonly layout: DshLayout;
  /** The island family a rail row opens, to that row's id. */
  readonly panelOfFamily: ReadonlyMap<string, string>;
}

let binding: ShellBinding | null = null;
let multicaPanels: ReadonlySet<string> = new Set();

/** Hand the client face the shell's layout service. `null` unbinds it. */
export function bindShell(next: ShellBinding | null): void {
  binding = next;
  multicaPanels = new Set(next === null ? [] : [...next.panelOfFamily.values()]);
}

/**
 * Select the rail row that owns `family`, so the sidebar marks what the tab
 * strip shows.
 *
 * A no-op when the row is already selected — the rail click that opened the
 * island has done it, and re-selecting would re-render the seat for nothing.
 */
export function selectShellPanel(family: string): void {
  const bound = binding;
  if (bound === null) return;
  const id = bound.panelOfFamily.get(family);
  if (id === undefined) return;
  if (bound.layout.panelInfo.getSnapshot().activePanelId === id) return;
  try {
    bound.layout.selectPanel(id);
  } catch (cause) {
    // The row is registered by this plugin's own `apply`; a shell that has not
    // finished registering it refuses the selection, and the next tab change
    // tries again. Nothing is broken: the tab strip still shows the view.
    console.warn("[multica] the shell refused the panel selection", cause);
  }
}

/**
 * Is the shell's sidebar drawn collapsed right now?
 *
 * dsh publishes the frame's collapsed state as an attribute on the frame
 * element (`AppFrame`: `data-sidebar-collapsed`), which is the only read of it
 * the island has: the layout service exposes the toggle and the selection, not
 * the column geometry.
 */
export function sidebarIsCollapsed(doc: Document = document): boolean {
  return doc.querySelector("[data-sidebar-collapsed]") !== null;
}

export interface SidebarAutoCollapseOptions {
  readonly layout: DshLayout;
  /** True for a rail row that opens an MMX view. */
  readonly isMultica: (panelId: string | null) => boolean;
  /** Whether the sidebar is collapsed now; the shell's own attribute by default. */
  readonly isCollapsed?: () => boolean;
}

/**
 * Collapse the sidebar on the way into MMX, restore it on the way out.
 *
 * The reader's state is honoured in both directions: a sidebar that was already
 * collapsed is left alone, and a sidebar the reader expands *while* in MMX is
 * never fought — the collapse happens once, on entering, and the restore only
 * happens if this plugin is the one that collapsed it. The narrow layout's
 * toggle flips its own expansion override, so the same two calls restore it.
 *
 * @returns the unsubscribe; page-lifetime, like the rest of `apply`.
 */
export function startSidebarAutoCollapse(
  options: SidebarAutoCollapseOptions,
): () => void {
  const collapsed = options.isCollapsed ?? (() => sidebarIsCollapsed());
  // Inside an MMX view, and whether this plugin is what collapsed the sidebar.
  let inside = false;
  let claimed = false;

  const sync = (): void => {
    const panelId = options.layout.panelInfo.getSnapshot().activePanelId;
    const mine = options.isMultica(panelId);
    // Moving between two MMX views is not a way in: the reader may have
    // expanded the sidebar on purpose, and collapsing it again under their
    // pointer would be the plugin fighting them.
    if (mine === inside) return;
    inside = mine;
    if (mine) {
      if (collapsed()) return;
      claimed = true;
      options.layout.toggleSidebar();
      return;
    }
    const restore = claimed;
    claimed = false;
    if (restore && collapsed()) options.layout.toggleSidebar();
  };

  return options.layout.panelInfo.subscribe(sync);
}

/** The auto-collapse for the bound shell, or `null` when there is no layout. */
export function startBoundSidebarAutoCollapse(): (() => void) | null {
  const bound = binding;
  if (bound === null) return null;
  return startSidebarAutoCollapse({
    layout: bound.layout,
    isMultica: (panelId) => panelId !== null && multicaPanels.has(panelId),
  });
}
