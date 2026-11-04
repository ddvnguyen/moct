import { SEAT_STYLE, attachIsland, detachIsland } from "./island";
import type { IslandRoute } from "./navigation";
import { attachDecisionBadge } from "./decisions-badge-store";
import { attachUnreadBadge } from "./unread-store";

/**
 * The components the dsh shell renders for this plugin.
 *
 * All are hook-free on purpose. The shell's React 18 calls them, while every
 * hook in this package belongs to the bundled React 19, and a React 18 render
 * that reached a React 19 hook would find no dispatcher. Element creation is
 * therefore delegated to the shell's own `createElement`, which keeps the
 * elements the shell receives branded for the React that renders them.
 */

/** `createElement` from whichever React owns the host tree. */
export type HostCreateElement = (
  type: unknown,
  props?: unknown,
  ...children: unknown[]
) => unknown;

/**
 * The seat the island currently lives in.
 *
 * dsh mounts exactly one `main` cell at a time, so "the seat that was attached
 * last" is "the seat on screen". That is the only node whose removal may
 * detach the island: the shell swaps cells in one commit, and the outgoing
 * seat's ref goes `null` *after* the incoming one has already claimed the
 * island — sweeping every seat that ever existed would tear down the island
 * that just moved.
 */
let activeSeat: HTMLElement | null = null;

/**
 * Ref callback for a seat host.
 *
 * React 18 invokes it with `null` on unmount without saying which node left, and
 * it detaches the ref *before* removing the node from the document — so the
 * sweep runs one microtask later, once the commit that dropped the node has
 * finished. A re-render re-attaches the same node (the ref identity is stable
 * per seat) and leaves it connected, which is what keeps a re-render from
 * detaching a live island.
 */
export function attachSeat(node: HTMLElement | null, route: IslandRoute): void {
  if (node !== null) {
    activeSeat = node;
    attachIsland(node, route);
    return;
  }
  queueMicrotask(() => {
    if (activeSeat !== null && !activeSeat.isConnected) {
      detachIsland();
      activeSeat = null;
    }
  });
}

export interface SeatOptions {
  /** Panel id this seat belongs to; it is the rail row and the `main` key. */
  panelId: string;
  /** The entry this seat opens, and re-opens on every re-attach. */
  route: IslandRoute;
}

/**
 * The main-column seat: an empty element the island owns.
 *
 * One per rail entry, so the element carries the entry it was mounted for and
 * the island opens at that entry rather than at the board every time.
 */
export function createSeatComponent(
  createElement: HostCreateElement,
  seat: SeatOptions,
) {
  // Created once per registration: a stable ref identity is what tells React
  // "same node" across re-renders instead of detach-then-attach.
  const ref = (node: HTMLElement | null): void => attachSeat(node, seat.route);
  return function MulticaSeat() {
    return createElement("div", {
      ref,
      "data-multica-panel": seat.panelId,
      style: SEAT_STYLE,
    });
  };
}

/** The seven glyphs, one per entry, drawn so they read at rail size. */
export type RailGlyph =
  | "issues"
  | "agents"
  | "skills"
  | "inbox"
  | "decisions"
  | "chat"
  | "settings";

/**
 * The sidebar rail glyph.
 *
 * dsh renders `sidebar.panellist` occupants inside its own button; the icon is
 * geometry only, sized from the owner props, so it inherits the shell's colour
 * and active state. The collapsed rail shows no labels, so the seven entries are
 * told apart here.
 *
 * The inbox row alone is wrapped in the unread dot's host: a relative box the
 * dot anchors to (the shell renders the row inside `.panelGlyph`, an
 * inline-flex that does not clip) plus the stable ref that keeps the dot
 * painted from `unread-store`. Every other glyph renders exactly as before.
 */
export function createRailIcon(createElement: HostCreateElement, glyph: RailGlyph) {
  if (glyph === "decisions") {
    let detachBadge: (() => void) | null = null;
    const badgeRef = (node: HTMLElement | null) => {
      if (node !== null) {
        detachBadge = attachDecisionBadge(node);
        return;
      }
      detachBadge?.();
      detachBadge = null;
    };
    return function MulticaRailIcon({ size = 16 }: { size?: number }) {
      return createElement(
        "span",
        { style: INBOX_GLYPH_HOST_STYLE },
        railSvg(createElement, glyph, size),
        createElement("span", {
          ref: badgeRef,
          "data-multica-decisions-badge": "",
          "aria-hidden": "true",
          style: DECISIONS_BADGE_STYLE,
        }),
      );
    };
  }

  if (glyph !== "inbox") {
    return function MulticaRailIcon({ size = 16 }: { size?: number }) {
      return railSvg(createElement, glyph, size);
    };
  }

  // `createRailIcon` runs once per entry, so this ref closure exists once per
  // entry: no per-render allocation, and — like every component this file
  // exports — no hooks. The shell renders these with its React 18, which
  // would find no React 19 dispatcher for a hook.
  let detachDot: (() => void) | null = null;
  const dotHostRef = (node: HTMLElement | null) => {
    if (node !== null) {
      const dot = node.querySelector<HTMLElement>("[data-multica-inbox-dot]");
      detachDot = dot === null ? null : attachUnreadBadge(dot);
      return;
    }
    // React passes null on unmount: detach exactly what this closure attached.
    detachDot?.();
    detachDot = null;
  };

  return function MulticaRailIcon({ size = 16 }: { size?: number }) {
    return createElement(
      "span",
      { ref: dotHostRef, style: INBOX_GLYPH_HOST_STYLE },
      railSvg(createElement, glyph, size),
      createElement("span", {
        // The hook-free store paints this node's `display` directly.
        "data-multica-inbox-dot": "",
        // Decorative: the row's accessible name is the shell's static
        // aria-label, which the plugin must not mutate.
        "aria-hidden": "true",
        style: INBOX_DOT_STYLE,
      }),
    );
  };
}

