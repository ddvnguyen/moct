/**
 * Team memory (schema v8, design v5). Typed records with visibility tags, every
 * change kept as a version row. Backend-owned state, not a projection of
 * team_operations: how_to_work follows an expert across Workspaces, and a purge
 * must remove text, which an append-only log cannot. No ledger op kind is added.
 *
 *   type         home            visible to
 *   rule         team | channel  that team or channel           priority 100, always loads
 *   decision     channel | task  the whole team (+ its home)    priority 80
 *   convention   team | channel  that team or channel           priority 60
 *   how_to_work  expert          that expert (+ orchestrators)  priority 60
 *   task         task            the whole team                 priority 40, one per task
 *   branch       channel         the whole team                 priority 40, one per repo+branch
 *
 * Visibility tags are team / channel / task / expert; repo / branch tags only
 * describe. `home` is the narrowest visibility tag (task < channel < team).
 *
 * The backend has no auth (loopback). It cannot tell a human from a model, so the
 * caller asserts `actor` and the reader's scope; the plugin is the trust boundary
 * and fills both from the session, never from model input. What this store
 * enforces: type and home shape, who may write what (human, orchestrator,
 * worker), approval, the per-home always-load cap, and that every read is
 * filtered by the scope the caller names.
 */
import { randomUUID } from "node:crypto";
import type { TeamDb } from "../store/team-db.js";
import { detectSecret } from "./secret-filter.js";

