/**
 * Domain models — TypeScript port of mcp-orchestration/state/models.py.
 *
 * Plain interfaces + factory/dump functions. Dumps produce EXACTLY the key
 * sets pydantic model_dump() emits (key order is canonicalized by the parity
 * harness, key presence is contract).
 */
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

export function utcnowIso(): string {
  // Identical shape to models.utcnow_iso(): fixed-width millis + Z.
  return new Date().toISOString();
}

export function todayUtc(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

export function newId(prefix: string): string {
  // models.new_id: f"{prefix}-{uuid.uuid4().hex[:10]}"
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export function slugify(name: string): string {
  // models.slugify verbatim: lowercase, collapse [^a-z0-9._-]+ to '-', strip
  // dashes, truncate to 48. Raises ValueError-style on empty, AttributeError-
  // style on non-strings (both surface as str(exc) in tool errors).
  if (typeof name !== "string") {
    throw new Error(`'${pyTypeName(name)}' object has no attribute 'strip'`);
  }
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`cannot slugify name: ${pyRepr(name)}`);
  return slug.slice(0, 48);
}

export function parseIso(text: string | null | undefined): Date | null {
  if (!text) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  const norm = raw.endsWith("Z") ? raw.slice(0, -1) + "+00:00" : raw;
  const ms = Date.parse(norm);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

export function ageSeconds(isoTs: string | null | undefined, now?: string | null): number | null {
  const parsed = parseIso(isoTs);
  if (parsed === null) return null;
  const ref = now ? parseIso(now) : null;
  const refMs = ref !== null ? ref.getTime() : Date.now();
  return Math.max(0, Math.floor((refMs - parsed.getTime()) / 1000));
}

export function sinceIso(minutes: unknown, now?: string | null): string {
  // models.since_iso verbatim incl. ValueError text. float() accepts numbers,
  // numeric strings and bools (True -> 1.0).
  let window: number;
  if (typeof minutes === "boolean") window = minutes ? 1 : 0;
  else if (typeof minutes === "number") window = minutes;
  else if (typeof minutes === "string") {
    const n = Number(minutes);
    if (minutes.trim() === "" || Number.isNaN(n))
      throw new Error(`minutes must be a number, got ${pyRepr(minutes)}`);
    window = n;
  } else {
    throw new Error(`minutes must be a number, got ${pyRepr(minutes)}`);
  }
  if (Number.isNaN(window)) throw new Error(`minutes must be a number, got ${pyRepr(minutes)}`);
  const base = (now ? parseIso(now) : null) ?? new Date();
  return new Date(base.getTime() - Math.max(0, window) * 60000).toISOString();
}

export interface WakeProgress {
  wakes_total: number;
  wakes_done: number;
  wakes_remaining: number;
  generation_started_at: string | null;
}

export function wakeProgress(
  startedAt: string | null | undefined,
  now: string | null | undefined,
  checkupMinutes: number,
  wakesTotal: number,
): WakeProgress {
  const total = Math.max(0, Math.trunc(checkupMinutes === undefined ? NaN : wakesTotal));
  const step = Math.max(1, Math.trunc(checkupMinutes)) * 60;
  const age = startedAt ? ageSeconds(startedAt, now ?? null) : null;
  const done = age === null ? 0 : Math.min(total, Math.floor(age / step));
  return {
    wakes_total: total,
    wakes_done: done,
    wakes_remaining: Math.max(0, total - done),
    generation_started_at: startedAt || null,
  };
}

// ---------------------------------------------------------------------------
// Python-compat value helpers (error text + serialization parity)
// ---------------------------------------------------------------------------

export function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "str";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return "int";
    return "float";
  }
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** Python repr() for JSON-ish values: 'str' quotes, True/False/None. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return pyReprStr(v);
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
    return pyNumStr(v);
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") {
    return (
      "{" +
      Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`)
        .join(", ") +
      "}"
    );
  }
  return String(v);
}

/** CPython str repr: single quotes unless the string holds one (then double). */
export function pyReprStr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const esc = s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  if (hasSingle && !hasDouble) return `"${esc}"`;
  return `'${esc.replace(/'/g, "\\'")}'`;
}

