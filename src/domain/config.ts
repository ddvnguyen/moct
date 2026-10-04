/**
 * Central configuration — TypeScript port of mcp-orchestration/config.py.
 *
 * Mutable policy lives here (code defaults) with the owner-owned override
 * file <state_root>/fleet.json. Paths resolve from the MCP_ORCH_* env vars
 * exactly like Python; FLEET_REPO_ROOT pins the repo root when the process
 * cwd is not inside the orchestration checkout (parity harness sets it).
 */
/* eslint-disable complexity, max-depth -- faithful port of mcp-orchestration:
 * control structure mirrors the Python source arm-for-arm; the parity harness
 * (138 same-input cases over MCP stdio) guards behavior, not style metrics. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { SYSTEM_PROJECT_SLUG, pyRepr, pyTypeName } from "./models.js";

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_PROMPT_RELPATH =
  "plugins/paseo-orchestration/shared/orchestrator-prompt.md";
export const ORCHESTRATOR_CWD_RELPATH = "orchestration/collector";

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function findRepoRoot(start?: string): string {
  const found = detectRepoRoot(start);
  if (found !== null) return found;
  return path.resolve(start ?? process.cwd());
}

/**
 * The repo root by marker, or null when no marker is found.
 *
 * Deliberately NOT findRepoRoot, whose documented fallback is the current
 * directory when no AGENTS.md + orchestration/ pair is found. That fallback
 * is right for callers that need *some* answer, and catastrophic for a guard:
 * with the cwd standing in for the root, every session appears to sit AT the
 * repo root, so every byCwd key looks unsafe and the whole tier map collapses
 * to the env default. A guard that cannot tell must say so, not guess.
 */
export function detectRepoRoot(start?: string): string | null {
  let current = path.resolve(start ?? process.cwd());
  const chain: string[] = [current];
  let parent = path.dirname(current);
  while (parent !== current) {
    chain.push(parent);
    current = parent;
    parent = path.dirname(current);
  }
  for (const candidate of chain) {
    if (
      existsSync(path.join(candidate, "AGENTS.md")) &&
      isDir(path.join(candidate, "orchestration"))
    ) {
      return candidate;
    }
  }
  return null;
}

export function repoRoot(): string {
  const override = (process.env["FLEET_REPO_ROOT"] || "").trim();
  if (override) return path.resolve(override);
  return findRepoRoot();
}

export function stateRoot(stateDir?: string): string {
  const override = process.env["MCP_ORCH_STATE_DIR"] || "";
  if (override) return path.resolve(override);
  if (stateDir) return path.resolve(stateDir);
  return path.join(findRepoRoot(), "orchestration", "state", "mcp");
}

export function summaryPath(): string {
  const override = process.env["MCP_ORCH_SUMMARY_PATH"] || "";
  if (override) return path.resolve(override);
  return path.join(findRepoRoot(), "orchestration.md");
}

export function lessonsDir(): string {
  const override = process.env["MCP_ORCH_LESSONS_DIR"] || "";
  if (override) return path.resolve(override);
  return path.join(findRepoRoot(), "lessons");
}

export function referencesDir(): string {
  const override = process.env["MCP_ORCH_REFERENCES_DIR"] || "";
  if (override) return path.resolve(override);
  return path.join(findRepoRoot(), "references");
}

// ---------------------------------------------------------------------------
// fleet model map (d-4)
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_SEED_PROVIDER = "bifrost/opencode-zen/mimo-v2.6-flash-free";

export const FLEET_DEFAULT: Record<string, Record<string, unknown>> = {
  leader: {
    models: ["command_code/z-ai/glm-5.3-flash"],
    note: "Owner directive 2026-08-27: LEADER runs glm-5.3-flash on command_code.",
  },
  dev: {
    models: ["opencode-go/muse-spark-1.3-contributor"],
    note: "User 2026-09-15: minimax-m3-free removed; fleet default = opencode-go/muse-spark-1.3-contributor.",
  },
  review: {
    models: ["opencode-go/muse-spark-1.3-contributor"],
    note: "User 2026-09-15: minimax-m3-free removed; fleet default = opencode-go/muse-spark-1.3-contributor.",
  },
  consult: {
    models: ["claude/claude-sonnet-5", "claude/claude-opus-5"],
    note: "Owner-assigned Architecture Consult (issue #48 §7); carve-out stays on the claude tier (owner directive 2026-08-27).",
  },
  orchestrator: {
    models: [ORCHESTRATOR_SEED_PROVIDER],
    note: "Issue #48 D2/D8: ephemeral collector position; model carve-out pending owner confirm (§8); fleet.json overrides.",
  },
};