export const MEMORY_TYPES = ["rule", "decision", "convention", "how_to_work", "task", "branch"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MEMORY_HOMES = ["task", "channel", "team", "expert"] as const;
export type HomeKind = (typeof MEMORY_HOMES)[number];
export type MemoryStatus = "pending" | "active" | "superseded" | "retracted" | "expired" | "purged";
export const MEMORY_STATUSES: readonly MemoryStatus[] = ["pending", "active", "superseded", "retracted", "expired", "purged"];
export type TagKind = "team" | "channel" | "task" | "expert" | "repo" | "branch";

export const TYPE_PRIORITY: Readonly<Record<MemoryType, number>> = {
  rule: 100,
  decision: 80,
  convention: 60,
  how_to_work: 60,
  task: 40,
  branch: 40,
};
/** Where each type may live. A widen moves a record to a wider home in this list. */
export const TYPE_HOMES: Readonly<Record<MemoryType, readonly HomeKind[]>> = {
  rule: ["channel", "team"],
  convention: ["channel", "team"],
  decision: ["task", "channel"],
  how_to_work: ["expert"],
  task: ["task"],
  branch: ["channel"],
};
/** The team's task picture: always carries the team tag. */
const TEAM_VISIBLE: ReadonlySet<MemoryType> = new Set(["decision", "task", "branch"]);
/** Only these expire when idle; rules and the task picture are kept. */
const EXPIRING: readonly MemoryType[] = ["convention", "how_to_work"];
/** Narrowest first: the order injection fills buckets in, and the conflict tie-break. */
const HOME_RANK: Readonly<Record<HomeKind, number>> = { task: 0, channel: 1, team: 2, expert: 3 };
const INJECT_ORDER: readonly HomeKind[] = ["task", "channel", "team", "expert"];

/** Content caps, in characters. All versions are kept, so these also bound history growth. */
export const MEMORY_MAX_TITLE_CHARS = 200;
export const MEMORY_MAX_BODY_CHARS = 2000;
/** Auto-load target per layer (home). */
export const MEMORY_INJECT_LAYER_TOKENS = 1000;
/** Hard ceiling per home for what always loads (rules and pinned records), and for the setting. */
export const MEMORY_INJECT_LAYER_CAP_TOKENS = 2000;
/** Unpinned conventions and how_to_work notes expire this long after their last edit or citation. */
export const MEMORY_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const MEMORY_INDEX_IDS_PER_LAYER = 5;
const NEAR_MATCH_LIMIT = 3;
const BUDGET_LARGEST = 5;

export interface MemorySettings {
  /** "required": a worker's rule, decision and how_to_work start pending. */
  expertApproval: "off" | "required";
  /** First-mate experts (Lead, Architect): full memory access and control. */
  orchestrators: string[];
  injectLayerTokens: number;
}
export const MEMORY_SETTING_DEFAULTS: MemorySettings = {
  expertApproval: "required",
  orchestrators: [],
  injectLayerTokens: MEMORY_INJECT_LAYER_TOKENS,
};

export interface MemoryActor {
  readonly kind: "human" | "member";
  readonly id: string;
}
type Role = "human" | "orchestrator" | "worker";

/** What a reader may see. The plugin fills it from the session. */
export interface MemoryScope {
  readonly workspaceId: string;
  readonly expertId: string;
  readonly channels?: readonly string[];
  readonly tasks?: readonly string[];
  /** Orchestrators and the human: everything in the Workspace, plus every how_to_work. */
  readonly all?: boolean;
}

export interface MemoryHome {
  kind: HomeKind;
  ref: string;
}
export interface MemoryTag {
  kind: TagKind;
  ref: string;
}

export interface MemoryRecord {
  id: string;
  workspaceId: string | null;
  type: MemoryType;
  title: string | null;
  body: string | null;
  attrs: Record<string, unknown> | null;
  home: MemoryHome;
  tags: MemoryTag[];
  priority: number;
  pinned: boolean;
  status: MemoryStatus;
  /** "blocked_budget": approved, but its home's always-load set is full. */
  flag: string | null;
  supersedes: string | null;
  supersededBy: string | null;
  conflictsWith: string[];
  taskRef: string | null;
  uniqueKey: string | null;
  authorKind: "human" | "member";
  authorId: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
  version: number;
  tokens: number;
}

export interface MemoryVersion {
  memoryId: string;
  version: number;
  action: string;
  workspaceId: string | null;
  type: MemoryType;
  home: MemoryHome;
  tags: MemoryTag[];
  title: string | null;
  body: string | null;
  attrs: Record<string, unknown> | null;
  priority: number;
  pinned: boolean;
  status: MemoryStatus;
  actorKind: string;
  actorId: string;
  reason: string;
  at: string;
}

/** A refusal with a stable code the client can branch on. */
export class MemoryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Same estimate the plugin's thread seed uses: UTF-8 bytes / 3. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

function recordTokens(title: string | null, body: string | null): number {
  return estimateTokens(`${title ?? ""}\n${body ?? ""}`);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

function isHome(value: unknown): value is HomeKind {
  return typeof value === "string" && (MEMORY_HOMES as readonly string[]).includes(value);
}

function invalid(message: string): MemoryError {
  return new MemoryError(400, "INVALID_INPUT", message);
}

/** Same-byte-length filler a purge or edit writes over text first, so the old bytes are overwritten in place. */
function scrubFiller(text: string): string {
  return "#".repeat(Buffer.byteLength(text, "utf8"));
}

/** Two notes count as the same text when they match after case and whitespace folding. */
function dedupeKey(title: string | null, body: string | null): string {
  return `${title ?? ""}\n${body ?? ""}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function titleWords(title: string | null): Set<string> {
  return new Set(
    (title ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

/** Mem0-style near match: half or more of the title words shared. */
function similarTitles(a: string | null, b: string | null): boolean {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.size === 0 || wb.size === 0) return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / (wa.size + wb.size - shared) >= 0.5;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Validation

const ATTR_KEYS: Readonly<Record<MemoryType, readonly string[]>> = {
  rule: ["level"],
  decision: ["decidedBy", "sourceRef", "date"],
  convention: [],
  how_to_work: [],
  task: ["taskRef", "threadRef", "state", "owner"],
  branch: ["repo", "branch", "base", "pr", "state"],
};

function oneOf(value: unknown, allowed: readonly string[], field: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) throw invalid(`${field} must be one of ${allowed.join(", ")}`);
  return value;
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && !nonEmpty(value)) throw invalid(`${field} must be a non-empty string`);
}

/** Per-type attrs. Unknown keys are refused, so nothing unvalidated reaches a prompt. */
function checkAttrs(type: MemoryType, raw: unknown): Record<string, unknown> {
  const attrs = raw === undefined || raw === null ? {} : raw;
  if (typeof attrs !== "object" || Array.isArray(attrs)) throw invalid("attrs must be an object");
  const record = attrs as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ATTR_KEYS[type].includes(key)) throw invalid(`attrs.${key} is not allowed on ${type}`);
  }
  switch (type) {
    case "rule":
      oneOf(record["level"], ["must", "should"], "attrs.level");
      break;
    case "decision":
      if (!nonEmpty(record["decidedBy"])) throw invalid("attrs.decidedBy is required");
      if (!nonEmpty(record["sourceRef"])) throw invalid("attrs.sourceRef is required");
      if (record["date"] !== undefined && !(typeof record["date"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record["date"]))) {
        throw invalid("attrs.date must be YYYY-MM-DD");
      }
      break;
    case "task":
      if (!(typeof record["taskRef"] === "string" && record["taskRef"].startsWith("task:"))) {
        throw invalid("attrs.taskRef must be a task:… ref");
      }
      if (record["threadRef"] !== undefined && !(typeof record["threadRef"] === "string" && record["threadRef"].startsWith("thread:"))) {
        throw invalid("attrs.threadRef must be a thread:… ref");
      }
      oneOf(record["state"], ["open", "blocked", "done"], "attrs.state");
      optionalString(record["owner"], "attrs.owner");
      break;
    case "branch":
      if (!(typeof record["repo"] === "string" && /^[\w.-]+\/[\w.-]+$/.test(record["repo"]))) {
        throw invalid("attrs.repo must be owner/name");
      }
      if (!nonEmpty(record["branch"])) throw invalid("attrs.branch is required");
      optionalString(record["base"], "attrs.base");
      if (record["pr"] !== undefined && !(Number.isSafeInteger(record["pr"]) && (record["pr"] as number) > 0)) {
        throw invalid("attrs.pr must be a positive integer");
      }
      oneOf(record["state"], ["open", "merged", "closed"], "attrs.state");
      break;
    default:
      break;
  }
  return record;
}

interface CheckedText {
  title: string;
  body: string;
  attrs: Record<string, unknown>;
}

function checkText(type: MemoryType, title: unknown, body: unknown, attrs: unknown): CheckedText {
  if (!nonEmpty(title)) throw invalid("title is required");
  if ([...title].length > MEMORY_MAX_TITLE_CHARS) {
    throw new MemoryError(400, "CONTENT_TOO_LONG", `title is limited to ${MEMORY_MAX_TITLE_CHARS} characters`);
  }
  const text = body === undefined || body === null ? "" : body;
  if (typeof text !== "string") throw invalid("body must be a string");
  if (text.trim().length === 0 && type !== "task" && type !== "branch") throw invalid("body is required");
  if ([...text].length > MEMORY_MAX_BODY_CHARS) {
    throw new MemoryError(400, "CONTENT_TOO_LONG", `body is limited to ${MEMORY_MAX_BODY_CHARS} characters`);
  }
  const checkedAttrs = checkAttrs(type, attrs);
  for (const candidate of [title, text, JSON.stringify(checkedAttrs)]) {
    const rule = detectSecret(candidate);
    // The rule name only: echoing the match would put the secret into logs and transcripts.
    if (rule !== null) throw new MemoryError(422, "SECRET_DETECTED", `content looks like a credential (rule: ${rule})`);
  }
  return { title, body: text, attrs: checkedAttrs };
}

function uniqueKeyFor(type: MemoryType, attrs: Record<string, unknown>): string | null {
  if (type === "task") return String(attrs["taskRef"]);
  if (type === "branch") return `branch:${String(attrs["repo"])}#${String(attrs["branch"])}`;
  return null;
}

/** Visibility tags for a home, plus the team tag for the task picture and descriptive tags. */
function tagsFor(type: MemoryType, workspaceId: string | null, home: MemoryHome, attrs: Record<string, unknown>): MemoryTag[] {
  const tags: MemoryTag[] = [{ kind: home.kind, ref: home.ref }];
  if (TEAM_VISIBLE.has(type) && home.kind !== "team" && workspaceId !== null) tags.push({ kind: "team", ref: workspaceId });
  if (type === "branch") {
    tags.push({ kind: "repo", ref: String(attrs["repo"]) });
    tags.push({ kind: "branch", ref: `${String(attrs["repo"])}#${String(attrs["branch"])}` });
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Rows

function rowToRecord(row: Record<string, unknown>, tags: MemoryTag[]): MemoryRecord {
  const title = (row["title"] as string | null) ?? null;
  const body = (row["body"] as string | null) ?? null;
  return {
    id: String(row["id"]),
    workspaceId: (row["workspace_id"] as string | null) ?? null,
    type: row["type"] as MemoryType,
    title,
    body,
    attrs: row["attrs"] === null || row["attrs"] === undefined ? null : parseJson<Record<string, unknown>>(row["attrs"], {}),
    home: { kind: row["home_kind"] as HomeKind, ref: String(row["home_ref"]) },
    tags,
    priority: Number(row["priority"]),
    pinned: Number(row["pinned"]) === 1,
    status: row["status"] as MemoryStatus,
    flag: (row["flag"] as string | null) ?? null,
    supersedes: (row["supersedes"] as string | null) ?? null,
    supersededBy: (row["superseded_by"] as string | null) ?? null,
    conflictsWith: parseJson<string[]>(row["conflicts_with"], []),
    taskRef: (row["task_ref"] as string | null) ?? null,
    uniqueKey: (row["unique_key"] as string | null) ?? null,
    authorKind: row["author_kind"] as "human" | "member",
    authorId: String(row["author_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    lastUsedAt: (row["last_used_at"] as string | null) ?? null,
    useCount: Number(row["use_count"] ?? 0),
    version: Number(row["version"]),
    tokens: recordTokens(title, body),
  };
}

function rowToVersion(row: Record<string, unknown>): MemoryVersion {
  return {
    memoryId: String(row["memory_id"]),
    version: Number(row["version"]),
    action: String(row["action"]),
    workspaceId: (row["workspace_id"] as string | null) ?? null,
    type: row["type"] as MemoryType,
    home: { kind: row["home_kind"] as HomeKind, ref: String(row["home_ref"]) },
    tags: parseJson<MemoryTag[]>(row["tags_json"], []),
    title: (row["title"] as string | null) ?? null,
    body: (row["body"] as string | null) ?? null,
    attrs: row["attrs"] === null || row["attrs"] === undefined ? null : parseJson<Record<string, unknown>>(row["attrs"], {}),
    priority: Number(row["priority"]),
    pinned: Number(row["pinned"]) === 1,
    status: row["status"] as MemoryStatus,
    actorKind: String(row["actor_kind"]),
    actorId: String(row["actor_id"]),
    reason: String(row["reason"]),
    at: String(row["at"]),
  };
}

function isAuthor(record: MemoryRecord, actor: MemoryActor): boolean {
  return record.authorKind === actor.kind && record.authorId === actor.id;
}

/** True when a record always loads in its home, and so counts against the cap. */
function alwaysLoads(record: { type: MemoryType; pinned: boolean }): boolean {
  return record.type === "rule" || record.pinned;
}

// ---------------------------------------------------------------------------
// Inputs and outputs

export interface NoteInput {
  readonly type: unknown;
  readonly title: unknown;
  readonly body?: unknown;
  readonly attrs?: unknown;
  /** The home the plugin resolved from the session (current task, channel, workspace, self). */
  readonly home: { readonly kind: unknown; readonly ref: unknown };
  readonly workspaceId: string;
  readonly taskRef?: string | null;
  readonly pinned?: boolean;
  readonly confirmNew?: boolean;
  /** Replace this record with the new one (same type). */
  readonly supersedes?: string | null;
  readonly supersedesVersion?: number;
  readonly actor: MemoryActor;
}

export interface NearMatch {
  id: string;
  type: MemoryType;
  title: string | null;
  home: MemoryHome;
  status: MemoryStatus;
}

export interface NoteResult {
  /** null when near matches held the write back. */
  record: MemoryRecord | null;
  nearMatches: NearMatch[];
  /** For task and branch: what the idempotent upsert did. */
  upsert?: "created" | "updated" | "unchanged";
  notice?: string;
}

export interface SearchQuery {
  readonly scope: MemoryScope;
  readonly q?: string;
  readonly types?: readonly MemoryType[];
  readonly homes?: readonly HomeKind[];
  /** One status, or "all". Defaults to active. */
  readonly status?: MemoryStatus | "all";
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface SearchResult {
  results: MemoryRecord[];
  total: number;
  nextCursor: string | null;
}

export interface LinkedRecord {
  kind: string;
  id: string;
  type: MemoryType;
  title: string | null;
}

export interface InjectQuery {
  readonly expertId: string;
  readonly workspaceId: string;
  readonly channelRef?: string;
  readonly taskRef?: string;
  /** Per-layer budget for this call; defaults to the injectLayerTokens setting, capped either way. */
  readonly layerTokens?: number;
}

export interface InjectedRecord {
  id: string;
  type: MemoryType;
  title: string | null;
  body: string | null;
  attrs: Record<string, unknown> | null;
  home: MemoryHome;
  priority: number;
  pinned: boolean;
  tokens: number;
}

export interface MemoryLayerIndex {
  home: MemoryHome;
  /** Active records in this home that were not loaded. */
  more: number;
  items: { id: string; type: MemoryType; title: string | null; tokens: number; pinned: boolean; conflictsWith?: string[] }[];
}

export interface MemoryInjection {
  entries: InjectedRecord[];
  /** Records left out because their layer's budget was spent. */
  omitted: number;
  /** Records skipped because a narrower layer already loaded the same text. */
  duplicates: number;
  /** Records left out because a conflicting record won. */
  conflicts: number;
  tokens: number;
  layerTokens: number;
  index: MemoryLayerIndex[];
}

const SYSTEM_SWEEP: MemoryActor = { kind: "human", id: "system:expiry-sweep" };

export class TeamMemoryStore {
  constructor(
    private readonly db: TeamDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private iso(): string {
    return this.now().toISOString();
  }

  // -- settings and roles ---------------------------------------------------

  async settings(): Promise<MemorySettings> {
    const rows = await this.db.all("SELECT key, value FROM team_memory_settings");
    const settings: MemorySettings = { ...MEMORY_SETTING_DEFAULTS, orchestrators: [] };
    for (const row of rows) {
      const value = row["value"];
      if (row["key"] === "expert_approval" && (value === "off" || value === "required")) {
        settings.expertApproval = value;
      } else if (row["key"] === "orchestrators") {
        const ids = parseJson<unknown>(value, []);
        if (Array.isArray(ids)) settings.orchestrators = ids.filter(nonEmpty);
      } else if (row["key"] === "inject_layer_tokens") {
        const n = Number(value);
        if (Number.isInteger(n) && n > 0) settings.injectLayerTokens = Math.min(n, MEMORY_INJECT_LAYER_CAP_TOKENS);
      }
    }
    return settings;
  }

  private async putSetting(key: string, value: string, actor: MemoryActor): Promise<void> {
    await this.db.run(
      `INSERT INTO team_memory_settings(key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      key,
      value,
      this.iso(),
      actor.id,
    );
  }

  async updateSettings(input: {
    expertApproval?: unknown;
    orchestrators?: unknown;
    injectLayerTokens?: unknown;
    actor: MemoryActor;
  }): Promise<MemorySettings> {
    requireHuman(input.actor, "changing memory settings");
    const { expertApproval, orchestrators, injectLayerTokens } = input;
    if (expertApproval !== undefined && expertApproval !== "off" && expertApproval !== "required") {
      throw new MemoryError(400, "INVALID_SETTING", "expertApproval must be off or required");
    }
    if (orchestrators !== undefined && (!Array.isArray(orchestrators) || !orchestrators.every(nonEmpty))) {
      throw new MemoryError(400, "INVALID_SETTING", "orchestrators must be a list of member ids");
    }
    if (
      injectLayerTokens !== undefined &&
      (!Number.isInteger(injectLayerTokens) ||
        (injectLayerTokens as number) < 1 ||
        (injectLayerTokens as number) > MEMORY_INJECT_LAYER_CAP_TOKENS)
    ) {
      throw new MemoryError(400, "INVALID_SETTING", `injectLayerTokens must be 1..${MEMORY_INJECT_LAYER_CAP_TOKENS}`);
    }
    await this.db.transaction(async () => {
      if (expertApproval !== undefined) await this.putSetting("expert_approval", expertApproval as string, input.actor);
      if (orchestrators !== undefined) {
        await this.putSetting("orchestrators", JSON.stringify([...new Set(orchestrators as string[])]), input.actor);
      }
      if (injectLayerTokens !== undefined) await this.putSetting("inject_layer_tokens", String(injectLayerTokens), input.actor);
    });
    return this.settings();
  }

  private async role(actor: MemoryActor): Promise<Role> {
    if (actor.kind === "human") return "human";
    return (await this.settings()).orchestrators.includes(actor.id) ? "orchestrator" : "worker";
  }

  private async requireOrchestrator(actor: MemoryActor, verb: string): Promise<Role> {
    const role = await this.role(actor);
    if (role === "worker") throw new MemoryError(403, "ORCHESTRATOR_ONLY", `${verb} is reserved for orchestrators and the human`);
    return role;
  }

  /**
   * The status a write lands in. A worker's rule, decision and how_to_work wait
   * for approval (when expert_approval is required); a team-scoped rule from
   * anyone but the human always waits for the human.
   */
  private async statusFor(type: MemoryType, home: HomeKind, role: Role): Promise<MemoryStatus> {
    if (role === "human") return "active";
    if (type === "rule" && home === "team") return "pending";
    if (role === "orchestrator") return "active";
    if (type === "rule" || type === "decision" || type === "how_to_work") {
      return (await this.settings()).expertApproval === "required" ? "pending" : "active";
    }
    return "active";
  }

  // -- reads ------------------------------------------------------------------

  private async tagsOf(ids: readonly string[]): Promise<Map<string, MemoryTag[]>> {
    const out = new Map<string, MemoryTag[]>();
    if (ids.length === 0) return out;
    const rows = await this.db.all(
      `SELECT record_id, kind, ref FROM team_memory_tags WHERE record_id IN (${placeholders(ids.length)}) ORDER BY kind, ref`,
      ...ids,
    );
    for (const row of rows) {
      const id = String(row["record_id"]);
      const list = out.get(id) ?? [];
      list.push({ kind: row["kind"] as TagKind, ref: String(row["ref"]) });
      out.set(id, list);
    }
    return out;
  }

  private async hydrate(rows: Record<string, unknown>[]): Promise<MemoryRecord[]> {
    const tags = await this.tagsOf(rows.map((r) => String(r["id"])));
    return rows.map((row) => rowToRecord(row, tags.get(String(row["id"])) ?? []));
  }

  /** Unscoped read, for the human's Memory page and for the store itself. */
  async get(id: string): Promise<MemoryRecord | undefined> {
    const row = await this.db.get("SELECT * FROM team_memory_records WHERE id = ?", id);
    return row === undefined ? undefined : (await this.hydrate([row]))[0];
  }

  private async require(id: string): Promise<MemoryRecord> {
    const record = await this.get(id);
    if (record === undefined) throw new MemoryError(404, "NOT_FOUND", "no such memory record");
    return record;
  }

  private checkBase(record: MemoryRecord, baseVersion: number): void {
    if (record.version !== baseVersion) {
      throw new MemoryError(409, "VERSION_STALE", `record is at version ${record.version}, not ${baseVersion}`);
    }
  }

  /** SQL that limits `r` to what the scope may see. */
  private visibility(scope: MemoryScope): { sql: string; params: unknown[] } {
    if (!nonEmpty(scope.workspaceId) || !nonEmpty(scope.expertId)) {
      throw new MemoryError(400, "INVALID_SCOPE", "scope needs workspaceId and expertId");
    }
    if (scope.all === true) {
      return { sql: "(r.workspace_id = ? OR r.workspace_id IS NULL)", params: [scope.workspaceId] };
    }
    const ors = ["(t.kind = 'team' AND t.ref = ?)", "(t.kind = 'expert' AND t.ref = ?)"];
    const params: unknown[] = [scope.workspaceId, scope.expertId];
    const channels = (scope.channels ?? []).filter(nonEmpty);
    const tasks = (scope.tasks ?? []).filter(nonEmpty);
    if (channels.length > 0) {
      ors.push(`(t.kind = 'channel' AND t.ref IN (${placeholders(channels.length)}))`);
      params.push(...channels);
    }
    if (tasks.length > 0) {
      ors.push(`(t.kind = 'task' AND t.ref IN (${placeholders(tasks.length)}))`);
      params.push(...tasks);
    }
    return {
      sql: `(r.workspace_id = ? OR r.workspace_id IS NULL) AND EXISTS (SELECT 1 FROM team_memory_tags t WHERE t.record_id = r.id AND (${ors.join(" OR ")}))`,
      params: [scope.workspaceId, ...params],
    };
  }

  /** memory_search: what the scope may see, newest and most important first. Does not count as a citation. */
  async search(query: SearchQuery): Promise<SearchResult> {
    const vis = this.visibility(query.scope);
    const where = [vis.sql];
    const params = [...vis.params];
    const status = query.status ?? "active";
    if (status !== "all") {
      if (!(MEMORY_STATUSES as readonly string[]).includes(status)) throw invalid(`unknown status ${status}`);
      where.push("r.status = ?");
      params.push(status);
    }
    if (query.types !== undefined && query.types.length > 0) {
      for (const type of query.types) if (!isType(type)) throw invalid(`unknown type ${String(type)}`);
      where.push(`r.type IN (${placeholders(query.types.length)})`);
      params.push(...query.types);
    }
    if (query.homes !== undefined && query.homes.length > 0) {
      for (const home of query.homes) if (!isHome(home)) throw invalid(`unknown home ${String(home)}`);
      where.push(`r.home_kind IN (${placeholders(query.homes.length)})`);
      params.push(...query.homes);
    }
    // Keyword search: every word must appear in the title or body, case-insensitive.
    // No FTS on this Turso version; the embedding column is reserved for vector search.
    const words = (query.q ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 0).slice(0, 8);
    for (const word of words) {
      where.push("(instr(lower(coalesce(r.title, '')), ?) > 0 OR instr(lower(coalesce(r.body, '')), ?) > 0)");
      params.push(word, word);
    }
    const limit = query.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw invalid("limit must be 1..20");
    const offset = query.cursor === undefined || query.cursor === null || query.cursor === "" ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid("cursor is not valid");
    const whereSql = where.join(" AND ");
    const total = Number((await this.db.get(`SELECT count(*) AS n FROM team_memory_records r WHERE ${whereSql}`, ...params))?.["n"] ?? 0);
    const rows = await this.db.all(
      `SELECT r.* FROM team_memory_records r WHERE ${whereSql}
       ORDER BY r.priority DESC, r.pinned DESC, r.updated_at DESC, r.id LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    const results = await this.hydrate(rows);
    return { results, total, nextCursor: offset + results.length < total ? String(offset + results.length) : null };
  }

  /**
   * memory_get: full records the scope may see. An id it may not see, an id that
   * does not exist and a purged record all land in `missing`, so a get never
   * reveals that a record exists. A get counts as a citation.
   */
  async getMany(ids: readonly string[], scope: MemoryScope): Promise<{ records: (MemoryRecord & { links: LinkedRecord[] })[]; missing: string[] }> {
    const unique = [...new Set(ids)];
    if (unique.length === 0 || unique.length > 10 || !unique.every(nonEmpty)) throw invalid("pass 1..10 ids");
    const vis = this.visibility(scope);
    const rows = await this.db.all(
      `SELECT r.* FROM team_memory_records r WHERE r.id IN (${placeholders(unique.length)}) AND r.status <> 'purged' AND ${vis.sql}`,
      ...unique,
      ...vis.params,
    );
    const found = await this.hydrate(rows);
    await this.cite(found);
    const records = [];
    for (const record of found) records.push({ ...record, links: await this.linksOf(record.id, scope) });
    const seen = new Set(found.map((r) => r.id));
    return { records, missing: unique.filter((id) => !seen.has(id)) };
  }

  /** Links touching a record, limited to the other ends the scope may see. */
  private async linksOf(id: string, scope: MemoryScope): Promise<LinkedRecord[]> {
    const vis = this.visibility(scope);
    const rows = await this.db.all(
      `SELECT l.kind AS link_kind, r.id, r.type, r.title FROM team_memory_links l
       JOIN team_memory_records r ON r.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
       WHERE (l.from_id = ? OR l.to_id = ?) AND r.status <> 'purged' AND ${vis.sql}
       ORDER BY l.kind, r.id`,
      id,
      id,
      id,
      ...vis.params,
    );
    return rows.map((row) => ({
      kind: String(row["link_kind"]),
      id: String(row["id"]),
      type: row["type"] as MemoryType,
      title: (row["title"] as string | null) ?? null,
    }));
  }

  /** Reset the expiry clock of the unpinned active records an expert just fetched. */
  private async cite(records: MemoryRecord[]): Promise<void> {
    const unpinned = records.filter((r) => !r.pinned && r.status === "active");
    if (unpinned.length === 0) return;
    const at = this.iso();
    await this.db.transaction(async () => {
      for (const record of unpinned) {
        await this.db.run("UPDATE team_memory_records SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?", at, record.id);
        record.lastUsedAt = at;
        record.useCount += 1;
      }
    });
  }

  async versions(id: string): Promise<MemoryVersion[]> {
    await this.require(id);
    const rows = await this.db.all("SELECT * FROM team_memory_versions WHERE memory_id = ? ORDER BY version DESC", id);
    return rows.map(rowToVersion);
  }

  /** The rule change feed for the Memory page: every rule version in a Workspace, newest first. */
  async ruleFeed(workspaceId: string, limit = 50): Promise<MemoryVersion[]> {
    if (!nonEmpty(workspaceId)) throw new MemoryError(400, "INVALID_SCOPE", "workspaceId is required");
    const rows = await this.db.all(
      `SELECT * FROM team_memory_versions WHERE workspace_id = ? AND type = 'rule'
       ORDER BY at DESC, memory_id, version DESC LIMIT ?`,
      workspaceId,
      Math.min(Math.max(limit, 1), 200),
    );
    return rows.map(rowToVersion);
  }

  // -- writes: shared pieces ----------------------------------------------------

  private async recordVersion(record: MemoryRecord, action: string, actor: MemoryActor, reason: string, at: string): Promise<void> {
    await this.db.run(
      `INSERT INTO team_memory_versions(memory_id, version, action, workspace_id, type, home_kind, home_ref, tags_json,
         title, body, attrs, priority, pinned, status, actor_kind, actor_id, reason, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.version,
      action,
      record.workspaceId,
      record.type,
      record.home.kind,
      record.home.ref,
      JSON.stringify(record.tags),
      record.title,
      record.body,
      record.attrs === null ? null : JSON.stringify(record.attrs),
      record.priority,
      record.pinned ? 1 : 0,
      record.status,
      actor.kind,
      actor.id,
      reason,
      at,
    );
  }

  private async writeTags(record: MemoryRecord): Promise<void> {
    await this.db.run("DELETE FROM team_memory_tags WHERE record_id = ?", record.id);
    for (const tag of record.tags) {
      await this.db.run("INSERT INTO team_memory_tags(record_id, kind, ref) VALUES (?, ?, ?)", record.id, tag.kind, tag.ref);
    }
  }

  private async insert(record: MemoryRecord, actor: MemoryActor, reason: string): Promise<void> {
    await this.db.run(
      `INSERT INTO team_memory_records(id, workspace_id, type, title, body, attrs, home_kind, home_ref, priority, pinned,
         status, flag, supersedes, superseded_by, conflicts_with, task_ref, unique_key, author_kind, author_id,
         created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.workspaceId,
      record.type,
      record.title,
      record.body,
      record.attrs === null ? null : JSON.stringify(record.attrs),
      record.home.kind,
      record.home.ref,
      record.priority,
      record.pinned ? 1 : 0,
      record.status,
      record.flag,
      record.supersedes,
      record.supersededBy,
      JSON.stringify(record.conflictsWith),
      record.taskRef,
      record.uniqueKey,
      record.authorKind,
      record.authorId,
      record.createdAt,
      record.updatedAt,
      record.version,
    );
    await this.writeTags(record);
    await this.recordVersion(record, "create", actor, reason, record.createdAt);
  }

  /** Write a record's mutable columns and its next version row. */
  private async commit(next: MemoryRecord, action: string, actor: MemoryActor, reason: string): Promise<MemoryRecord> {
    await this.db.run(
      `UPDATE team_memory_records SET title = ?, body = ?, attrs = ?, home_kind = ?, home_ref = ?, priority = ?, pinned = ?,
         status = ?, flag = ?, superseded_by = ?, unique_key = ?, updated_at = ?, version = ?
       WHERE id = ?`,
      next.title,
      next.body,
      next.attrs === null ? null : JSON.stringify(next.attrs),
      next.home.kind,
      next.home.ref,
      next.priority,
      next.pinned ? 1 : 0,
      next.status,
      next.flag,
      next.supersededBy,
      next.uniqueKey,
      next.updatedAt,
      next.version,
      next.id,
    );
    await this.recordVersion(next, action, actor, reason, next.updatedAt);
    return { ...next, tokens: recordTokens(next.title, next.body) };
  }

  /** Overwrite text in place before it is replaced, so the old bytes do not linger in the page. */
  private async scrubRecordText(record: MemoryRecord): Promise<void> {
    await this.db.run(
      "UPDATE team_memory_records SET title = ?, body = ?, attrs = ? WHERE id = ?",
      record.title === null ? null : scrubFiller(record.title),
      record.body === null ? null : scrubFiller(record.body),
      record.attrs === null ? null : scrubFiller(JSON.stringify(record.attrs)),
      record.id,
    );
  }

  /**
   * Refuse a write that would push a home's always-load set (rules and pinned
   * records) past the cap. The refusal names the largest consumers, so a human
   * or orchestrator can unpin or retract the right thing.
   */
  private async assertBudget(workspaceId: string | null, home: MemoryHome, addTokens: number, excludeId: string | null): Promise<void> {
    const params: unknown[] = [home.kind, home.ref];
    let sql = `SELECT * FROM team_memory_records WHERE home_kind = ? AND home_ref = ? AND status = 'active'
               AND (type = 'rule' OR pinned = 1)`;
    if (home.kind !== "expert") {
      sql += " AND workspace_id = ?";
      params.push(workspaceId);
    }
    const rows = (await this.db.all(sql, ...params)).filter((row) => String(row["id"]) !== excludeId);
    const consumers = rows.map((row) => ({
      id: String(row["id"]),
      type: row["type"] as MemoryType,
      title: (row["title"] as string | null) ?? null,
      tokens: recordTokens((row["title"] as string | null) ?? null, (row["body"] as string | null) ?? null),
      pinned: Number(row["pinned"]) === 1,
    }));
    const used = consumers.reduce((sum, c) => sum + c.tokens, 0);
    if (used + addTokens <= MEMORY_INJECT_LAYER_CAP_TOKENS) return;
    consumers.sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
    throw new MemoryError(409, "BUDGET_FULL", `the ${home.kind} home's always-load set would exceed ${MEMORY_INJECT_LAYER_CAP_TOKENS} tokens`, {
      home,
      capTokens: MEMORY_INJECT_LAYER_CAP_TOKENS,
      usedTokens: used,
      neededTokens: addTokens,
      largest: consumers.slice(0, BUDGET_LARGEST),
    });
  }

  /** Link a record to the task record its cited taskRef names. The model never names link targets. */
  private async linkTask(record: MemoryRecord): Promise<void> {
    if (record.workspaceId === null) return;
    if (record.type === "task") {
      // A new task record collects the decisions and branches that cited it earlier.
      const taskRef = String(record.attrs?.["taskRef"]);
      const citing = await this.db.all(
        "SELECT id, type FROM team_memory_records WHERE workspace_id = ? AND task_ref = ? AND type IN ('decision', 'branch')",
        record.workspaceId,
        taskRef,
      );
      for (const row of citing) {
        if (row["type"] === "decision") await this.link(String(row["id"]), record.id, "decided_in");
        else await this.link(record.id, String(row["id"]), "on_branch");
      }
      return;
    }
    if (record.taskRef === null || (record.type !== "decision" && record.type !== "branch")) return;
    const task = await this.db.get(
      "SELECT id FROM team_memory_records WHERE workspace_id = ? AND unique_key = ?",
      record.workspaceId,
      record.taskRef,
    );
    if (task === undefined) return;
    if (record.type === "decision") await this.link(record.id, String(task["id"]), "decided_in");
    else await this.link(String(task["id"]), record.id, "on_branch");
  }

  private async link(fromId: string, toId: string, kind: string): Promise<void> {
    await this.db.run("INSERT OR IGNORE INTO team_memory_links(from_id, to_id, kind) VALUES (?, ?, ?)", fromId, toId, kind);
  }

  private async nearMatches(type: MemoryType, workspaceId: string | null, home: MemoryHome, title: string): Promise<NearMatch[]> {
    const params: unknown[] = [type];
    let sql = "SELECT * FROM team_memory_records WHERE type = ? AND status IN ('active', 'pending')";
    if (workspaceId === null) {
      sql += " AND home_kind = 'expert' AND home_ref = ?";
      params.push(home.ref);
    } else {
      sql += " AND workspace_id = ?";
      params.push(workspaceId);
    }
    const rows = await this.db.all(`${sql} ORDER BY updated_at DESC, id`, ...params);
    const out: NearMatch[] = [];
    for (const row of rows) {
      const other = (row["title"] as string | null) ?? null;
      if (!similarTitles(title, other)) continue;
      out.push({
        id: String(row["id"]),
        type,
        title: other,
        home: { kind: row["home_kind"] as HomeKind, ref: String(row["home_ref"]) },
        status: row["status"] as MemoryStatus,
      });
      if (out.length >= NEAR_MATCH_LIMIT) break;
    }
    return out;
  }

  // -- writes: verbs ------------------------------------------------------------

  /**
   * memory_note create. The home is resolved by the plugin; this store checks it
   * against the type and the writer's role. Task and branch records are an
   * idempotent upsert on their unique key, kept by orchestrators only. Near
   * matches hold a write back unless the writer confirms it is new (the matches
   * are then recorded as conflicts).
   */
  async note(input: NoteInput): Promise<NoteResult> {
    if (!isType(input.type)) throw invalid(`type must be one of ${MEMORY_TYPES.join(", ")}`);
    const type = input.type;
    if (!isHome(input.home?.kind) || !nonEmpty(input.home?.ref)) throw invalid("home needs a kind and a ref");
    const home: MemoryHome = { kind: input.home.kind, ref: input.home.ref };
    if (!TYPE_HOMES[type].includes(home.kind)) {
      throw new MemoryError(403, "SCOPE_FORBIDDEN", `${type} cannot live in a ${home.kind} home`);
    }
    const role = await this.role(input.actor);
    if ((type === "task" || type === "branch") && role === "worker") {
      throw new MemoryError(403, "SCOPE_FORBIDDEN", `${type} records are kept by orchestrators`);
    }
    const workspaceId = type === "how_to_work" ? null : input.workspaceId;
    if (workspaceId !== null && !nonEmpty(workspaceId)) throw invalid("workspaceId is required");
    if (home.kind === "team" && home.ref !== workspaceId) throw new MemoryError(403, "SCOPE_FORBIDDEN", "team home must be the workspace");
    if (home.kind === "expert" && role === "worker" && home.ref !== input.actor.id) {
      throw new MemoryError(403, "SCOPE_FORBIDDEN", "an expert may write only its own how_to_work");
    }
    if (input.pinned === true && role === "worker") throw new MemoryError(403, "PIN_FORBIDDEN", "pins are kept by orchestrators");
    const text = checkText(type, input.title, input.body, input.attrs);
    if (type === "task" && home.ref !== text.attrs["taskRef"]) throw invalid("a task record's home must be its attrs.taskRef");
    const taskRef = nonEmpty(input.taskRef) ? input.taskRef : type === "task" ? String(text.attrs["taskRef"]) : null;
    if (taskRef !== null && !taskRef.startsWith("task:")) throw invalid("taskRef must be a task:… ref");
    const uniqueKey = uniqueKeyFor(type, text.attrs);

    if (uniqueKey !== null) return this.upsert(type, workspaceId!, home, text, uniqueKey, taskRef, input, role);

    let replaced: MemoryRecord | null = null;
    if (nonEmpty(input.supersedes)) {
      replaced = await this.require(input.supersedes);
      if (input.supersedesVersion !== undefined) this.checkBase(replaced, input.supersedesVersion);
      if (replaced.type !== type) throw invalid("a record can only be superseded by one of the same type");
      if (replaced.status !== "active") throw new MemoryError(409, "NOT_ACTIVE", `record is ${replaced.status}`);
      if (role === "worker" && !isAuthor(replaced, input.actor)) {
        throw new MemoryError(403, "NOT_OWNER", "an expert may supersede only its own records");
      }
    }
    const matches = replaced === null ? await this.nearMatches(type, workspaceId, home, text.title) : [];
    if (matches.length > 0 && input.confirmNew !== true) return { record: null, nearMatches: matches };

    const status = await this.statusFor(type, home.kind, role);
    const pinned = input.pinned === true;
    const tokens = recordTokens(text.title, text.body);
    if (status === "active" && alwaysLoads({ type, pinned })) await this.assertBudget(workspaceId, home, tokens, null);
    const at = this.iso();
    const record: MemoryRecord = {
      id: `mem_${randomUUID()}`,
      workspaceId,
      type,
      title: text.title,
      body: text.body,
      attrs: text.attrs,
      home,
      tags: tagsFor(type, workspaceId, home, text.attrs),
      priority: TYPE_PRIORITY[type],
      pinned,
      status,
      flag: null,
      supersedes: replaced?.id ?? null,
      supersededBy: null,
      // A superseding or confirmed-new record names what it may contradict.
      conflictsWith: replaced !== null ? [replaced.id] : matches.map((m) => m.id),
      taskRef,
      uniqueKey: null,
      authorKind: input.actor.kind,
      authorId: input.actor.id,
      createdAt: at,
      updatedAt: at,
      lastUsedAt: null,
      useCount: 0,
      version: 1,
      tokens,
    };
    await this.db.transaction(async () => {
      await this.insert(record, input.actor, "");
      await this.linkTask(record);
      if (status === "active" && replaced !== null) await this.applySupersede(record, input.actor);
    });
    return { record, nearMatches: matches, notice: noticeFor(record) };
  }

  private async upsert(
    type: MemoryType,
    workspaceId: string,
    home: MemoryHome,
    text: CheckedText,
    uniqueKey: string,
    taskRef: string | null,
    input: NoteInput,
    role: Role,
  ): Promise<NoteResult> {
    return this.db.transaction(async () => {
      const row = await this.db.get(
        "SELECT * FROM team_memory_records WHERE workspace_id = ? AND unique_key = ?",
        workspaceId,
        uniqueKey,
      );
      if (row === undefined) {
        const at = this.iso();
        const pinned = input.pinned === true;
        const tokens = recordTokens(text.title, text.body);
        if (pinned) await this.assertBudget(workspaceId, home, tokens, null);
        const record: MemoryRecord = {
          id: `mem_${randomUUID()}`,
          workspaceId,
          type,
          title: text.title,
          body: text.body,
          attrs: text.attrs,
          home,
          tags: tagsFor(type, workspaceId, home, text.attrs),
          priority: TYPE_PRIORITY[type],
          pinned,
          status: await this.statusFor(type, home.kind, role),
          flag: null,
          supersedes: null,
          supersededBy: null,
          conflictsWith: [],
          taskRef,
          uniqueKey,
          authorKind: input.actor.kind,
          authorId: input.actor.id,
          createdAt: at,
          updatedAt: at,
          lastUsedAt: null,
          useCount: 0,
          version: 1,
          tokens,
        };
        await this.insert(record, input.actor, "");
        await this.linkTask(record);
        return { record, nearMatches: [], upsert: "created" as const, notice: noticeFor(record) };
      }
      const existing = (await this.hydrate([row]))[0]!;
      if (existing.home.kind !== home.kind || existing.home.ref !== home.ref) {
        throw new MemoryError(409, "UNIQUE_CONFLICT", `this ${type} is already recorded in another home`, { id: existing.id });
      }
      const same =
        existing.status === "active" &&
        existing.title === text.title &&
        existing.body === text.body &&
        JSON.stringify(existing.attrs) === JSON.stringify(text.attrs);
      if (same) return { record: existing, nearMatches: [], upsert: "unchanged" as const };
      const next: MemoryRecord = {
        ...existing,
        title: text.title,
        body: text.body,
        attrs: text.attrs,
        tags: tagsFor(type, workspaceId, home, text.attrs),
        status: "active",
        version: existing.version + 1,
        updatedAt: this.iso(),
      };
      if (next.pinned) await this.assertBudget(workspaceId, home, recordTokens(next.title, next.body), next.id);
      await this.scrubRecordText(existing);
      await this.writeTags(next);
      const record = await this.commit(next, "edit", input.actor, "upsert");
      return { record, nearMatches: [], upsert: "updated" as const, notice: noticeFor(record) };
    });
  }

  /** The new record is active: retire the one it replaces. */
  private async applySupersede(record: MemoryRecord, actor: MemoryActor): Promise<void> {
    if (record.supersedes === null) return;
    const old = await this.get(record.supersedes);
    if (old === undefined || old.status !== "active") return;
    await this.commit(
      { ...old, status: "superseded", supersededBy: record.id, version: old.version + 1, updatedAt: this.iso() },
      "supersede",
      actor,
      `superseded by ${record.id}`,
    );
  }

  /**
   * One kind of change per call: text (title/body/attrs), pin, or priority. A
   * text edit by someone who would need approval for a new record puts an active
   * record back to pending (so an edit cannot slip past the gate).
   */
  async patch(
    id: string,
    input: {
      baseVersion: number;
      actor: MemoryActor;
      title?: unknown;
      body?: unknown;
      attrs?: unknown;
      pinned?: unknown;
      priority?: unknown;
      reason?: string;
    },
  ): Promise<MemoryRecord> {
    const textChange = input.title !== undefined || input.body !== undefined || input.attrs !== undefined;
    const kinds = [textChange, input.pinned !== undefined, input.priority !== undefined].filter(Boolean).length;
    if (kinds !== 1) throw new MemoryError(400, "INVALID_PATCH", "send exactly one of: text (title/body/attrs), pinned, priority");
    const role = await this.role(input.actor);
    return this.db.transaction(async () => {
      const record = await this.require(id);
      this.checkBase(record, input.baseVersion);
      if (record.status !== "active" && record.status !== "pending") throw new MemoryError(409, "NOT_ACTIVE", `record is ${record.status}`);
      const next: MemoryRecord = { ...record, version: record.version + 1, updatedAt: this.iso() };
      let action: string;
      if (textChange) {
        if (role === "worker" && (record.type === "task" || record.type === "branch")) {
          throw new MemoryError(403, "SCOPE_FORBIDDEN", `${record.type} records are kept by orchestrators`);
        }
        if (role === "worker" && !isAuthor(record, input.actor)) throw new MemoryError(403, "NOT_OWNER", "an expert may edit only its own records");
        const text = checkText(
          record.type,
          input.title ?? record.title,
          input.body ?? record.body,
          input.attrs === undefined ? record.attrs : input.attrs,
        );
        const key = uniqueKeyFor(record.type, text.attrs);
        if (key !== record.uniqueKey) throw invalid("a task's taskRef and a branch's repo and branch cannot change");
        next.title = text.title;
        next.body = text.body;
        next.attrs = text.attrs;
        next.tags = tagsFor(record.type, record.workspaceId, record.home, text.attrs);
        if (record.status === "active" && (await this.statusFor(record.type, record.home.kind, role)) === "pending") {
          next.status = "pending";
        }
        if (next.status === "active" && alwaysLoads(next)) {
          await this.assertBudget(record.workspaceId, record.home, recordTokens(next.title, next.body), record.id);
        }
        await this.scrubRecordText(record);
        await this.writeTags(next);
        action = "edit";
      } else if (input.pinned !== undefined) {
        if (typeof input.pinned !== "boolean") throw invalid("pinned must be a boolean");
        if (role === "worker") throw new MemoryError(403, "PIN_FORBIDDEN", "pins are kept by orchestrators");
        if (input.pinned === record.pinned) throw new MemoryError(409, "NO_CHANGE", `record is already ${record.pinned ? "pinned" : "unpinned"}`);
        if (input.pinned && record.status === "active" && record.type !== "rule") {
          await this.assertBudget(record.workspaceId, record.home, record.tokens, record.id);
        }
        next.pinned = input.pinned;
        action = input.pinned ? "pin" : "unpin";
      } else {
        if (role === "worker") throw new MemoryError(403, "ORCHESTRATOR_ONLY", "priority is set by orchestrators");
        if (!Number.isInteger(input.priority) || (input.priority as number) < 0 || (input.priority as number) > 1000) {
          throw invalid("priority must be an integer 0..1000");
        }
        next.priority = input.priority as number;
        action = "priority";
      }
      return this.commit(next, action, input.actor, input.reason ?? "");
    });
  }

  /**
   * Promote: widen a record's home in place (task -> channel, channel -> team).
   * Orchestrators and the human only. Narrower visibility tags are dropped and the
   * wider one added, in one version row with the tags snapshot. A widened record
   * follows its new home's budget and expiry. A rule widened into the team home
   * by anyone but the human goes back to pending for the human.
   */
  async widen(id: string, input: { to: { kind: unknown; ref: unknown }; baseVersion: number; actor: MemoryActor; reason?: string }): Promise<MemoryRecord> {
    const role = await this.requireOrchestrator(input.actor, "widen");
    return this.db.transaction(async () => {
      const record = await this.require(id);
      this.checkBase(record, input.baseVersion);
      if (record.status !== "active" && record.status !== "pending") throw new MemoryError(409, "NOT_ACTIVE", `record is ${record.status}`);
      const to = input.to?.kind;
      const ref = input.to?.ref;
      if (!isHome(to) || !TYPE_HOMES[record.type].includes(to) || HOME_RANK[to] <= HOME_RANK[record.home.kind]) {
        throw new MemoryError(400, "INVALID_PROMOTION", `${record.type} in a ${record.home.kind} home cannot widen to ${String(to)}`);
      }
      if (!nonEmpty(ref)) throw invalid("to.ref is required");
      if (to === "team" && ref !== record.workspaceId) throw invalid("a team home must be the record's workspace");
      if (to === "channel" && !ref.startsWith("channel:")) throw invalid("a channel home must be a channel:… ref");
      const home: MemoryHome = { kind: to, ref };
      const tags = record.tags.filter(
        (t) => !(t.kind === "task" || t.kind === "channel" || t.kind === "team") || (t.kind === "team" && TEAM_VISIBLE.has(record.type)),
      );
      if (!tags.some((t) => t.kind === home.kind && t.ref === home.ref)) tags.unshift({ kind: home.kind, ref: home.ref });
      let status = record.status;
      if (record.type === "rule" && to === "team" && role !== "human") status = "pending";
      if (status === "active" && alwaysLoads(record)) await this.assertBudget(record.workspaceId, home, record.tokens, null);
      const next: MemoryRecord = { ...record, home, tags, status, version: record.version + 1, updatedAt: this.iso() };
      await this.writeTags(next);
      return this.commit(next, "widen", input.actor, input.reason ?? "");
    });
  }

  /** True when the actor wrote any create or edit version of the record. */
  private async wroteText(id: string, actor: MemoryActor): Promise<boolean> {
    const row = await this.db.get(
      "SELECT 1 AS hit FROM team_memory_versions WHERE memory_id = ? AND action IN ('create', 'edit') AND actor_kind = ? AND actor_id = ? LIMIT 1",
      id,
      actor.kind,
      actor.id,
    );
    return row !== undefined;
  }

  /**
   * Release a pending record. The human or an orchestrator approves; nobody
   * approves their own record, and a team-scoped rule needs the human. A record
   * that would overflow its home's always-load set stays pending, is flagged
   * "blocked_budget", and the refusal names the largest consumers.
   */
  async approve(id: string, input: { baseVersion: number; actor: MemoryActor; reason?: string }): Promise<MemoryRecord> {
    const role = await this.role(input.actor);
    if (role === "worker") throw new MemoryError(403, "APPROVER_ONLY", "approve is reserved for orchestrators and the human");
    const record = await this.require(id);
    if (isAuthor(record, input.actor) || (await this.wroteText(id, input.actor))) {
      throw new MemoryError(403, "SELF_APPROVAL", "a writer of this record's text cannot approve it");
    }
    this.checkBase(record, input.baseVersion);
    if (record.status !== "pending") throw new MemoryError(409, "NOT_PENDING", `record is ${record.status}`);
    if (record.type === "rule" && record.home.kind === "team" && role !== "human") {
      throw new MemoryError(403, "HUMAN_ONLY", "a team-scoped rule is approved by the human");
    }
    if (alwaysLoads(record)) {
      try {
        await this.assertBudget(record.workspaceId, record.home, record.tokens, record.id);
      } catch (exc) {
        if (exc instanceof MemoryError && exc.code === "BUDGET_FULL") {
          // Not a version: the record's content and status are unchanged, only the page flag.
          await this.db.run("UPDATE team_memory_records SET flag = 'blocked_budget' WHERE id = ?", record.id);
        }
        throw exc;
      }
    }
    return this.db.transaction(async () => {
      const current = await this.require(id);
      this.checkBase(current, input.baseVersion);
      const approved = await this.commit(
        { ...current, status: "active", flag: null, version: current.version + 1, updatedAt: this.iso() },
        "approve",
        input.actor,
        input.reason ?? "",
      );
      await this.applySupersede(approved, input.actor);
      return approved;
    });
  }

  async retract(id: string, input: { baseVersion: number; actor: MemoryActor; reason?: string }): Promise<MemoryRecord> {
    const role = await this.role(input.actor);
    return this.db.transaction(async () => {
      const record = await this.require(id);
      this.checkBase(record, input.baseVersion);
      if (role === "worker" && !isAuthor(record, input.actor)) throw new MemoryError(403, "NOT_OWNER", "an expert may retract only its own records");
      if (record.status !== "active" && record.status !== "pending") throw new MemoryError(409, "NOT_ACTIVE", `record is ${record.status}`);
      return this.commit({ ...record, status: "retracted", flag: null, version: record.version + 1, updatedAt: this.iso() }, "retract", input.actor, input.reason ?? "");
    });
  }

  /** Bring an earlier version's text back as the current one. Human only; the text is filtered again. */
  async restore(id: string, input: { version: number; baseVersion: number; actor: MemoryActor; reason?: string }): Promise<MemoryRecord> {
    requireHuman(input.actor, "restore");
    return this.db.transaction(async () => {
      const record = await this.require(id);
      this.checkBase(record, input.baseVersion);
      if (record.status === "purged") throw new MemoryError(409, "PURGED", "a purged record cannot be restored");
      const row = await this.db.get("SELECT * FROM team_memory_versions WHERE memory_id = ? AND version = ?", id, input.version);
      if (row === undefined) throw new MemoryError(404, "NOT_FOUND", "no such version");
      const old = rowToVersion(row);
      if (old.title === null) throw new MemoryError(409, "PURGED", "that version holds no text");
      const text = checkText(record.type, old.title, old.body, old.attrs);
      if (uniqueKeyFor(record.type, text.attrs) !== record.uniqueKey) throw invalid("that version names a different task or branch");
      const next: MemoryRecord = {
        ...record,
        title: text.title,
        body: text.body,
        attrs: text.attrs,
        status: "active",
        flag: null,
        version: record.version + 1,
        updatedAt: this.iso(),
      };
      if (alwaysLoads(next)) await this.assertBudget(record.workspaceId, record.home, recordTokens(next.title, next.body), record.id);
      await this.scrubRecordText(record);
      return this.commit(next, "restore", input.actor, input.reason ?? `restored version ${input.version}`);
    });
  }

  /**
   * Remove a record's text for good. Human only. Title, body and attrs are
   * overwritten in place with same-length filler and then nulled, on the record
   * and on every version; descriptive tags and the unique key are dropped; the
   * write-ahead log is checkpointed so no frame still holds the text. A tombstone
   * version keeps who, when and why. Backup copies taken before the purge still
   * hold the text: purge cannot reach files outside this database.
   */
  async purge(id: string, input: { actor: MemoryActor; reason?: string }): Promise<MemoryRecord> {
    requireHuman(input.actor, "purge");
    const purged = await this.db.transaction(async () => {
      const record = await this.require(id);
      if (record.status === "purged") return record;
      const versions = await this.db.all(
        "SELECT version, title, body, attrs FROM team_memory_versions WHERE memory_id = ? AND (title IS NOT NULL OR body IS NOT NULL OR attrs IS NOT NULL)",
        id,
      );
      const fill = (value: unknown): string | null => (value === null || value === undefined ? null : scrubFiller(String(value)));
      for (const row of versions) {
        await this.db.run(
          "UPDATE team_memory_versions SET title = ?, body = ?, attrs = ? WHERE memory_id = ? AND version = ?",
          fill(row["title"]),
          fill(row["body"]),
          fill(row["attrs"]),
          id,
          row["version"],
        );
      }
      await this.db.run("UPDATE team_memory_versions SET title = NULL, body = NULL, attrs = NULL WHERE memory_id = ?", id);
      await this.scrubRecordText(record);
      const next: MemoryRecord = {
        ...record,
        title: null,
        body: null,
        attrs: null,
        tags: record.tags.filter((t) => t.kind !== "repo" && t.kind !== "branch"),
        pinned: false,
        status: "purged",
        flag: null,
        uniqueKey: null,
        version: record.version + 1,
        updatedAt: this.iso(),
      };
      await this.writeTags(next);
      return this.commit(next, "purge", input.actor, input.reason ?? "");
    });
    await this.db.checkpoint();
    return purged;
  }

  /** Expire unpinned conventions and how_to_work notes idle past MEMORY_EXPIRY_MS. Never deletes. */
  async sweep(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - MEMORY_EXPIRY_MS).toISOString();
    return this.db.transaction(async () => {
      const rows = await this.db.all(
        `SELECT * FROM team_memory_records WHERE status = 'active' AND pinned = 0
           AND type IN (${placeholders(EXPIRING.length)})
           AND max(updated_at, coalesce(last_used_at, updated_at)) < ?`,
        ...EXPIRING,
        cutoff,
      );
      const at = this.iso();
      for (const record of await this.hydrate(rows)) {
        await this.commit({ ...record, status: "expired", version: record.version + 1, updatedAt: at }, "expire", SYSTEM_SWEEP, "idle 30 days");
      }
      return rows.length;
    });
  }

  // -- injection ----------------------------------------------------------------

  /**
   * What one Turn starts with. Buckets narrowest first (task, channel, team,
   * expert). In each, rules and pinned records always load (the write-time cap
   * keeps them within 2000 tokens); everything else fills the layer budget by
   * priority, then recency. The current task's linked branch and decisions load
   * in the task bucket. A record whose text a narrower bucket already loaded is
   * skipped, and of two conflicting records only the winner (priority, then
   * narrower home, then newer) loads. The rest is indexed for lazy load.
   * Read-only: injecting writes nothing.
   */
  async inject(query: InjectQuery): Promise<MemoryInjection> {
    if (!nonEmpty(query.expertId) || !nonEmpty(query.workspaceId)) {
      throw new MemoryError(400, "INVALID_SCOPE", "expertId and workspaceId are required");
    }
    const requested = query.layerTokens ?? (await this.settings()).injectLayerTokens;
    const layerTokens = Math.min(MEMORY_INJECT_LAYER_CAP_TOKENS, Math.max(0, Math.floor(requested)));
    const homes: Record<HomeKind, string | null> = {
      task: nonEmpty(query.taskRef) ? query.taskRef : null,
      channel: nonEmpty(query.channelRef) ? query.channelRef : null,
      team: query.workspaceId,
      expert: query.expertId,
    };

    const buckets = new Map<HomeKind, MemoryRecord[]>();
    const all: MemoryRecord[] = [];
    const taken = new Set<string>();
    for (const kind of INJECT_ORDER) {
      const ref = homes[kind];
      if (ref === null) continue;
      const params: unknown[] = [kind, ref];
      let sql = "SELECT * FROM team_memory_records WHERE status = 'active' AND home_kind = ? AND home_ref = ?";
      if (kind !== "expert") {
        sql += " AND workspace_id = ?";
        params.push(query.workspaceId);
      }
      const rows = [...(await this.db.all(sql, ...params))];
      if (kind === "task") {
        // The task picture: whatever is linked to the current task record.
        rows.push(
          ...(await this.db.all(
            `SELECT r.* FROM team_memory_records t
             JOIN team_memory_links l ON l.from_id = t.id OR l.to_id = t.id
             JOIN team_memory_records r ON r.id = CASE WHEN l.from_id = t.id THEN l.to_id ELSE l.from_id END
             WHERE t.workspace_id = ? AND t.unique_key = ? AND r.status = 'active'`,
            query.workspaceId,
            ref,
          )),
        );
      }
      const records = (await this.hydrate(rows)).filter((r) => {
        if (taken.has(r.id)) return false;
        taken.add(r.id);
        return true;
      });
      buckets.set(kind, records);
      all.push(...records);
    }

    // Conflicts: a record loses to any conflicting record that outranks it.
    const byId = new Map(all.map((r) => [r.id, r]));
    const losers = new Set<string>();
    const outranks = (a: MemoryRecord, b: MemoryRecord): boolean =>
      a.priority !== b.priority
        ? a.priority > b.priority
        : HOME_RANK[a.home.kind] !== HOME_RANK[b.home.kind]
          ? HOME_RANK[a.home.kind] < HOME_RANK[b.home.kind]
          : a.updatedAt > b.updatedAt;
    for (const record of all) {
      for (const otherId of record.conflictsWith) {
        const other = byId.get(otherId);
        if (other === undefined) continue;
        losers.add(outranks(record, other) ? other.id : record.id);
      }
    }

    const result: MemoryInjection = { entries: [], omitted: 0, duplicates: 0, conflicts: 0, tokens: 0, layerTokens, index: [] };
    const seen = new Set<string>();
    const byRank = (a: MemoryRecord, b: MemoryRecord): number =>
      b.priority - a.priority || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id.localeCompare(b.id));
    for (const kind of INJECT_ORDER) {
      const records = buckets.get(kind);
      if (records === undefined) continue;
      const always = records.filter(alwaysLoads).sort(byRank);
      const rest = records.filter((r) => !alwaysLoads(r)).sort(byRank);
      const left: MemoryLayerIndex["items"] = [];
      let used = 0;
      for (const record of [...always, ...rest]) {
        if (losers.has(record.id)) {
          result.conflicts += 1;
          left.push(indexItem(record));
          continue;
        }
        const key = dedupeKey(record.title, record.body);
        if (seen.has(key)) {
          result.duplicates += 1;
          continue;
        }
        if (!alwaysLoads(record) && used + record.tokens > layerTokens) {
          result.omitted += 1;
          left.push(indexItem(record));
          continue;
        }
        seen.add(key);
        result.entries.push({
          id: record.id,
          type: record.type,
          title: record.title,
          body: record.body,
          attrs: record.attrs,
          home: record.home,
          priority: record.priority,
          pinned: record.pinned,
          tokens: record.tokens,
        });
        used += record.tokens;
      }
      result.tokens += used;
      if (left.length > 0) {
        result.index.push({ home: { kind, ref: homes[kind]! }, more: left.length, items: left.slice(0, MEMORY_INDEX_IDS_PER_LAYER) });
      }
    }
    return result;
  }
}

function indexItem(record: MemoryRecord): MemoryLayerIndex["items"][number] {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    tokens: record.tokens,
    pinned: record.pinned,
    ...(record.conflictsWith.length > 0 ? { conflictsWith: record.conflictsWith } : {}),
  };
}

function requireHuman(actor: MemoryActor, verb: string): void {
  if (actor.kind !== "human") throw new MemoryError(403, "HUMAN_ONLY", `${verb} is reserved for the human`);
}

function noticeFor(record: MemoryRecord): string | undefined {
  if (record.status === "pending") return "Saved as pending: it loads once an orchestrator or the human approves it.";
  if (record.type === "decision" && record.home.kind !== "team") return "Decisions are visible to the whole Team.";
  return undefined;
}
