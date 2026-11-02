import { useEffect, useState, type ReactNode } from "react";

/**
 * The browser side of the `/moct` seam: one JSON call, one read hook, and the
 * two host-authored answers every MOCT page starts from.
 *
 * The seam itself is the host's (`src/moct-proxy.ts`); this module is only what
 * the pages on this side of it share — the settings tabs (Connection,
 * Interactions) and the Memory overview. Keeping it here rather than in the
 * settings module is what lets the Memory page read the seam without the
 * settings module having to own it.
 */

/** What the host's `/moct/status` says about the memory plane. */
export interface MoctStatus {
  ok: boolean;
  schema: number | null;
  reachable: boolean;
}

/** One home's use of the always-load cap, from `/moct/team/v1/memory/usage`. */
export interface MoctHomeUsage {
  home: string;
  usedTokens: number;
  records: number;
  blockedPending: number;
}

export interface MoctUsage {
  capTokens: number | null;
  homes: MoctHomeUsage[];
}

/** How this panel is wired, as the host half reported it at boot. */
export interface MoctConnection {
  /** Workspace the panel speaks as; empty means the first readable one. */
  workspaceSlug: string;
  /** Workspace UUID the settings writes address. Empty when unresolved. */
  workspaceId: string;
  /** Same-origin realtime path. */
  wsPath: string;
  /** Default folder for "All projects" (M-159); empty means none configured. */
  workspaceFolder: string;
  /** Why the host cannot proxy, when it cannot. Never a credential. */
  problem: string | null;
}

export const MOCT_STATUS_PATH = "/moct/status";
export const MOCT_USAGE_PATH = "/moct/team/v1/memory/usage";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** A trimmed, non-empty string, or undefined. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** A status answer, with the defaults a missing field deserves. */
export function parseMoctStatus(body: unknown): MoctStatus {
  const record = asRecord(body);
  return {
    ok: record["ok"] === true,
    schema: wholeNumber(record["schema"]),
    reachable: record["reachable"] === true,
  };
}

/**
 * A usage answer.
 *
 * moct-be's `homes` is the part a reader acts on: it is where the always-load
 * cap is actually spent. An entry without a home name is not one this page can
 * label, so it is dropped rather than rendered as an empty row.
 */
export function parseMoctUsage(body: unknown): MoctUsage {
  const record = asRecord(body);
  const homes = Array.isArray(record["homes"])
    ? record["homes"].flatMap((entry) => {
        const home = asRecord(entry);
        const name = home["home"];
        if (typeof name !== "string" || name === "") return [];
        return [
          {
            home: name,
            usedTokens: wholeNumber(home["usedTokens"]) ?? 0,
            records: wholeNumber(home["records"]) ?? 0,
            blockedPending: wholeNumber(home["blockedPending"]) ?? 0,
          },
        ];
      })
    : [];
  return { capTokens: wholeNumber(record["capTokens"]), homes };
}

export type Load<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; message: string };

export interface Answer<T> {
  ok: boolean;
  status: number;
  parsed: T | null;
  message: string | null;
}

/** The server's own error text when it refuses; never a status code alone. */
export function refusalMessage(body: unknown, status: number): string {
  const reason = asRecord(body)["error"];
  return typeof reason === "string" && reason !== "" ? reason : `responded ${status}`;
}

/**
 * One JSON request, with the server's own error text when it refuses.
 *
 * The body of a refusal is moct-be's `{ok:false,error}` relayed by the host (or
 * the host's own refusal), which is the only thing a reader can act on, so it
 * is carried through instead of a generic failure string.
 */
export async function callJson<T>(
  path: string,
  parse: (body: unknown) => T,
  init: { method: "GET" | "PUT" | "POST"; body?: unknown } = { method: "GET" },
): Promise<Answer<T>> {
  try {
    const response = await fetch(path, {
      method: init.method,
      headers:
        init.body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      credentials: "same-origin",
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        parsed: null,
        message: refusalMessage(body, response.status),
      };
    }
    return { ok: true, status: response.status, parsed: parse(body), message: null };
  } catch (cause) {
    return {
      ok: false,
      status: 0,
      parsed: null,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * One read from the seam, with an explicit error state.
 *
 * A failure is shown, never defaulted: "unreachable" and "no records" are
 * different answers, and a page that quietly renders zeros for a dead service
 * is worse than one that says it is down.
 */
export function useSeamRead<T>(path: string, parse: (body: unknown) => T, enabled = true) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoad({ state: "loading" });
    void callJson(path, parse).then((answer) => {
      if (cancelled) return;
      setLoad(
        answer.ok && answer.parsed !== null
          ? { state: "ready", value: answer.parsed }
          : { state: "error", message: answer.message ?? "the server did not answer" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [path, parse, attempt, enabled]);

  return [load, () => setAttempt((current) => current + 1)] as const;
}

export function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center rounded-lg border border-input px-2.5 text-label font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring"
    >
      Refresh
    </button>
  );
}

export function ActionButton({
  children,
  label,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  label?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center rounded-lg border border-input px-2.5 text-label font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function Status({ value }: { value: string }) {
  return <span className="text-body text-muted-foreground">{value}</span>;
}

export function Failure({ message }: { message: string }) {
  return (
    <span role="alert" className="text-body text-destructive">
      {message}
    </span>
  );
}