export interface ModelRecord {
  model: string;
  harness: string;
  harness_explicit: boolean;
  provider_arg: string;
  mode: string | null;
  max_concurrent: number | null;
  tier: string;
  quality_index: number | null;
  thinking: unknown;
  family: string | null;
  priority: number | null;
  priority_degraded: number | null;
  degrade_when_usage: number | null;
  fallback: boolean;
  enabled: boolean;
  notes: string;
  [k: string]: unknown;
}

export function normalizeModelRecord(record: unknown, defaultHarness = "omp"): ModelRecord {
  let rec: Record<string, unknown>;
  if (typeof record === "string") rec = { model: record };
  else if (record !== null && typeof record === "object" && !Array.isArray(record))
    rec = { ...(record as Record<string, unknown>) };
  else throw new Error(`model record must be str or dict, got ${pyTypeName(record)}`);
  const model = rec["model"];
  if (typeof model !== "string" || !model)
    throw new Error("model record missing non-empty 'model'");
  const explicit =
    typeof record === "object" &&
    record !== null &&
    !Array.isArray(record) &&
    ("harness" in (record as object) || "provider_arg" in (record as object));
  const harness = (rec["harness"] as string) ?? defaultHarness;
  const providerArg = (rec["provider_arg"] as string) || `${harness}/${model}`;
  const enabledRaw = rec["enabled"];
  return {
    model,
    harness,
    harness_explicit: explicit,
    provider_arg: providerArg,
    mode: (rec["mode"] as string | null) ?? null,
    max_concurrent: (rec["max_concurrent"] as number | null) ?? null,
    tier: (rec["tier"] as string) ?? "",
    quality_index: (rec["quality_index"] as number | null) ?? null,
    thinking: rec["thinking"] ?? null,
    family: (rec["family"] as string | null) ?? null,
    priority: (rec["priority"] as number | null) ?? null,
    priority_degraded: (rec["priority_degraded"] as number | null) ?? null,
    degrade_when_usage: (rec["degrade_when_usage"] as number | null) ?? null,
    fallback: Boolean(rec["fallback"] ?? false),
    enabled: typeof enabledRaw === "boolean" ? enabledRaw : true,
    notes: (rec["notes"] as string) ?? "",
  };
}

function normalizePosition(entry: unknown): {
  models: ModelRecord[];
  fallback: ModelRecord[];
  note: string;
  [k: string]: unknown;
} {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry))
    return { models: [], fallback: [], note: "" };
  const e = entry as Record<string, unknown>;
  const out: Record<string, unknown> = { ...e };
  out["models"] = ((e["models"] as unknown[] | null) ?? []).map((r) => normalizeModelRecord(r));
  out["fallback"] = ((e["fallback"] as unknown[] | null) ?? []).map((r) => {
    const n = normalizeModelRecord(r);
    n.fallback = true;
    return n;
  });
  return out as {
    models: ModelRecord[];
    fallback: ModelRecord[];
    note: string;
    [k: string]: unknown;
  };
}

const REGISTRY_CONFIG_KEYS = new Set(["spawn", "worktree_roots", "tiers", "version"]);

export interface FleetMap {
  positions: Record<
    string,
    { models: ModelRecord[]; fallback: ModelRecord[]; note: string; [k: string]: unknown }
  >;
  tiers: Record<string, Record<string, string>>;
  fleet_spawn: Record<string, unknown>;
  worktree_roots: string[];
  override?: string;
  override_error?: string;
  version?: unknown;
}

function tiersFrom(document: unknown): Record<string, Record<string, string>> {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return {};
  const tiers = (document as Record<string, unknown>)["tiers"];
  if (tiers === null || typeof tiers !== "object" || Array.isArray(tiers)) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const key of ["byCwd", "byAgentId"]) {
    const block = (tiers as Record<string, unknown>)[key];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
        if (typeof v === "string") m[String(k)] = v;
      }
      out[key] = m;
    }
  }
  return out;
}

function strListFrom(document: unknown, key: string): string[] {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return [];
  const raw = (document as Record<string, unknown>)[key];
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => typeof x === "string" && (x as string).trim()).map(String);
}

