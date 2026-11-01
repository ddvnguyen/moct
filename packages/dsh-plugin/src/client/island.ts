import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useModalStore } from "../fork";
import { IslandBoot } from "./island-app";
import { BOARD_ROUTE, islandRouteKey, type IslandRoute } from "./navigation";
import { restoreShadowFocusGuards } from "./focus-guards";
import {
  ISLAND_CSS,
  ISLAND_PROPERTY_RULES,
  createPopupSeat,
  type PopupSeat,
} from "./popup-seat";
import { installPropertyRules } from "./property-shim";
import { swallowShellShortcuts } from "./shell-keys";

/**
 * The React 19 island.
 *
 * dsh's shell is React 18 and this package ships its own React 19, so the two
 * trees must not meet: the shell renders exactly one element here — a host
 * `div` — and this module owns everything below it. That includes the slider
 * between them, a shadow root, which is what keeps Tailwind's preflight and
 * utility classes out of the shell's document.
 *
 * `:root` is rewritten to `:host` (`popup-seat.ts`) because inside a shadow
 * tree `:root` matches nothing: the fork's design tokens would otherwise be
 * injected and never land.
 *
 * One island per document. The shell keeps only the selected `main` cell
 * mounted, so a per-cell island boots a whole app on every rail click: config
 * fetch, workspace resolution, ~30 queries, a WebSocket, and a fresh 292 KB
 * stylesheet. Instead the island is built once and its host element is moved
 * between seats; leaving a panel detaches the host and closes whatever
 * overlays were open, and re-entering moves it back and sets the route. The
 * React tree, the query cache and the connection survive the move.
 */

/** Everything the shell needs to tear one island down again. */
interface IslandHandle {
  root: Root;
  theme: MutationObserver | null;
  /** The seat overlays render into: the shell's layer, or the island's own. */
  seat: PopupSeat;
  /** Where portals render, so a later render can address the same container. */
  portalHost: HTMLElement;
  /**
   * The route the last seat asked for. In-island navigation does not move it,
   * so a re-render that re-attaches the same seat does not reset the page.
   */
  route: IslandRoute;
  /** Whether a seat holds the island; the tree knows, so it can be re-rendered. */
  attached: boolean;
}

export interface MountIslandOptions {
  /** Which place to open first. The board unless a link named one issue. */
  initialRoute?: IslandRoute;
  /** True when a seat already holds this host (see `attachIsland`). */
  attached?: boolean;
}

const handles = new WeakMap<HTMLElement, IslandHandle>();

/** The host element of the document's single keep-alive island, once built. */
let keepAlive: HTMLElement | null = null;

/** Is the shell currently dark? dsh exposes both a class and a data attribute. */
export function shellPrefersDark(doc: Document): boolean {
  const root = doc.documentElement;
  return (
    root.classList.contains("dark") ||
    root.dataset.theme === "dark" ||
    (root.dataset.theme === undefined &&
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches === true)
  );
}