/** Python str() for interpolation: bare strings stay bare; containers use repr items. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return pyNumStr(v);
  if (Array.isArray(v))
    return "[" + v.map((x) => (typeof x === "string" ? pyRepr(x) : pyStr(x))).join(", ") + "]";
  if (typeof v === "object") {
    return (
      "{" +
      Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => `${pyRepr(k)}: ${typeof val === "string" ? pyRepr(val) : pyStr(val)}`)
        .join(", ") +
      "}"
    );
  }
  return String(v);
}

export function pyNumStr(v: number): string {
  if (Number.isInteger(v)) {
    // NOTE: integral floats (1.0) are indistinguishable from ints after JSON
    // parse; both serialize as "1". See HARNESS.md known limitation.
    return String(v);
  }
  // Shortest round-trip like CPython repr for typical values.
  let s = String(v);
  if (/[eE]/.test(s)) {
    // CPython uses e+XX / e-XX with at least two exponent digits.
    s = s.replace(/e\+?(-?)0*(\d)/, (_, sign: string, d: string) => `e${sign}${d}`);
    if (/e-?\d$/.test(s))
      s = s.replace(/e(-?)(\d)$/, (_, sign: string, d: string) => `e${sign}0${d}`);
  }
  return s;
}

/**
 * json.dumps(obj, ensure_ascii=False) with default separators (', ', ': ').
 * Byte-identical to CPython for str/int/bool/None/list/dict (NaN excluded).
 */
export function pyDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (Number.isNaN(value) || !Number.isFinite(value)) return "null";
    return pyNumStr(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(pyDumps).join(", ") + "]";
  if (typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .map(([k, val]) => `${JSON.stringify(k)}: ${pyDumps(val)}`)
        .join(", ") +
      "}"
    );
  }
  return "null";
}

/** Python truthiness for JSON-ish values ({} and [] are falsy). */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** int(x) with CPython messages; throws on failure. bool -> 0/1, float truncates. */
export function pyInt(x: unknown): number {
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "number") {
    if (Number.isNaN(x) || !Number.isFinite(x))
      throw new Error(`invalid literal for int() with base 10: ${pyRepr(x)}`);
    return Math.trunc(x);
  }
  if (typeof x === "string") {
    if (/^\s*[+-]?\d+\s*$/.test(x)) return parseInt(x, 10);
    throw new Error(`invalid literal for int() with base 10: ${pyRepr(x)}`);
  }
  throw new Error(
    `int() argument must be a string, a bytes-like object or a real number, not ${pyRepr(pyTypeName(x))}`,
  );
}

export function pyFloat(x: unknown): number {
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const n = Number(x);
    if (x.trim() !== "" && !Number.isNaN(n)) return n;
    throw new Error(`could not convert string to float: ${pyRepr(x)}`);
  }
  throw new Error(
    `float() argument must be a string or a real number, not ${pyRepr(pyTypeName(x))}`,
  );
}

/** Python "".join(items): raises TypeError naming the first non-str item. */
export function pyJoin(sep: string, items: unknown): string {
  if (!Array.isArray(items)) throw new TypeError("can only join an iterable");
  for (let i = 0; i < items.length; i++) {
    if (typeof items[i] !== "string")
      throw new TypeError(
        `sequence item ${i}: expected str instance, ${pyTypeName(items[i])} found`,
      );
  }
  return (items as string[]).join(sep);
}

/** Python list(x): arrays copy, strings split to chars, dicts give keys. */
export function pyList(x: unknown): unknown[] {
  if (Array.isArray(x)) return [...x];
  if (typeof x === "string") return x.split("");
  if (x !== null && typeof x === "object") return Object.keys(x as object);
  throw new TypeError(`${pyRepr(pyTypeName(x))} object is not iterable`);
}

/** round-half-even to 2 decimals (CPython round(x, 2) for non-pathological values). */
export function pyRound2(x: number): number {
  const n = x * 100;
  const lo = Math.floor(n);
  const diff = n - lo;
  if (diff < 0.5 - 1e-9) return lo / 100;
  if (diff > 0.5 + 1e-9) return (lo + 1) / 100;
  return (lo % 2 === 0 ? lo : lo + 1) / 100;
}

export function pyRound0(x: number): number {
  const lo = Math.floor(x);
  const diff = x - lo;
  if (diff < 0.5 - 1e-9) return lo;
  if (diff > 0.5 + 1e-9) return lo + 1;
  return lo % 2 === 0 ? lo : lo + 1;
}

// ---------------------------------------------------------------------------
// vocabularies (models.py + config.py constants)
// ---------------------------------------------------------------------------