export function fleetMap(stateDir?: string): FleetMap {
  const base: FleetMap["positions"] = {};
  for (const [pos, entry] of Object.entries(FLEET_DEFAULT)) base[pos] = normalizePosition(entry);
  const dir = stateDir ?? stateRoot();
  const overrideFile = path.join(dir, "fleet.json");
  if (existsSync(overrideFile)) {
    let overrideDoc: unknown;
    try {
      overrideDoc = JSON.parse(readFileSync(overrideFile, "utf-8"));
    } catch (exc) {
      return {
        positions: base,
        tiers: {},
        fleet_spawn: {},
        worktree_roots: [],
        override_error: `fleet.json invalid: ${(exc as Error).message}`,
      };
    }
    const tiers = tiersFrom(overrideDoc);
    const docRec = overrideDoc as Record<string, unknown>;
    const fleetSpawn =
      docRec["spawn"] !== null &&
      typeof docRec["spawn"] === "object" &&
      !Array.isArray(docRec["spawn"])
        ? (docRec["spawn"] as Record<string, unknown>)
        : {};
    const worktrees = strListFrom(overrideDoc, "worktree_roots");
    const registryVersion = docRec["version"] ?? 1;
    let positionsDoc: Record<string, unknown> = docRec;
    if (
      docRec["positions"] !== null &&
      typeof docRec["positions"] === "object" &&
      !Array.isArray(docRec["positions"])
    ) {
      positionsDoc = docRec["positions"] as Record<string, unknown>;
    }
    for (const [position, patch] of Object.entries(positionsDoc)) {
      if (REGISTRY_CONFIG_KEYS.has(position)) continue;
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) continue;
      try {
        base[position] = normalizePosition(patch);
      } catch (exc) {
        return {
          positions: base,
          tiers: {},
          fleet_spawn: {},
          worktree_roots: [],
          override_error: `fleet.json ${position}: ${(exc as Error).message}`,
        };
      }
    }
    return {
      positions: base,
      tiers,
      fleet_spawn: { ...fleetSpawn },
      worktree_roots: worktrees,
      override: overrideFile,
      version: registryVersion,
    };
  }
  return { positions: base, tiers: {}, fleet_spawn: {}, worktree_roots: [] };
}

export function fleetRecords(
  stateDir: string | undefined,
  position: string,
):
  | { models: ModelRecord[]; fallback: ModelRecord[] }
  | Record<string, { models: ModelRecord[]; fallback: ModelRecord[] }> {
  const positions = fleetMap(stateDir).positions;
  if (position) {
    const entry = positions[position];
    if (!entry) return {};
    return { models: entry.models ?? [], fallback: entry.fallback ?? [] };
  }
  const out: Record<string, { models: ModelRecord[]; fallback: ModelRecord[] }> = {};
  for (const [pos, e] of Object.entries(positions))
    out[pos] = { models: e.models ?? [], fallback: e.fallback ?? [] };
  return out;
}

export function modelAllowed(position: string, model: string, stateDir?: string): boolean {
  const entry = fleetMap(stateDir).positions[position];
  if (!entry) return false;
  const allowed = new Set(
    [...(entry.models ?? []), ...(entry.fallback ?? [])]
      .filter((r) => r.enabled !== false)
      .map((r) => r.model),
  );
  return allowed.has(model);
}

// ---------------------------------------------------------------------------
// token budgets
// ---------------------------------------------------------------------------

export const MD_TOKEN_MIN = 1500;
export const MD_TOKEN_MAX = 8000;
export const TURN_DELTA_TOKEN_MAX = 1000;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// tool surface tiers (d-39)
// ---------------------------------------------------------------------------

export const TOOL_BUDGET_TOKENS = 2000;
export const DEFAULT_TIER = "leader";

export const TOOL_TIERS: Record<string, Set<string>> = {
  leader: new Set([
    "track_create",
    "track_close",
    "track_status",
    "leader_register",
    "turn_report",
    "history",
    "fleet",
    "task_add",
    "task_update",
    "heartbeat",
  ]),
  orchestrator: new Set([
    "track_list",
    "track_status",
    "history",
    "fleet",
    "summary_read",
    "summary_write",
    "heartbeat",
  ]),
  dev: new Set([
    "turn_report",
    "history",
    "track_status",
    "task_update",
    "lesson_add",
    "lesson_list",
  ]),
  consult: new Set(["track_status", "history"]),
};