export function mountIsland(host: HTMLElement, options: MountIslandOptions = {}): void {
  if (handles.has(host)) return;
  const doc = host.ownerDocument;
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.replaceChildren();

  const style = doc.createElement("style");
  style.dataset.multicaStyles = "";
  style.textContent = ISLAND_CSS;

  const surface = doc.createElement("div");
  surface.className = "multica-island-surface";

  const rootElement = doc.createElement("div");
  rootElement.className = "multica-island-root";
  rootElement.dataset.multicaRoot = "";

  // Popups render outside this shadow root, always: Base UI decides "outside"
  // by reading the press target's root ancestor, and inside a shadow tree that
  // walk ends at the panel, which makes every shell-side inert marker look like
  // post-render content and swallows the dismissal (see `popup-seat.ts`).
  const seat = createPopupSeat(doc);
  const portalHost = seat.portalHost;

  surface.append(rootElement);
  shadow.append(style, surface);

  const syncTheme = (): void => {
    const dark = shellPrefersDark(doc);
    surface.classList.toggle("dark", dark);
    // The popup seat lives outside this shadow root, so it must follow the
    // shell's theme itself: popups are children of the portal host, and the
    // `dark` class on that container is what the fork's utilities match on.
    portalHost.classList.toggle("dark", dark);
  };
  syncTheme();

  // The shell switches theme on the document element; follow it so the panel
  // does not jump to light in a dark shell.
  const theme =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(syncTheme);
  theme?.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });

  swallowShellShortcuts(rootElement);
  // A dialog is not a child of the page that opened it: it is portalled into
  // this container, which sits outside the island's root (in the popup seat it
  // is in another shadow root entirely). Guarding only the root would let every
  // keystroke typed in a dialog's input reach the shell's shortcuts (M-148).
  swallowShellShortcuts(portalHost);
  // Base UI's focus trap compares `document.activeElement` with its guards; in
  // a shadow tree that is the host, so the guards have to be reconciled here or
  // Tab leaves the dialog through the seat (M-148).
  restoreShadowFocusGuards(portalHost);

  const route = options.initialRoute ?? BOARD_ROUTE;
  const root = createRoot(rootElement);
  // `attached` is the island's own knowledge of whether a seat holds it. The
  // warm-up build has no seat, and the island must not drive the shell's rail
  // while nobody can see it (M-197: the rail follows the active tab, and a
  // detached island has none).
  root.render(createElement(IslandBoot, { portalHost, route, attached: options.attached === true }));
  handles.set(host, {
    root,
    theme,
    seat,
    portalHost,
    route,
    attached: options.attached === true,
  });
}

/**
 * The box the island occupies in the main column: the seat renders it and the
 * keep-alive host carries the same one, so `height: 100%` inside the island
 * resolves against a definite parent instead of collapsing to content height
 * (M-143). Inline, not a `:host` rule: a normal declaration from the shell's
 * document would beat a shadow-tree normal one, so CSS alone could be
 * silently re-broken by a shell rule.
 */
export const SEAT_STYLE = {
  display: "block",
  position: "relative",
  flex: "1 1 auto",
  minWidth: 0,
  minHeight: 0,
  height: "100%",
} as const;

/**
 * Build the document's island, detached, and return its host.
 *
 * Called at plugin start so the first rail click already finds a warm island,
 * and again (as a no-op) by `attachIsland` when the first click got there
 * first. The host is deliberately not in the document: nothing shows until a
 * seat claims it.
 */
export function startIsland(
  doc: Document,
  route: IslandRoute = BOARD_ROUTE,
): HTMLElement {
  if (keepAlive !== null && handles.has(keepAlive)) return keepAlive;
  // Tailwind's `--tw-*` initial values only reach a shadow tree from the
  // document that contains it, so they are registered here rather than in the
  // shadow root's sheet; see `property-shim.ts`. Once per document, which makes
  // this a no-op for every start after the first.
  installPropertyRules(doc, ISLAND_PROPERTY_RULES);
  const host = doc.createElement("div");
  host.dataset.multicaHost = "";
  Object.assign(host.style, SEAT_STYLE);
  mountIsland(host, { initialRoute: route });
  keepAlive = host;
  return host;
}

/**
 * Put the island into a seat and open the seat's entry.
 *
 * Moving the host keeps the React root attached to the same element, so the
 * tree is re-parented rather than rebuilt. The route only re-renders when the
 * seat asks for a different entry, which is why a re-render of the same seat
 * does not throw the reader back to the entry's root.
 */
export function attachIsland(seat: HTMLElement, route: IslandRoute): void {
  const host = startIsland(seat.ownerDocument, route);
  if (host.parentElement !== seat) seat.appendChild(host);

  const handle = handles.get(host);
  if (handle === undefined) return;
  const sameEntry = islandRouteKey(handle.route) === islandRouteKey(route);
  // A seat re-render of the same entry changes nothing; the first claim of a
  // warm-up island does — the tree has to learn a seat holds it (M-197).
  if (sameEntry && handle.attached) return;

  // The panel is being asked for a different entry, so whatever dialog the
  // previous one opened goes with it. This is the rail-to-rail case: the host
  // moves to the new cell in the same commit, so `detachIsland` never runs and
  // the dialog would otherwise sit over the entry the reader moved to (M-146).
  if (!sameEntry) closeDialogs();

  handle.route = route;
  handle.attached = true;
  handle.root.render(
    createElement(IslandBoot, { portalHost: handle.portalHost, route, attached: true }),
  );
}

