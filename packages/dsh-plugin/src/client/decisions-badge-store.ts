/** Pending Decisions count painted onto the host-owned React 18 rail. */
let pendingCount = 0;
const badges = new Set<HTMLElement>();

function paintBadge(badge: HTMLElement): void {
  badge.textContent = pendingCount > 99 ? "99+" : String(pendingCount);
  badge.style.display = pendingCount > 0 ? "inline-flex" : "none";
}

export function setDecisionPendingCount(count: number): void {
  pendingCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  for (const badge of badges) paintBadge(badge);
}

export function getDecisionPendingCount(): number {
  return pendingCount;
}

export function attachDecisionBadge(node: HTMLElement): () => void {
  badges.add(node);
  paintBadge(node);
  return () => {
    badges.delete(node);
    node.textContent = "";
    node.style.display = "none";
  };
}