export const TOOL_UTILITY: Set<string> = new Set([
  "project_create",
  "track_override",
  "leader_runbook",
  "leader_handoff",
  "fleet_usage",
  "suggestion_add",
  "suggestion_list",
  "suggestion_review",
  "model_evaluate",
  "model_evaluations",
  "worker_evaluate",
]);

export const POSITION_TIER: Record<string, string> = {
  leader: "leader",
  dev: "dev",
  review: "dev",
  orchestrator: "orchestrator",
  consult: "consult",
};

export function deferredTools(): Set<string> {
  return TOOL_UTILITY;
}

export function isUnsafeTierKey(cwd: string): boolean {
  const candidate = String(cwd || "").trim();
  if (!candidate) return false;
  const root = detectRepoRoot();
  if (root === null) {
    // No marker anywhere above us, so there is no root to be an ancestor of.
    // Fail OPEN here on purpose: the key still has to be present in the
    // owner-controlled fleet.json to do anything, whereas refusing every key
    // would silently collapse every session to MCP_ORCH_TIER.
    return false;
  }
  let rootReal: string;
  let candidateReal: string;
  try {
    rootReal = realpathSync(root);
    candidateReal = realpathSync(candidate);
  } catch {
    rootReal = root;
    candidateReal = candidate;
  }
  if (candidateReal === rootReal) return true;
  const sep = path.sep;
  return rootReal.startsWith(candidateReal.replace(new RegExp(`${escapeReg(sep)}+$`), "") + sep);
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The directory this session runs in, from the best signal available.
 *
 * In order: the explicit argument, then paseo's PASEO_AGENT_CWD, then the
 * PROCESS cwd. The last one is not a convenience — it is the only signal that
 * exists in production (measured on PROD 2026-10-01: paseo does not inject
 * PASEO_AGENT_CWD into the MCP server subprocess, so resolveTier saw an empty
 * cwd, never consulted tiers.byCwd, and fell through to MCP_ORCH_TIER from
 * .mcp.json for every session).
 *
 * Ordered deliberately — paseo's session-scoped variable beats ambient process
 * state, so a caller that knows its cwd is never re-pointed by wherever it
 * happens to be executing.
 */
export function agentCwd(agentCwdArg?: string | null): string {
  const explicit = (agentCwdArg || "").trim();
  if (explicit) return explicit;
  const envValue = (process.env["PASEO_AGENT_CWD"] || "").trim();
  if (envValue) return envValue;
  try {
    return process.cwd();
  } catch {
    return "";
  }
}

export function resolveTier(
  override?: string | null,
  stateDir?: string,
  agentCwdArg?: string | null,
): string {
  const explicit = (override || "").trim().toLowerCase();
  if (explicit) return explicit;
  const tiers = fleetMap(stateDir).tiers || {};
  const cwd = agentCwd(agentCwdArg);
  if (cwd) {
    const byCwd = tiers["byCwd"] || {};
    let hit: string | undefined = byCwd[cwd];
    if (hit === undefined) {
      try {
        hit = byCwd[realpathSync(cwd)];
      } catch {
        hit = undefined;
      }
    }
    if (typeof hit === "string" && hit.trim() && !isUnsafeTierKey(cwd))
      return hit.trim().toLowerCase();
  }
  const agentId = (process.env["PASEO_AGENT_ID"] || "").trim();
  if (agentId) {
    const byAgent = tiers["byAgentId"] || {};
    const hit = byAgent[agentId];
    if (typeof hit === "string" && hit.trim()) return hit.trim().toLowerCase();
  }
  return (process.env["MCP_ORCH_TIER"] || "").trim().toLowerCase() || DEFAULT_TIER;
}

export function tierTools(raw: string | null | undefined, stateDir?: string): Set<string> | null {
  const value = resolveTier(raw ?? null, stateDir)
    .trim()
    .toLowerCase();
  if (value === "all") return null;
  return TOOL_TIERS[value] ?? TOOL_TIERS[DEFAULT_TIER];
}

export function sessionTierTools(stateDir?: string): Set<string> | null {
  return tierTools(null, stateDir);
}

// ---------------------------------------------------------------------------
// timings (state/timings.py via config accessors)
// ---------------------------------------------------------------------------

export const DEFAULT_TIMINGS = {
  checkup_cron: "*/6 * * * *",
  deep_tick_cron: "*/30 * * * *",
  timezone: "Asia/Ho_Chi_Minh",
  usage_max_age_s: 900,
};

const timingsCache = new Map<string, { key: string; timings: typeof DEFAULT_TIMINGS }>();

function timingsFileKey(p: string): string {
  try {
    const st = statSync(p);
    return `${st.mtime.getTime()}:${st.size}`;
  } catch {
    return "missing";
  }
}

export function loadTimings(stateDir: string): typeof DEFAULT_TIMINGS {
  const file = path.join(stateDir, "timings.json");
  const key = timingsFileKey(file);
  const hit = timingsCache.get(file);
  if (hit && hit.key === key) return hit.timings;
  let effective = { ...DEFAULT_TIMINGS };
  try {
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      let ok = true;
      for (const [k, v] of Object.entries(data)) {
        if (k in DEFAULT_TIMINGS && invalidTimingValue(k, v)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        for (const k of Object.keys(DEFAULT_TIMINGS)) {
          if (k in data) (effective as Record<string, unknown>)[k] = data[k];
        }
      }
    }
  } catch {
    /* defaults */
  }
  timingsCache.set(file, { key, timings: effective });
  return effective;
}

function invalidTimingValue(key: string, value: unknown): boolean {
  if (key === "checkup_cron" || key === "deep_tick_cron") {
    if (typeof value !== "string") return true;
    return validateCron(value) !== null;
  }
  if (key === "timezone") {
    if (typeof value !== "string" || !value) return true;
    try {
      // eslint-disable-next-line no-new -- constructor call validates the timezone name
      new Intl.DateTimeFormat("en", { timeZone: value });
      return false;
    } catch {
      return true;
    }
  }
  if (key === "usage_max_age_s") {
    if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value))
      return true;
    return !(value >= 60 && value <= 86400);
  }
  return false;
}

