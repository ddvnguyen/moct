/**
 * What a tab is called in the island's strip (M-197).
 *
 * An issue tab shows its identifier (`M-123`) and keeps the full title in its
 * tooltip: the strip is a switch between places, and `M-123: Fix the rail row`
 * costs the width a second tab needs while the title is the thing a reader
 * reads once they are on the page. Every other tab keeps the name the fork
 * resolves for it.
 *
 * Until the issue is loaded the identifier is not known — the page's URL still
 * carries whatever segment the link used, a UUID when the board's own cards
 * linked it — so the name falls back to that segment and settles on the
 * identifier as soon as the issue's route rewrites the URL
 * (`useCanonicalIssueUrl` replaces it once the issue resolves).
 */

import { parseIslandRoute } from "./navigation";

export interface TabLabel {
  /** The strip's name: the identifier of an issue, the resolved title otherwise. */
  readonly name: string;
  /** The tooltip, when the strip's name is an abbreviation of it. */
  readonly tooltip?: string;
}

export function tabLabel(url: string, title: string): TabLabel {
  const route = parseIslandRoute(url);
  if (route === null || route.view !== "issue") return { name: title };
  return { name: route.issueId, tooltip: title };
}