/** The glyph box the dot anchors to, inside the shell's `.panelGlyph`. */
const INBOX_GLYPH_HOST_STYLE = {
  position: "relative",
  display: "inline-flex",
} as const;

/**
 * The dot itself. The colour is the shell's own accent token, so the dot
 * follows shell theming; the fallback keeps it visible if the shell ever
 * renames the token.
 */
const INBOX_DOT_STYLE = {
  position: "absolute",
  top: -1,
  right: -1,
  width: 7,
  height: 7,
  borderRadius: 9999,
  background: "var(--dsw-alias-state-business-primary, currentColor)",
} as const;

const DECISIONS_BADGE_STYLE = {
  position: "absolute",
  top: -6,
  right: -8,
  minWidth: 14,
  height: 14,
  padding: "0 3px",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 9999,
  background: "var(--dsw-alias-state-business-primary, currentColor)",
  color: "var(--dsw-alias-surface-primary, white)",
  fontSize: 9,
  fontWeight: 700,
  lineHeight: "14px",
  fontVariantNumeric: "tabular-nums",
} as const;

/** One glyph's SVG, shared by every rail row. */
function railSvg(
  createElement: HostCreateElement,
  glyph: RailGlyph,
  size: number,
): unknown {
  return createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    ...glyphGeometry(createElement, glyph),
  );
}

function glyphGeometry(
  createElement: HostCreateElement,
  glyph: RailGlyph,
): unknown[] {
  switch (glyph) {
    case "issues":
      return [
        createElement("path", { key: "a7qcls", d: "M13 5h8" }),
        createElement("path", { key: "h98zly", d: "M13 12h8" }),
        createElement("path", { key: "c3s6r1", d: "M13 19h8" }),
        createElement("path", { key: "1jhpwq", d: "m3 17 2 2 4-4" }),
        createElement("rect", { key: "cif1o7", x: "3", y: "4", width: "6", height: "6", rx: "1" }),
      ];
    case "agents":
      return [
        createElement("path", { key: "hb8ula", d: "M12 8V4H8" }),
        createElement("rect", { key: "enze0r", width: "16", height: "12", x: "4", y: "8", rx: "2" }),
        createElement("path", { key: "vft8re", d: "M2 14h2" }),
        createElement("path", { key: "4cs60a", d: "M20 14h2" }),
        createElement("path", { key: "1xurst", d: "M15 13v2" }),
        createElement("path", { key: "rq6x2g", d: "M9 13v2" }),
      ];
    case "skills":
      return [
        createElement("path", { key: "1akyts", d: "M12 7v14" }),
        createElement("path", { key: "7q9ll5", d: "M16 12h2" }),
        createElement("path", { key: "msurwy", d: "M16 8h2" }),
        createElement("path", {
          key: "ruj8y",
          d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
        }),
        createElement("path", { key: "32wvfc", d: "M6 12h2" }),
        createElement("path", { key: "30oboj", d: "M6 8h2" }),
      ];
    case "inbox":
      return [
        createElement("polyline", { key: "o97t9d", points: "22 12 16 12 14 15 10 15 8 12 2 12" }),
        createElement("path", {
          key: "oot6mr",
          d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
        }),
      ];
    case "decisions":
      return [
        createElement("path", { key: "page", d: "M7 3h7l4 4v14H7z" }),
        createElement("path", { key: "fold", d: "M14 3v5h5" }),
        createElement("path", { key: "line1", d: "M10 12h5" }),
        createElement("path", { key: "line2", d: "M10 16h3" }),
      ];
    case "chat":
      return [
        createElement("path", {
          key: "18887p",
          d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
        }),
      ];
    case "settings":
      return [
        createElement("path", {
          key: "1i5ecw",
          d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915",
        }),
        createElement("circle", { key: "1v7zrd", cx: "12", cy: "12", r: "3" }),
      ];
  }
}