const CRON_BOUNDS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const ATOM_RE = /^(?:\*|\*\/\d+|\d+|\d+-\d+)$/;
const STEP_RE = /^\*\/(\d+)$/;

export function validateCron(expr: unknown): string | null {
  if (typeof expr !== "string" || !expr.trim()) return "cron must be a non-empty string";
  const fields = expr.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return `cron must have exactly 5 fields, got ${fields.length}`;
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = CRON_BOUNDS[i];
    for (const atom of fields[i].split(",")) {
      if (!ATOM_RE.test(atom))
        return `invalid cron atom ${pyRepr(atom)} in field ${pyRepr(fields[i])} (names and ?LW# extensions are not allowed)`;
      const step = STEP_RE.exec(atom);
      if (step) {
        const n = parseInt(step[1], 10);
        if (!(n >= 1 && n <= hi))
          return `step ${n} out of range 1..${hi} in field ${pyRepr(fields[i])}`;
        continue;
      }
      if (atom.includes("-")) {
        const [a, b] = atom.split("-", 2).map((x) => parseInt(x, 10));
        for (const v of [a, b]) {
          if (!(v >= lo && v <= hi))
            return `value ${v} out of range ${lo}..${hi} in field ${pyRepr(fields[i])}`;
        }
      } else if (atom !== "*") {
        const v = parseInt(atom, 10);
        if (!(v >= lo && v <= hi))
          return `value ${v} out of range ${lo}..${hi} in field ${pyRepr(fields[i])}`;
      }
    }
  }
  return null;
}

// NOTE: Python splits on single spaces; consecutive spaces would create empty
// fields that fail ATOM_RE — filter(Boolean) matches "wrong field counts"
// behavior closely enough for valid crons (parity scope: default timings).
export function describeCron(expr: unknown): string {
  if (typeof expr !== "string") return String(expr);
  const m = /\*\/(\d+)\s+\*\s+\*\s+\*\s+\*/.exec(expr.trim());
  if (m && expr.trim().match(new RegExp(`^\\*/${m[1]}\\s+\\*\\s+\\*\\s+\\*\\s+\\*$`)))
    return `${m[1]}-min`;
  return expr;
}

function timings(stateDir?: string): typeof DEFAULT_TIMINGS {
  return loadTimings(stateDir ?? stateRoot());
}

export function checkupCron(): string {
  return timings()["checkup_cron"];
}
export function deepTickCron(): string {
  return timings()["deep_tick_cron"];
}
export function heartbeatTimezone(): string {
  return timings()["timezone"];
}
export function usageMaxAgeS(): number {
  return timings()["usage_max_age_s"];
}

