import { afterEach, describe, expect, it, vi } from "vitest";
import type { DshLayout } from "../src/dsh";
import {
  bindShell,
  selectShellPanel,
  sidebarIsCollapsed,
  startSidebarAutoCollapse,
} from "../src/client/shell";

/**
 * The shell bridge: the rail row the island asks the shell to mark, and the
 * sidebar it collapses while an MMX view is active (M-197).
 *
 * Both are driven through the layout service, which is stubbed here exactly as
 * dsh's ui-layout offers it: a selection snapshot, `selectPanel`, and a
 * `toggleSidebar` that flips the state.
 */

const PANEL_OF_FAMILY = new Map([
  ["issues", "multica"],
  ["agents", "multica-agents"],
  ["skills", "multica-skills"],
  ["inbox", "multica-inbox"],
  ["chat", "multica-chat"],
  ["settings", "multica-settings"],
]);

function fakeLayout(options: { panelId?: string | null } = {}) {
  let activePanelId = options.panelId ?? null;
  const listeners = new Set<() => void>();
  const selected: string[] = [];
  const toggles: number[] = [];
  const layout: DshLayout = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId }),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    selectPanel(panelId) {
      selected.push(panelId ?? "none");
      activePanelId = panelId;
      for (const listener of listeners) listener();
    },
    toggleSidebar() {
      toggles.push(toggles.length);
    },
  };
  return {
    layout,
    selected,
    toggles,
    select(panelId: string | null) {
      activePanelId = panelId;
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => {
  bindShell(null);
  document.body?.replaceChildren();
});

describe("selectShellPanel", () => {
  it("selects the row that owns the family", () => {
    const fake = fakeLayout();
    bindShell({ layout: fake.layout, panelOfFamily: PANEL_OF_FAMILY });
    selectShellPanel("agents");
    expect(fake.selected).toEqual(["multica-agents"]);
  });

  it("does not re-select the row the shell already marks", () => {
    const fake = fakeLayout({ panelId: "multica-inbox" });
    bindShell({ layout: fake.layout, panelOfFamily: PANEL_OF_FAMILY });
    selectShellPanel("inbox");
    expect(fake.selected).toEqual([]);
  });

  it("stays inert with no shell bound, so the island still renders", () => {
    const fake = fakeLayout();
    selectShellPanel("issues");
    expect(fake.selected).toEqual([]);
  });

  it("keeps the panel alive when the shell refuses a selection", () => {
    const fake = fakeLayout();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refusing: DshLayout = {
      ...fake.layout,
      selectPanel() {
        throw new Error("layout.selectPanel: main panel is not registered");
      },
    };
    bindShell({ layout: refusing, panelOfFamily: PANEL_OF_FAMILY });
    expect(() => selectShellPanel("issues")).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("sidebar auto-collapse", () => {
  /** The shell's own report: AppFrame marks a collapsed column on the frame. */
  function frame(collapsed: boolean): HTMLElement {
    const element = document.createElement("div");
    if (collapsed) element.setAttribute("data-sidebar-collapsed", "");
    document.body.append(element);
    return element;
  }

  function collapsingLayout(initial: { collapsed: boolean; panelId?: string | null }) {
    let collapsed = initial.collapsed;
    const element = frame(collapsed);
    const toggles: boolean[] = [];
    const fake = fakeLayout({ panelId: initial.panelId ?? null });
    const layout: DshLayout = {
      ...fake.layout,
      toggleSidebar() {
        collapsed = !collapsed;
        toggles.push(collapsed);
        if (collapsed) element.setAttribute("data-sidebar-collapsed", "");
        else element.removeAttribute("data-sidebar-collapsed");
      },
    };
    const isMultica = (panelId: string | null) =>
      panelId !== null && [...PANEL_OF_FAMILY.values()].includes(panelId);
    const stop = startSidebarAutoCollapse({
      layout,
      isMultica,
      isCollapsed: () => collapsed,
    });
    return {
      layout,
      toggles,
      stop,
      select: (panelId: string | null) => {
        // The fake's own snapshot is what the subscription reads.
        (fake.layout.panelInfo as unknown as { getSnapshot: () => unknown }).getSnapshot =
          () => ({ activePanelId: panelId });
        fake.select(panelId);
      },
    };
  }

  it("collapses on the way into MMX and restores on the way out", () => {
    const shell = collapsingLayout({ collapsed: false });
    shell.select("multica");
    expect(shell.toggles).toEqual([true]);
    shell.select(null);
    expect(shell.toggles).toEqual([true, false]);
    shell.stop();
  });

  it("leaves an already collapsed sidebar alone, and restores nothing", () => {
    const shell = collapsingLayout({ collapsed: true });
    shell.select("multica");
    shell.select(null);
    expect(shell.toggles).toEqual([]);
    shell.stop();
  });

  it("does not fight a reader who expands the sidebar inside MMX", () => {
    const shell = collapsingLayout({ collapsed: false });
    shell.select("multica");
    // The reader expands it: the next MMX view must not collapse it again...
    shell.layout.toggleSidebar();
    shell.select("multica-agents");
    expect(shell.toggles).toEqual([true, false]);
    // ...and leaving must not either, since the shell is already expanded.
    shell.select(null);
    expect(shell.toggles).toEqual([true, false]);
    shell.stop();
  });

  it("leaves the sidebar as the shell has it when the reader never entered MMX", () => {
    const shell = collapsingLayout({ collapsed: false, panelId: null });
    shell.select("plugins");
    shell.select(null);
    expect(shell.toggles).toEqual([]);
    shell.stop();
  });
});

describe("sidebarIsCollapsed", () => {
  it("reads the frame's own collapsed attribute", () => {
    expect(sidebarIsCollapsed(document)).toBe(false);
    const element = document.createElement("div");
    element.setAttribute("data-sidebar-collapsed", "");
    document.body.append(element);
    expect(sidebarIsCollapsed(document)).toBe(true);
  });
});