export const TRACK_STATUSES = ["active", "blocked", "handing_off", "done", "archived"] as const;
export const TURN_STATUSES = ["running", "blocked", "idle", "handing_off"] as const;
export const DECISION_SOURCES = [
  "user",
  "leader",
  "consult",
  "owner-directive",
  "owner-config",
] as const;
export const HANDOFF_STATES = ["none", "pending", "completed", "aborted"] as const;
export const TASK_STATUSES = ["pending", "ready", "running", "blocked", "done"] as const;
export const TASK_GATES = ["ready", "gated", "gpu", "user-decision"] as const;
export const SUGGESTION_KINDS = ["lesson", "reference", "process"] as const;
export const SUGGESTION_STATUSES = ["pending", "approved", "rejected"] as const;
export const LESSON_TAGS = [
  "build",
  "deploy",
  "workflow",
  "harness",
  "coordination",
  "verification",
] as const;

export const EVENT_TYPES: ReadonlySet<string> = new Set([
  "collector_track_created",
  "decision_recorded",
  "handoff_completed",
  "handoff_redirected",
  "handoff_started",
  "heartbeat_confirmed",
  "heartbeat_spec_issued",
  "leader_registered",
  "lesson_added",
  "model_evaluated",
  "model_verification",
  "override_recorded",
  "project_created",
  "suggestion_added",
  "suggestion_reviewed",
  "summary_committed",
  "summary_rejected",
  "task_added",
  "task_updated",
  "track_closed",
  "track_created",
  "turn_reported",
  "worker_evaluated",
  "worker_reported",
]);

export const KNOWN_HARNESSES = ["omp", "opencode", "pi", "dsh", "claude"] as const;
export const CONTRACT_MIN_VERSION = "0.0.1";
export const SYSTEM_PROJECT_NAME = "Orchestration System";
export const SYSTEM_PROJECT_SLUG = "orchestration-system";
export const RESERVED_PROJECT_SLUGS: ReadonlySet<string> = new Set([SYSTEM_PROJECT_SLUG]);
export const CHECKUP_HISTORY_LIMIT = 16;
export const COLLECTOR_TRACK_EPIC = "orchestrator-collector";
export const COLLECTOR_TRACK_GOAL =
  "System-owned state for the ORCHESTRATOR collector: one track for all " +
  "projects, holding this generation's heartbeat binding and its wake count. " +
  "Not a unit of work — the server refuses queue writes, worker reports and " +
  "track closure on it, and it never takes a leader. It exists so the " +
  "collector never writes into a leader's track and inflates that leader's " +
  "turn_count and last_turn_age_s.";

// ---------------------------------------------------------------------------
// entity interfaces (plain data; status/kind fields are plain strings)
// ---------------------------------------------------------------------------