// ---------------------------------------------------------------------------
// orchestrator schedule (issue #48)
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_SCHEDULE_NAME = "mcp-orchestrator";
export const ORCHESTRATOR_RENEW_CRON = "0 */6 * * *";
export const ORCHESTRATOR_MAX_RUNS = 288;
export const ORCHESTRATOR_CHECKUP_CRON = "*/8 * * * *";
export const ORCHESTRATOR_WAKES_PER_LIFE = 45;
export const ORCHESTRATOR_TOOL_CALL_BUDGET = 20;
export const ORCHESTRATOR_ESCALATE_BELOW = 6;
export const ORCHESTRATOR_CHECKUP_FALLBACK_MINUTES = 8;

export function orchestratorCwd(): string {
  return path.join(repoRoot(), ORCHESTRATOR_CWD_RELPATH);
}

function rankRecord(rec: ModelRecord): [number, number] {
  const p = rec.priority;
  const q = rec.quality_index;
  return [typeof p === "number" ? p : Number.POSITIVE_INFINITY, typeof q === "number" ? -q : 0];
}

function rankedOrchestratorRecords(stateDir?: string): ModelRecord[] {
  const recs = (fleetRecords(stateDir, "orchestrator") as { models: ModelRecord[] }).models ?? [];
  return recs.filter((r) => r.enabled !== false);
}

export function orchestratorSeedProvider(stateDir?: string): string {
  const records = rankedOrchestratorRecords(stateDir);
  if (!records.length) return `omp/${ORCHESTRATOR_SEED_PROVIDER}`;
  const best = [...records].sort((a, b) => {
    const [pa, qa] = rankRecord(a);
    const [pb, qb] = rankRecord(b);
    return pa - pb || qa - qb;
  })[0];
  // Python min() returns the FIRST minimal element; sort must be stable (it is).
  const explicit = String(best.provider_arg || "").trim();
  if (explicit) return explicit;
  const model = String(best.model || "").trim();
  const harness = String(best.harness || "").trim();
  if (!model) return `omp/${ORCHESTRATOR_SEED_PROVIDER}`;
  if (harness) return `${harness}/${model}`;
  return model.includes("/") ? model : `omp/${model}`;
}

function positiveInt(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return null;
}

export function orchestratorCadence(stateDir?: string): {
  renew_cron: string;
  checkup_cron: string;
  max_runs: number;
  wakes_per_life: number;
} {
  const entry = (fleetMap(stateDir).positions["orchestrator"] ?? {}) as unknown as Record<
    string,
    unknown
  >;
  const renew = entry["renew_cron"];
  const checkup = entry["checkup_cron"];
  return {
    renew_cron: typeof renew === "string" && renew.trim() ? renew.trim() : ORCHESTRATOR_RENEW_CRON,
    checkup_cron:
      typeof checkup === "string" && checkup.trim() ? checkup.trim() : ORCHESTRATOR_CHECKUP_CRON,
    max_runs: positiveInt(entry["max_runs"]) ?? ORCHESTRATOR_MAX_RUNS,
    wakes_per_life: positiveInt(entry["wakes_per_life"]) ?? ORCHESTRATOR_WAKES_PER_LIFE,
  };
}

export function orchestratorRenewCron(): string {
  return orchestratorCadence()["renew_cron"];
}
export function orchestratorCheckupCron(): string {
  return orchestratorCadence()["checkup_cron"];
}
export function orchestratorWakesPerLife(): number {
  return orchestratorCadence()["wakes_per_life"];
}
export function orchestratorMaxRuns(): number {
  return orchestratorCadence()["max_runs"];
}

/**
 * Optional workspace to REUSE for every collector generation, or null.
 *
 * paseo currently provisions a fresh workspace per schedule run, so N runs
 * meant N workspaces. `workspaceId` on the schedule target is the upstream
 * change that allows reuse; until the daemon honours it, this field is inert
 * and the spec simply omits it rather than emitting a key the running daemon
 * would strip.
 *
 * Read from positions.orchestrator.workspace_id so the id lives in the
 * registry next to the cwd it must match, and stays in one place.
 */