/**
 * Take the island out of the document without tearing it down.
 *
 * Overlays are closed first: a popup rendered through the portal container is
 * not a child of the panel, so it would otherwise stay on screen over the
 * panel that replaced this one — and would reappear on the way back.
 */
export function detachIsland(): void {
  const host = keepAlive;
  if (host === null) return;
  dismissOverlays(host);
  host.remove();
  // No seat holds it now: the next claim re-renders the tree with one, which
  // is what restarts the rail's follow-the-active-tab effect (M-197).
  const handle = handles.get(host);
  if (handle !== undefined) handle.attached = false;
}

/** The keep-alive host, for tests and diagnostics. */
export function islandHost(): HTMLElement | null {
  return keepAlive;
}

/** True while the keep-alive island is in the document. */
export function isIslandAttached(): boolean {
  return keepAlive?.isConnected === true;
}

/**
 * Close an open modal-store dialog, if there is one.
 *
 * The dialog is a child of the portal container rather than of the panel, and
 * it is a modal, so Base UI's outside press does not dismiss it. Every path
 * that takes the panel away from the page that opened it — detaching, and
 * moving the keep-alive host to another rail entry — closes it through the
 * store the page opened it with.
 */
function closeDialogs(): void {
  const modal = useModalStore.getState();
  if (modal.modal !== null) modal.close();
}

/**
 * Close whatever the island has open in a portal.
 *
 * Two kinds of overlay live out here, and they close differently.
 *
 * A modal-store dialog is opened by the fork's pages through `useModalStore`
 * and rendered by `ModalRegistry` into the portal container, so it is not a
 * child of the panel and detaching the panel leaves it on screen — the next
 * attach would then show a page with a dialog from the previous one over it.
 * It closes through the store it was opened with.
 *
 * A Base UI popover dismisses itself on a `pointerdown` outside it, listened
 * for on the document. One synthetic press on the body is that outside press.
 * It is only dispatched when the portal container actually holds something, so
 * a detach with nothing open cannot reach the shell's own dismiss layers.
 */
function dismissOverlays(host: HTMLElement): void {
  const handle = handles.get(host);
  if (handle === undefined) return;
  closeDialogs();
  if (handle.portalHost.childElementCount === 0) return;
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  const Press = win?.PointerEvent ?? win?.MouseEvent;
  if (Press === undefined) return;
  doc.body?.dispatchEvent(
    new Press("pointerdown", {
      bubbles: true,
      composed: true,
      button: 0,
      buttons: 1,
    }),
  );
}

export function unmountIsland(host: HTMLElement): void {
  const handle = handles.get(host);
  if (handle === undefined) return;
  handles.delete(host);
  if (keepAlive === host) keepAlive = null;
  handle.theme?.disconnect();
  handle.root.unmount();
  // The seat sits outside this host's shadow root — in the shell's overlay
  // layer or on the document — so nothing else would ever remove it.
  handle.seat.dispose();
  host.shadowRoot?.replaceChildren();
}

/**
 * Tear the keep-alive island down. Test teardown only: the shell never needs
 * this, because a page reload is the only thing that ends an island's life.
 */
export function resetIsland(): void {
  if (keepAlive !== null) unmountIsland(keepAlive);
  keepAlive = null;
  try {
    window.localStorage.removeItem("multica.dsh.tabs.v1");
  } catch {
    // ignore
  }
}

/** True while an island is mounted on this element. For tests and diagnostics. */
export function isIslandMounted(host: HTMLElement): boolean {
  return handles.has(host);
}