export interface Repo {
  name: string;
  validated: boolean;
  validated_at: string | null;
}
export interface Project {
  id: string;
  name: string;
  slug: string;
  repos: Repo[];
  harness: string;
  created_at: string;
  system: boolean;
}
export interface LeaderBinding {
  agent_id: string;
  model: string;
  harness: string;
  contract_version: string;
  signed_at: string;
  model_verified: boolean;
  override_reason: string | null;
}
export interface HeartbeatBinding {
  checkup_id: string | null;
  deep_id: string | null;
  confirmed_at: string | null;
  schedule_id: string | null;
  orchestrator_checkup_id: string | null;
  generation_started_at: string | null;
  digest_last_written_at: string | null;
  checkup_history: string[];
}
export interface Telemetry {
  compactions: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_pct: number | null;
}
export interface WorkerEvaluation {
  confidence: number;
  effectiveness: number;
  guideline_adherence: number;
  task_complexity: number;
  task_size: number;
  notes: string;
  telemetry: Telemetry | null;
}
export interface WorkerRecord {
  agent_id: string;
  role: string;
  model: string;
  dispatched_at: string;
  status: string;
  evaluation: WorkerEvaluation | null;
}
export interface QueueItem {
  id: string;
  title: string;
  detail: string;
  gate: string;
  status: string;
  progress: number;
  assignee: string;
  added_at: string;
  updated_at: string;
  note: string;
  detail_amendments: Record<string, unknown>[];
}
export interface Handoff {
  state: string;
  from_agent: string | null;
  to_agent: string | null;
  reason: string;
  started_at: string | null;
  completed_at: string | null;
}
export interface Track {
  id: string;
  project_id: string;
  epic: string;
  goal: string;
  repo: string;
  branch: string;
  status: string;
  leader: LeaderBinding | null;
  heartbeats: HeartbeatBinding;
  workers: WorkerRecord[];
  queue: QueueItem[];
  handoff: Handoff;
  turn_count: number;
  created_at: string;
  updated_at: string;
  overrides: Record<string, unknown>;
  overrides_provenance: Record<string, unknown>;
}
export interface KnowledgeNote {
  lesson_topic: string | null;
  docs_updated: unknown[];
}
export interface TurnDelta {
  n: number;
  ts: string;
  summary: string;
  status: string;
  done: unknown[];
  next: unknown[];
  blockers: unknown[];
  decisions: unknown[];
  knowledge: KnowledgeNote;
  author_agent: string;
  author_model: string;
}
export interface Decision {
  id: string;
  ts: string;
  track_id: string | null;
  project_id: string | null;
  decision: string;
  rationale: string;
  source: string;
  irreversible: boolean;
  author: string;
}
export interface FleetEvent {
  ts: string;
  type: string;
  track_id: string | null;
  project_id: string | null;
  payload: Record<string, unknown>;
}
export interface HeartbeatSpec {
  step_name: string;
  cron: string;
  timezone: string;
  prompt: string;
  tool_mcp: string;
  tool_cli: string;
}
export interface ModelScores {
  truthfulness: number;
  confidence: number;
  effectiveness: number;
  guideline_adherence: number;
}
export interface ModelEvaluation {
  id: string;
  track_id: string;
  project_id: string;
  agent_id: string;
  model: string;
  scores: ModelScores;
  task_complexity: number;
  task_size: number;
  telemetry: Telemetry | null;
  notes: string;
  reviewer: string;
  evaluated_at: string;
  history: Record<string, unknown>[];
}
export interface SuggestionRecord {
  id: string;
  track_id: string;
  project_id: string;
  agent_id: string;
  kind: string;
  title: string;
  body: string;
  tags: string[];
  status: string;
  slug: string;
  created_at: string;
  reviewed_at: string | null;
  reviewer: string | null;
  note: string;
  result: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// factories (defaults mirror pydantic field defaults)
// ---------------------------------------------------------------------------

export function defaultHeartbeatBinding(): HeartbeatBinding {
  return {
    checkup_id: null,
    deep_id: null,
    confirmed_at: null,
    schedule_id: null,
    orchestrator_checkup_id: null,
    generation_started_at: null,
    digest_last_written_at: null,
    checkup_history: [],
  };
}

export function defaultHandoff(): Handoff {
  return {
    state: "none",
    from_agent: null,
    to_agent: null,
    reason: "",
    started_at: null,
    completed_at: null,
  };
}

export function makeQueueItem(init: {
  title: string;
  detail?: string;
  gate?: string;
  assignee?: string;
}): QueueItem {
  const now = utcnowIso();
  return {
    id: newId("task"),
    title: init.title,
    detail: init.detail ?? "",
    gate: init.gate ?? "ready",
    status: "pending",
    progress: 0,
    assignee: init.assignee ?? "",
    added_at: now,
    updated_at: now,
    note: "",
    detail_amendments: [],
  };
}

export function coerceTrack(raw: Record<string, unknown>): Track {
  // Rebuild a Track from a stored row (SQL) with the same fallbacks as
  // Store._track_row_to_model: null/empty JSON cols get documented defaults.
  const hb = (raw["heartbeats"] ?? null) as HeartbeatBinding | null;
  const ho = (raw["handoff"] ?? null) as Handoff | null;
  return {
    id: String(raw["id"] ?? ""),
    project_id: String(raw["project_id"] ?? ""),
    epic: String(raw["epic"] ?? ""),
    goal: String(raw["goal"] ?? ""),
    repo: (raw["repo"] as string) || "",
    branch: (raw["branch"] as string) || "",
    status: String(raw["status"] ?? "active"),
    leader: (raw["leader"] ?? null) as LeaderBinding | null,
    heartbeats: hb ?? {
      checkup_id: null,
      deep_id: null,
      confirmed_at: null,
      schedule_id: null,
      orchestrator_checkup_id: null,
      generation_started_at: null,
      digest_last_written_at: null,
      checkup_history: [],
    },
    workers: (raw["workers"] ?? []) as WorkerRecord[],
    queue: (raw["queue"] ?? []) as QueueItem[],
    handoff: ho ?? {
      state: "none",
      from_agent: null,
      to_agent: null,
      reason: "",
      started_at: null,
      completed_at: null,
    },
    turn_count: Number(raw["turn_count"] ?? 0),
    created_at: String(raw["created_at"] ?? ""),
    updated_at: String(raw["updated_at"] ?? ""),
    overrides: (raw["overrides"] ?? {}) as Record<string, unknown>,
    overrides_provenance: (raw["overrides_provenance"] ?? {}) as Record<string, unknown>,
  };
}