export function orchestratorWorkspaceId(stateDir?: string): string | null {
  const entry = (fleetMap(stateDir).positions["orchestrator"] ?? {}) as unknown as Record<
    string,
    unknown
  >;
  const value = entry["workspace_id"];
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function cronStepMinutes(cron: string): number | null {
  const parts = cron.split(/\s+/).filter(Boolean);
  if (!parts.length || !parts[0].startsWith("*/")) return null;
  const step = parseInt(parts[0].slice(2), 10);
  if (!Number.isInteger(step)) return null;
  return step > 0 ? step : null;
}

function renewMinutes(cron: string): number | null {
  const parts = cron.split(/\s+/).filter(Boolean);
  if (parts.length < 5) return null;
  const [minute, hour] = parts;
  if (hour.startsWith("*/")) {
    const step = parseInt(hour.slice(2), 10);
    if (!Number.isInteger(step)) return null;
    if (step > 0 && /^\d+$/.test(minute)) return step * 60;
    return null;
  }
  return cronStepMinutes(cron);
}

export function orchestratorCheckupMinutes(): number {
  return cronStepMinutes(orchestratorCheckupCron()) ?? ORCHESTRATOR_CHECKUP_FALLBACK_MINUTES;
}

export function orchestratorCadenceWarning(): string | null {
  const z = orchestratorCheckupMinutes();
  if (z <= 0)
    return `checkup cron ${pyRepr(orchestratorCheckupCron())} does not yield a positive interval`;
  const per = orchestratorWakesPerLife();
  if (per < 1) return `wakes_per_life ${per} must be >= 1`;
  const x = renewMinutes(orchestratorRenewCron());
  if (x === null) {
    return `renewal cron ${pyRepr(orchestratorRenewCron())} is not a shape this check understands; cannot verify that z=${z} divides it`;
  }
  if (x % z !== 0) {
    return `checkup cadence */${z} does not divide renewal ${orchestratorRenewCron()} (${x} min): the final wake of a generation straddles its own kill and the wake budget is wrong`;
  }
  if (per !== Math.floor(x / z)) {
    return `wakes_per_life ${per} disagrees with ${x}/${z} = ${Math.floor(x / z)}; the server derives the count from the clock, so the prompt would be wrong`;
  }
  return null;
}

export function orchestratorSeedPrompt(): string {
  const text = readFileSync(path.join(repoRoot(), ORCHESTRATOR_PROMPT_RELPATH), "utf-8").trim();
  const cadence = orchestratorCadence();
  const replacements: Record<string, string> = {
    "{{renew_cron}}": cadence.renew_cron,
    "{{checkup_cron}}": cadence.checkup_cron,
    "{{wakes_per_life}}": String(cadence.wakes_per_life),
    "{{tool_call_budget}}": String(ORCHESTRATOR_TOOL_CALL_BUDGET),
    "{{escalate_below}}": String(ORCHESTRATOR_ESCALATE_BELOW),
  };
  let out = text;
  for (const [token, value] of Object.entries(replacements)) out = out.split(token).join(value);
  const leftover = Object.keys(replacements).filter((t) => out.includes(t));
  if (leftover.length)
    throw new Error(`orchestrator prompt has unresolved placeholders: ${pyRepr(leftover)}`);
  return out;
}

// ---------------------------------------------------------------------------
// auto-permission (owner directive 2026-09-30)
// ---------------------------------------------------------------------------

export const AUTO_PERMISSION_DEFAULT = true;

export const HARNESS_AUTO_PERMISSION: Record<
  string,
  { feature_id: string | null; permissive_modes: string[] }
> = {
  opencode: { feature_id: "auto_accept", permissive_modes: [] },
  omp: { feature_id: null, permissive_modes: ["full"] },
  claude: { feature_id: null, permissive_modes: ["bypassPermissions"] },
  pi: { feature_id: null, permissive_modes: [] },
  dsh: { feature_id: null, permissive_modes: [] },
};

export function harnessAutoPermission(harness: string): {
  feature_id: string | null;
  permissive_modes: string[];
} {
  return {
    ...(HARNESS_AUTO_PERMISSION[harness] ?? { feature_id: null, permissive_modes: [] as string[] }),
  };
}

function coercePermission(
  value: unknown,
  label: string,
  fleetGoverned = false,
): [boolean, string | null] {
  if (typeof value === "boolean") {
    if (fleetGoverned) {
      return [
        value,
        `auto_permission=${pyRepr(value)} came from the FLEET-WIDE fleet.json \`spawn.auto_permission\` (this position sets none) — add a per-position spawn.auto_permission to override it`,
      ];
    }
    return [value, null];
  }
  return [
    false,
    `${label}=${pyRepr(value)} is not a JSON boolean — treated as OPTED OUT (fail closed). Use true or false.`,
  ];
}

export function positionAutoPermission(
  entry: unknown,
  fleetSpawn?: unknown,
): [boolean, string | null] {
  const fs =
    fleetSpawn !== null && typeof fleetSpawn === "object" && !Array.isArray(fleetSpawn)
      ? (fleetSpawn as Record<string, unknown>)
      : {};
  const fleetValue = fs["auto_permission"];
  if (
    entry === null ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    !("spawn" in (entry as object))
  ) {
    if ("auto_permission" in fs)
      return coercePermission(fleetValue, "fleet spawn.auto_permission", true);
    return [AUTO_PERMISSION_DEFAULT, null];
  }
  const spawn = (entry as Record<string, unknown>)["spawn"];
  if (spawn === null || typeof spawn !== "object" || Array.isArray(spawn)) {
    return [
      false,
      `spawn=${pyRepr(spawn)} is not an object — auto_permission treated as OPTED OUT (fail closed). Expected a JSON object, e.g. '{"auto_permission": false}.'`,
    ];
  }
  if (!("auto_permission" in (spawn as object))) {
    if ("auto_permission" in fs)
      return coercePermission(fleetValue, "fleet spawn.auto_permission", true);
    return [AUTO_PERMISSION_DEFAULT, null];
  }
  return coercePermission(
    (spawn as Record<string, unknown>)["auto_permission"],
    "spawn.auto_permission",
  );
}

export const PROD_DIR_RELPATH = "paseo/PROD";

export function normalisePath(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "";
  let expanded = text.startsWith("~/") ? path.join(process.env["HOME"] ?? "", text.slice(2)) : text;
  let resolved: string;
  try {
    resolved = realpathSync(expanded);
  } catch {
    resolved = path.resolve(expanded);
  }
  return resolved.replace(/\/+$/, "") || "/";
}

export function isUnder(child: string, root: string): boolean {
  if (!child || !root) return false;
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function denyRoots(stateDir?: string): string[] {
  const roots = [
    normalisePath(findRepoRoot()),
    normalisePath(stateRoot(stateDir)),
    normalisePath(path.join(process.env["HOME"] ?? "", PROD_DIR_RELPATH)),
  ];
  const seen: string[] = [];
  for (const r of roots) {
    if (r && !seen.includes(r)) seen.push(r);
  }
  return seen;
}

export function worktreeRoots(stateDir?: string): string[] {
  return [...(fleetMap(stateDir).worktree_roots || [])];
}

export function workspacePermissionPolicy(
  workspaceId: string,
  stateDir?: string,
  allowRoots?: string[] | null,
): [boolean, string] {
  const roots = allowRoots ?? worktreeRoots(stateDir);
  const text = String(workspaceId || "").trim();
  if (!text) return [true, "no workspace_id set — the slot inherits the caller's workspace"];
  if (!text.includes("/") && !text.startsWith("~") && !text.startsWith(".")) {
    return [true, `opaque paseo workspace id ${pyRepr(text)} — verified by the leader steps`];
  }
  const candidate = normalisePath(text);
  for (const root of denyRoots(stateDir)) {
    if (isUnder(candidate, root)) {
      return [
        false,
        `workspace_id ${pyRepr(text)} resolves to ${candidate} which is at or under the deny root ${root} — a live checkout / PROD / live orchestration state is not a scoped worktree`,
      ];
    }
  }
  const allow = roots.map((r) => normalisePath(String(r)));
  for (const root of allow) {
    if (isUnder(candidate, root))
      return [true, `workspace_id ${pyRepr(text)} is under configured worktree root ${root}`];
  }
  if (!allow.length) {
    return [
      false,
      `workspace_id ${pyRepr(text)} resolves to ${candidate}, which is not under any CONFIGURED worktree root (fleet.json \`worktree_roots\` is empty) — refused (fail closed). Add the paseo worktrees root there, or pass an opaque wks_ workspace id.`,
    ];
  }
  return [
    false,
    `workspace_id ${pyRepr(text)} resolves to ${candidate}, which is not under any configured worktree root ${pyRepr(allow)} — refused (fail closed).`,
  ];
}

// ---------------------------------------------------------------------------
// system project
// ---------------------------------------------------------------------------

export function isReservedProjectSlug(slug: string): boolean {
  return new Set([SYSTEM_PROJECT_SLUG]).has(
    String(slug || "")
      .trim()
      .toLowerCase(),
  );
}
