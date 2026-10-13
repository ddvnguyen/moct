/**
 * Team memory (schema v8). Owns team_memory (current state) and
 * team_memory_versions (every change, with who and when). This is backend-owned
 * state, not a projection of team_operations: the expert layer follows a Member
 * across Workspaces, and a purge must remove text, which an append-only log
 * cannot. No ledger op kind is added.
 *
 * Layers and their scope shape (the table CHECK enforces the same shape):
 *   expert  — member_id                                 (global, follows the expert)
 *   team    — workspace_id
 *   channel — workspace_id + channel_ref
 *   task    — workspace_id + channel_ref + thread_ref   (a Thread sits in one Channel)
 *
 * The backend has no auth (loopback). It cannot tell a human from a model, so the
 * caller asserts `actor`; the plugin is the trust boundary and must never let a
 * model choose its own actor, workspace, channel or thread. What this store does
 * enforce: scope shape, owner checks against the asserted actor, the human-only
 * verbs, and that every read is filtered by the scope the caller names.
 */
import { randomUUID } from "node:crypto";
import type { TeamDb } from "../store/team-db.js";
import { detectSecret } from "./secret-filter.js";

export const MEMORY_LAYERS = ["expert", "team", "channel", "task"] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];
export type MemoryStatus = "pending" | "active" | "retracted" | "expired" | "purged";
export const MEMORY_STATUSES: readonly MemoryStatus[] = ["pending", "active", "retracted", "expired", "purged"];

/**
 * Human-set switches.
 *   expertApproval   "required" holds an expert's own expert notes as pending until
 *                    the human or a first-mate expert approves them.
 *   firstMateMembers experts that may approve expert notes and (in the plugin) load
 *                    every layer; worker experts load only their own scopes.
 *   injectLayerTokens auto-load target per layer, capped at MEMORY_INJECT_LAYER_CAP_TOKENS.
 */
export interface MemorySettings {
  expertApproval: "off" | "required";
  firstMateMembers: string[];
  injectLayerTokens: number;
}
/** Auto-load target per layer. */
export const MEMORY_INJECT_LAYER_TOKENS = 1000;
/** Hard ceiling per layer, whatever the setting says. */
export const MEMORY_INJECT_LAYER_CAP_TOKENS = 2000;
export const MEMORY_SETTING_DEFAULTS: MemorySettings = {
  expertApproval: "required",
  firstMateMembers: [],
  injectLayerTokens: MEMORY_INJECT_LAYER_TOKENS,
};
/** How many not-loaded entries each layer lists by id in the injection index. */
export const MEMORY_INDEX_IDS_PER_LAYER = 5;

/** Content cap per entry, in characters. All versions are kept, so this also bounds history growth. */
export const MEMORY_MAX_CHARS = 2000;
/** Unpinned entries expire this long after their last edit or citation. */
export const MEMORY_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** Narrowest first: the order injection fills the budget in. */
const INJECT_ORDER: readonly MemoryLayer[] = ["task", "channel", "team", "expert"];

export interface MemoryActor {
  readonly kind: "human" | "member";
  readonly id: string;
}

export interface MemoryScope {
  readonly layer: MemoryLayer;
  readonly memberId?: string | null;
  readonly workspaceId?: string | null;
  readonly channelRef?: string | null;
  readonly threadRef?: string | null;
}

export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  memberId: string | null;
  workspaceId: string | null;
  channelRef: string | null;
  threadRef: string | null;
  originWorkspaceId: string | null;
  promotedFrom: string | null;
  promotedTo: string | null;
  content: string | null;
  pinned: boolean;
  status: MemoryStatus;
  authorKind: "human" | "member";
  authorId: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
  version: number;
}

export interface MemoryVersion {
  memoryId: string;
  version: number;
  action: string;
  layer: MemoryLayer;
  workspaceId: string | null;
  channelRef: string | null;
  threadRef: string | null;
  content: string | null;
  pinned: boolean;
  status: MemoryStatus;
  actorKind: string;
  actorId: string;
  reason: string;
  at: string;
}

export interface MemoryListQuery {
  readonly memberId?: string;
  readonly workspaceId?: string;
  readonly channelRef?: string;
  readonly threadRef?: string;
  readonly layers?: readonly MemoryLayer[];
  readonly q?: string;
  /** One status, or "all". Defaults to active. */
  readonly status?: MemoryStatus | "all";
  readonly limit?: number;
  /** A search the expert acts on counts as a citation: unpinned hits get their expiry clock reset. */
  readonly cite?: boolean;
}

export interface MemoryInjectQuery {
  readonly memberId: string;
  readonly workspaceId: string;
  readonly channelRef?: string;
  readonly threadRef?: string;
  /** Per-layer budget for this call; defaults to the injectLayerTokens setting, capped either way. */
  readonly layerTokens?: number;
}

export interface InjectedEntry {
  id: string;
  layer: MemoryLayer;
  authorKind: "human" | "member";
  authorId: string;
  content: string;
  tokens: number;
}

/** What a layer holds beyond what was loaded, so the expert can fetch it on demand. */
export interface MemoryLayerIndex {
  layer: MemoryLayer;
  /** Active entries in scope that were not loaded (unpinned, or pinned but over budget). */
  more: number;
  /** Up to MEMORY_INDEX_IDS_PER_LAYER of them, most recent first. */
  items: { id: string; pinned: boolean; tokens: number; snippet: string }[];
}

export interface MemoryInjection {
  entries: InjectedEntry[];
  /** Pinned entries in scope that did not fit their layer's budget. */
  omitted: number;
  /** Pinned entries skipped because a narrower layer already loaded the same text. */
  duplicates: number;
  tokens: number;
  layerTokens: number;
  index: MemoryLayerIndex[];
}

/** A refusal with a stable code the client can branch on. */
export class MemoryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Same estimate the plugin's thread seed uses: UTF-8 bytes / 3. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

/** Same-byte-length filler a purge writes over text before nulling it, so the old bytes are overwritten in place. */
function scrubFiller(text: string): string {
  return "#".repeat(Buffer.byteLength(text, "utf8"));
}

function isLayer(value: unknown): value is MemoryLayer {
  return typeof value === "string" && (MEMORY_LAYERS as readonly string[]).includes(value);
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Two notes count as the same text when they match after case and whitespace folding. */
function dedupeKey(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

const SNIPPET_CHARS = 80;
function snippet(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_CHARS ? flat : `${flat.slice(0, SNIPPET_CHARS - 1)}…`;
}

/** Normalise a scope to its layer's exact shape, or refuse it. */
export function normaliseScope(scope: MemoryScope): Required<MemoryScope> {
  if (!isLayer(scope.layer)) throw new MemoryError(400, "INVALID_SCOPE", "layer must be expert, team, channel or task");
  const want = {
    expert: [true, false, false, false],
    team: [false, true, false, false],
    channel: [false, true, true, false],
    task: [false, true, true, true],
  }[scope.layer];
  const have = [scope.memberId, scope.workspaceId, scope.channelRef, scope.threadRef].map(nonEmpty);
  const names = ["memberId", "workspaceId", "channelRef", "threadRef"];
  for (let i = 0; i < 4; i++) {
    if (want[i] !== have[i]) {
      throw new MemoryError(
        400,
        "INVALID_SCOPE",
        `${scope.layer} memory ${want[i] ? "requires" : "must not carry"} ${names[i]}`,
      );
    }
  }
  return {
    layer: scope.layer,
    memberId: want[0] ? scope.memberId! : null,
    workspaceId: want[1] ? scope.workspaceId! : null,
    channelRef: want[2] ? scope.channelRef! : null,
    threadRef: want[3] ? scope.threadRef! : null,
  };
}

function checkContent(content: unknown): string {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new MemoryError(400, "INVALID_CONTENT", "content is required");
  }
  if ([...content].length > MEMORY_MAX_CHARS) {
    throw new MemoryError(400, "CONTENT_TOO_LONG", `content is limited to ${MEMORY_MAX_CHARS} characters`);
  }
  const rule = detectSecret(content);
  // The rule name only: echoing the match would put the secret into logs and transcripts.
  if (rule !== null) throw new MemoryError(422, "SECRET_DETECTED", `content looks like a credential (rule: ${rule})`);
  return content;
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: String(row["id"]),
    layer: row["layer"] as MemoryLayer,
    memberId: (row["member_id"] as string | null) ?? null,
    workspaceId: (row["workspace_id"] as string | null) ?? null,
    channelRef: (row["channel_ref"] as string | null) ?? null,
    threadRef: (row["thread_ref"] as string | null) ?? null,
    originWorkspaceId: (row["origin_workspace_id"] as string | null) ?? null,
    promotedFrom: (row["promoted_from"] as string | null) ?? null,
    promotedTo: (row["promoted_to"] as string | null) ?? null,
    content: (row["content"] as string | null) ?? null,
    pinned: Number(row["pinned"]) === 1,
    status: row["status"] as MemoryStatus,
    authorKind: row["author_kind"] as "human" | "member",
    authorId: String(row["author_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    lastUsedAt: (row["last_used_at"] as string | null) ?? null,
    useCount: Number(row["use_count"]),
    version: Number(row["version"]),
  };
}

function rowToVersion(row: Record<string, unknown>): MemoryVersion {
  return {
    memoryId: String(row["memory_id"]),
    version: Number(row["version"]),
    action: String(row["action"]),
    layer: row["layer"] as MemoryLayer,
    workspaceId: (row["workspace_id"] as string | null) ?? null,
    channelRef: (row["channel_ref"] as string | null) ?? null,
    threadRef: (row["thread_ref"] as string | null) ?? null,
    content: (row["content"] as string | null) ?? null,
    pinned: Number(row["pinned"]) === 1,
    status: row["status"] as MemoryStatus,
    actorKind: String(row["actor_kind"]),
    actorId: String(row["actor_id"]),
    reason: String(row["reason"]),
    at: String(row["at"]),
  };
}

function isAuthor(entry: MemoryEntry, actor: MemoryActor): boolean {
  return entry.authorKind === actor.kind && entry.authorId === actor.id;
}

function requireHuman(actor: MemoryActor, verb: string): void {
  if (actor.kind !== "human") throw new MemoryError(403, "HUMAN_ONLY", `${verb} is reserved for the human`);
}

/**
 * Pins cost every Turn a share of the prompt, so they are the human's call,
 * except that an expert may pin its own expert-layer notes ("how I work").
 */
function requirePinRight(actor: MemoryActor, layer: MemoryLayer, memberId: string | null): void {
  if (actor.kind === "human") return;
  if (layer === "expert" && memberId === actor.id) return;
  throw new MemoryError(403, "PIN_FORBIDDEN", "an expert may pin only its own expert-layer notes");
}

export interface CreateMemoryInput extends MemoryScope {
  readonly content: unknown;
  readonly pinned?: boolean;
  readonly originWorkspaceId?: string | null;
  readonly actor: MemoryActor;
}

export interface PatchMemoryInput {
  readonly baseVersion: number;
  readonly actor: MemoryActor;
  readonly content?: unknown;
  readonly pinned?: boolean;
  readonly reason?: string;
}

export class TeamMemoryStore {
  constructor(
    private readonly db: TeamDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private iso(): string {
    return this.now().toISOString();
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    const row = await this.db.get("SELECT * FROM team_memory WHERE id = ?", id);
    return row === undefined ? undefined : rowToEntry(row);
  }

  private async require(id: string): Promise<MemoryEntry> {
    const entry = await this.get(id);
    if (entry === undefined) throw new MemoryError(404, "NOT_FOUND", "no such memory entry");
    return entry;
  }

  private checkBase(entry: MemoryEntry, baseVersion: number): void {
    if (entry.version !== baseVersion) {
      throw new MemoryError(409, "VERSION_STALE", `entry is at version ${entry.version}, not ${baseVersion}`);
    }
  }

  private async recordVersion(entry: MemoryEntry, action: string, actor: MemoryActor, reason: string, at: string): Promise<void> {
    await this.db.run(
      `INSERT INTO team_memory_versions(memory_id, version, action, layer, workspace_id, channel_ref, thread_ref,
         content, pinned, status, actor_kind, actor_id, reason, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.version,
      action,
      entry.layer,
      entry.workspaceId,
      entry.channelRef,
      entry.threadRef,
      entry.content,
      entry.pinned ? 1 : 0,
      entry.status,
      actor.kind,
      actor.id,
      reason,
      at,
    );
  }

  /** Write the entry's mutable columns and its next version row in one transaction. */
  private async commit(next: MemoryEntry, action: string, actor: MemoryActor, reason: string): Promise<MemoryEntry> {
    await this.db.run(
      `UPDATE team_memory SET content = ?, pinned = ?, status = ?, promoted_to = ?, updated_at = ?, version = ?
       WHERE id = ?`,
      next.content,
      next.pinned ? 1 : 0,
      next.status,
      next.promotedTo,
      next.updatedAt,
      next.version,
      next.id,
    );
    await this.recordVersion(next, action, actor, reason, next.updatedAt);
    return next;
  }

  async settings(): Promise<MemorySettings> {
    const rows = await this.db.all("SELECT key, value FROM team_memory_settings");
    const settings = { ...MEMORY_SETTING_DEFAULTS };
    for (const row of rows) {
      const value = row["value"];
      if (row["key"] === "expert_approval" && (value === "off" || value === "required")) {
        settings.expertApproval = value;
      } else if (row["key"] === "first_mate_members" && typeof value === "string") {
        try {
          const ids: unknown = JSON.parse(value);
          if (Array.isArray(ids)) settings.firstMateMembers = ids.filter((id): id is string => nonEmpty(id));
        } catch {
          // A malformed row reads as the default; the next write replaces it.
        }
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
    firstMateMembers?: unknown;
    injectLayerTokens?: unknown;
    actor: MemoryActor;
  }): Promise<MemorySettings> {
    requireHuman(input.actor, "changing memory settings");
    const { expertApproval, firstMateMembers, injectLayerTokens } = input;
    if (expertApproval !== undefined && expertApproval !== "off" && expertApproval !== "required") {
      throw new MemoryError(400, "INVALID_SETTING", "expertApproval must be off or required");
    }
    if (firstMateMembers !== undefined && (!Array.isArray(firstMateMembers) || !firstMateMembers.every(nonEmpty))) {
      throw new MemoryError(400, "INVALID_SETTING", "firstMateMembers must be a list of member ids");
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
      if (firstMateMembers !== undefined) {
        await this.putSetting("first_mate_members", JSON.stringify([...new Set(firstMateMembers as string[])]), input.actor);
      }
      if (injectLayerTokens !== undefined) await this.putSetting("inject_layer_tokens", String(injectLayerTokens), input.actor);
    });
    return this.settings();
  }

  private async insert(entry: MemoryEntry, action: string, actor: MemoryActor, reason: string): Promise<void> {
    await this.db.run(
      `INSERT INTO team_memory(id, layer, member_id, workspace_id, channel_ref, thread_ref, origin_workspace_id,
         promoted_from, content, pinned, status, author_kind, author_id, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.layer,
      entry.memberId,
      entry.workspaceId,
      entry.channelRef,
      entry.threadRef,
      entry.originWorkspaceId,
      entry.promotedFrom,
      entry.content,
      entry.pinned ? 1 : 0,
      entry.status,
      entry.authorKind,
      entry.authorId,
      entry.createdAt,
      entry.updatedAt,
      entry.version,
    );
    await this.recordVersion(entry, action, actor, reason, entry.createdAt);
  }

  async create(input: CreateMemoryInput): Promise<MemoryEntry> {
    const scope = normaliseScope(input);
    const content = checkContent(input.content);
    const pinned = input.pinned === true;
    if (input.actor.kind === "member" && scope.layer === "expert" && scope.memberId !== input.actor.id) {
      throw new MemoryError(403, "NOT_OWNER", "an expert may write only its own expert memory");
    }
    if (pinned) requirePinRight(input.actor, scope.layer, scope.memberId);
    const held =
      input.actor.kind === "member" && scope.layer === "expert" && (await this.settings()).expertApproval === "required";
    const at = this.iso();
    const entry: MemoryEntry = {
      id: `mem_${randomUUID()}`,
      layer: scope.layer,
      memberId: scope.memberId,
      workspaceId: scope.workspaceId,
      channelRef: scope.channelRef,
      threadRef: scope.threadRef,
      originWorkspaceId: scope.layer === "expert" && nonEmpty(input.originWorkspaceId) ? input.originWorkspaceId : null,
      promotedFrom: null,
      promotedTo: null,
      content,
      pinned,
      status: held ? "pending" : "active",
      authorKind: input.actor.kind,
      authorId: input.actor.id,
      createdAt: at,
      updatedAt: at,
      lastUsedAt: null,
      useCount: 0,
      version: 1,
    };
    return this.db.transaction(async () => {
      await this.insert(entry, "create", input.actor, "");
      return entry;
    });
  }

  /**
   * Entries visible to the named scope. Every layer is filtered by the scope the
   * caller names, so a read can never cross into another Workspace: expert rows
   * need memberId, and team, channel and task rows need workspaceId.
   */
  async list(query: MemoryListQuery): Promise<MemoryEntry[]> {
    if (!nonEmpty(query.workspaceId) && !nonEmpty(query.memberId)) {
      throw new MemoryError(400, "INVALID_SCOPE", "workspaceId or memberId is required");
    }
    const layers = query.layers === undefined || query.layers.length === 0 ? MEMORY_LAYERS : query.layers;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (layers.includes("expert") && nonEmpty(query.memberId)) {
      clauses.push("(layer = 'expert' AND member_id = ?)");
      params.push(query.memberId);
    }
    if (nonEmpty(query.workspaceId)) {
      if (layers.includes("team")) {
        clauses.push("(layer = 'team' AND workspace_id = ?)");
        params.push(query.workspaceId);
      }
      for (const layer of ["channel", "task"] as const) {
        if (!layers.includes(layer)) continue;
        let clause = `(layer = '${layer}' AND workspace_id = ?`;
        params.push(query.workspaceId);
        if (nonEmpty(query.channelRef)) {
          clause += " AND channel_ref = ?";
          params.push(query.channelRef);
        }
        if (layer === "task" && nonEmpty(query.threadRef)) {
          clause += " AND thread_ref = ?";
          params.push(query.threadRef);
        }
        clauses.push(`${clause})`);
      }
    }
    if (clauses.length === 0) return [];
    let sql = `SELECT * FROM team_memory WHERE (${clauses.join(" OR ")})`;
    const status = query.status ?? "active";
    if (status !== "all") {
      sql += " AND status = ?";
      params.push(status);
    }
    // Keyword search: every word must appear, case-insensitive. No FTS on this
    // Turso version; the embedding column is reserved for vector search later.
    const words = (query.q ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 0).slice(0, 8);
    for (const word of words) {
      sql += " AND instr(lower(content), ?) > 0";
      params.push(word);
    }
    sql += " ORDER BY pinned DESC, updated_at DESC, id LIMIT ?";
    params.push(Math.min(Math.max(query.limit ?? 20, 1), 200));
    const entries = (await this.db.all(sql, ...params)).map(rowToEntry);
    if (query.cite === true) await this.cite(entries);
    return entries;
  }

  /** Reset the expiry clock of the unpinned entries an expert just used. Pinned ones never expire, so they are not written. */
  private async cite(entries: MemoryEntry[]): Promise<void> {
    const unpinned = entries.filter((e) => !e.pinned && e.status === "active");
    if (unpinned.length === 0) return;
    const at = this.iso();
    await this.db.transaction(async () => {
      for (const entry of unpinned) {
        await this.db.run("UPDATE team_memory SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?", at, entry.id);
        entry.lastUsedAt = at;
        entry.useCount += 1;
      }
    });
  }

  async versions(id: string): Promise<MemoryVersion[]> {
    await this.require(id);
    const rows = await this.db.all("SELECT * FROM team_memory_versions WHERE memory_id = ? ORDER BY version DESC", id);
    return rows.map(rowToVersion);
  }

  /** One kind of change per call (edit, or pin/unpin), so each version row has one action. */
  async patch(id: string, input: PatchMemoryInput): Promise<MemoryEntry> {
    const kinds = [input.content !== undefined, input.pinned !== undefined].filter(Boolean);
    if (kinds.length !== 1) throw new MemoryError(400, "INVALID_PATCH", "send exactly one of content or pinned");
    const content = input.content === undefined ? undefined : checkContent(input.content);
    return this.db.transaction(async () => {
      const entry = await this.require(id);
      this.checkBase(entry, input.baseVersion);
      if (entry.status !== "active") throw new MemoryError(409, "NOT_ACTIVE", `entry is ${entry.status}`);
      const next: MemoryEntry = { ...entry, version: entry.version + 1, updatedAt: this.iso() };
      let action: string;
      if (content !== undefined) {
        if (input.actor.kind !== "human" && !isAuthor(entry, input.actor)) {
          throw new MemoryError(403, "NOT_OWNER", "an expert may edit only its own notes");
        }
        // Overwrite the old text in place first, so the previous bytes do not
        // linger in the page; the version rows keep the history on purpose.
        if (entry.content !== null) {
          await this.db.run("UPDATE team_memory SET content = ? WHERE id = ?", scrubFiller(entry.content), entry.id);
        }
        next.content = content;
        action = "edit";
      } else {
        requirePinRight(input.actor, entry.layer, entry.memberId);
        if (input.pinned === entry.pinned) throw new MemoryError(409, "NO_CHANGE", `entry is already ${entry.pinned ? "pinned" : "unpinned"}`);
        next.pinned = input.pinned === true;
        action = input.pinned ? "pin" : "unpin";
      }
      return this.commit(next, action, input.actor, input.reason ?? "");
    });
  }

  /**
   * Widen a note: a task note to its Channel or the team, a Channel note to the
   * team. Writes a NEW entry in the target layer and retracts the source, so an
   * entry never changes scope and each layer's budget and expiry rules apply to
   * its own rows. The pair is linked by promoted_from / promoted_to. The new
   * entry keeps the source's author (so its owner can still edit it) and starts
   * unpinned: a pin in the wider layer is the human's call.
   */
  async promote(
    id: string,
    input: { to: unknown; baseVersion: number; actor: MemoryActor; reason?: string },
  ): Promise<{ source: MemoryEntry; promoted: MemoryEntry }> {
    const widen: Record<MemoryLayer, readonly MemoryLayer[]> = { task: ["channel", "team"], channel: ["team"], team: [], expert: [] };
    return this.db.transaction(async () => {
      const entry = await this.require(id);
      this.checkBase(entry, input.baseVersion);
      if (entry.status !== "active") throw new MemoryError(409, "NOT_ACTIVE", `entry is ${entry.status}`);
      const to = input.to;
      if (!isLayer(to) || !widen[entry.layer].includes(to)) {
        throw new MemoryError(400, "INVALID_PROMOTION", `${entry.layer} memory cannot be promoted to ${String(to)}`);
      }
      if (input.actor.kind !== "human" && !isAuthor(entry, input.actor)) {
        throw new MemoryError(403, "NOT_OWNER", "an expert may promote only its own notes");
      }
      const at = this.iso();
      const reason = input.reason ?? "";
      const promoted: MemoryEntry = {
        ...entry,
        id: `mem_${randomUUID()}`,
        layer: to,
        channelRef: to === "channel" ? entry.channelRef : null,
        threadRef: null,
        promotedFrom: entry.id,
        promotedTo: null,
        pinned: false,
        status: "active",
        createdAt: at,
        updatedAt: at,
        lastUsedAt: null,
        useCount: 0,
        version: 1,
      };
      await this.insert(promoted, "promote", input.actor, reason);
      const source = await this.commit(
        { ...entry, status: "retracted", promotedTo: promoted.id, version: entry.version + 1, updatedAt: at },
        "promote",
        input.actor,
        reason,
      );
      return { source, promoted };
    });
  }

  /**
   * Release a pending expert note (expertApproval = required). The human or a
   * first-mate expert approves; nobody approves their own note. The reviewer's
   * bar: expert memory says how that expert works, not facts about a project.
   */
  async approve(id: string, input: { baseVersion: number; actor: MemoryActor; reason?: string }): Promise<MemoryEntry> {
    if (input.actor.kind !== "human" && !(await this.settings()).firstMateMembers.includes(input.actor.id)) {
      throw new MemoryError(403, "APPROVER_ONLY", "approve is reserved for the human and first-mate experts");
    }
    return this.db.transaction(async () => {
      const entry = await this.require(id);
      if (isAuthor(entry, input.actor)) throw new MemoryError(403, "SELF_APPROVAL", "an author cannot approve its own note");
      this.checkBase(entry, input.baseVersion);
      if (entry.status !== "pending") throw new MemoryError(409, "NOT_PENDING", `entry is ${entry.status}`);
      return this.commit({ ...entry, status: "active", version: entry.version + 1, updatedAt: this.iso() }, "approve", input.actor, input.reason ?? "");
    });
  }

  async retract(id: string, input: { baseVersion: number; actor: MemoryActor; reason?: string }): Promise<MemoryEntry> {
    return this.db.transaction(async () => {
      const entry = await this.require(id);
      this.checkBase(entry, input.baseVersion);
      if (input.actor.kind !== "human" && !isAuthor(entry, input.actor)) {
        throw new MemoryError(403, "NOT_OWNER", "an expert may retract only its own notes");
      }
      if (entry.status !== "active" && entry.status !== "pending") {
        throw new MemoryError(409, "NOT_ACTIVE", `entry is ${entry.status}`);
      }
      const next: MemoryEntry = { ...entry, status: "retracted", version: entry.version + 1, updatedAt: this.iso() };
      return this.commit(next, "retract", input.actor, input.reason ?? "");
    });
  }

  /** Bring an earlier version's text back as the current one. Human only; the text is filtered again. */
  async restore(id: string, input: { version: number; baseVersion: number; actor: MemoryActor; reason?: string }): Promise<MemoryEntry> {
    requireHuman(input.actor, "restore");
    return this.db.transaction(async () => {
      const entry = await this.require(id);
      this.checkBase(entry, input.baseVersion);
      if (entry.status === "purged") throw new MemoryError(409, "PURGED", "a purged entry cannot be restored");
      const row = await this.db.get(
        "SELECT * FROM team_memory_versions WHERE memory_id = ? AND version = ?",
        id,
        input.version,
      );
      if (row === undefined) throw new MemoryError(404, "NOT_FOUND", "no such version");
      const old = rowToVersion(row);
      if (old.content === null) throw new MemoryError(409, "PURGED", "that version holds no text");
      const content = checkContent(old.content);
      const next: MemoryEntry = {
        ...entry,
        content,
        status: "active",
        version: entry.version + 1,
        updatedAt: this.iso(),
      };
      return this.commit(next, "restore", input.actor, input.reason ?? `restored version ${input.version}`);
    });
  }

  /**
   * Remove an entry's text for good. Human only. The text is overwritten in place
   * with same-length filler and then nulled, on the entry and on every version,
   * and the write-ahead log is checkpointed so no frame still holds it. A
   * tombstone version keeps who, when and why. Backup copies taken before the
   * purge still hold the text: purge cannot reach files outside this database.
   */
  async purge(id: string, input: { actor: MemoryActor; reason?: string }): Promise<MemoryEntry> {
    requireHuman(input.actor, "purge");
    const purged = await this.db.transaction(async () => {
      const entry = await this.require(id);
      if (entry.status === "purged") return entry;
      const versions = await this.db.all(
        "SELECT version, content FROM team_memory_versions WHERE memory_id = ? AND content IS NOT NULL",
        id,
      );
      for (const row of versions) {
        await this.db.run(
          "UPDATE team_memory_versions SET content = ? WHERE memory_id = ? AND version = ?",
          scrubFiller(String(row["content"])),
          id,
          row["version"],
        );
      }
      await this.db.run("UPDATE team_memory_versions SET content = NULL WHERE memory_id = ?", id);
      if (entry.content !== null) {
        await this.db.run("UPDATE team_memory SET content = ? WHERE id = ?", scrubFiller(entry.content), id);
      }
      const next: MemoryEntry = {
        ...entry,
        content: null,
        pinned: false,
        status: "purged",
        version: entry.version + 1,
        updatedAt: this.iso(),
      };
      return this.commit(next, "purge", input.actor, input.reason ?? "");
    });
    await this.db.checkpoint();
    return purged;
  }

  /**
   * What one Turn starts with. Narrowest layer first (task, channel, team,
   * expert). Each layer loads its pinned notes up to its own budget (the
   * injectLayerTokens setting, never above the cap), so one busy layer cannot
   * crowd out another. A pinned note whose text a narrower layer already loaded
   * is skipped. Everything else active in scope is listed in a short per-layer
   * index, so the expert can fetch it with search/get instead of carrying it.
   * Read-only: injecting writes nothing.
   */
  async inject(query: MemoryInjectQuery): Promise<MemoryInjection> {
    if (!nonEmpty(query.memberId) || !nonEmpty(query.workspaceId)) {
      throw new MemoryError(400, "INVALID_SCOPE", "memberId and workspaceId are required");
    }
    if (nonEmpty(query.threadRef) && !nonEmpty(query.channelRef)) {
      throw new MemoryError(400, "INVALID_SCOPE", "threadRef requires channelRef");
    }
    const requested = query.layerTokens ?? (await this.settings()).injectLayerTokens;
    const layerTokens = Math.min(MEMORY_INJECT_LAYER_CAP_TOKENS, Math.max(0, Math.floor(requested)));
    const result: MemoryInjection = { entries: [], omitted: 0, duplicates: 0, tokens: 0, layerTokens, index: [] };
    const seen = new Set<string>();
    for (const layer of INJECT_ORDER) {
      let sql = "SELECT * FROM team_memory WHERE status = 'active' AND layer = ?";
      const params: unknown[] = [layer];
      if (layer === "expert") {
        sql += " AND member_id = ?";
        params.push(query.memberId);
      } else {
        if ((layer === "channel" || layer === "task") && !nonEmpty(query.channelRef)) continue;
        if (layer === "task" && !nonEmpty(query.threadRef)) continue;
        sql += " AND workspace_id = ?";
        params.push(query.workspaceId);
        if (layer === "channel" || layer === "task") {
          sql += " AND channel_ref = ?";
          params.push(query.channelRef);
        }
        if (layer === "task") {
          sql += " AND thread_ref = ?";
          params.push(query.threadRef);
        }
      }
      sql += " ORDER BY pinned DESC, updated_at DESC, id";
      let used = 0;
      const rest: MemoryEntry[] = [];
      for (const entry of (await this.db.all(sql, ...params)).map(rowToEntry)) {
        const content = entry.content ?? "";
        if (!entry.pinned) {
          rest.push(entry);
          continue;
        }
        const key = dedupeKey(content);
        if (seen.has(key)) {
          result.duplicates += 1;
          continue;
        }
        const tokens = estimateTokens(content);
        if (used + tokens > layerTokens) {
          result.omitted += 1;
          rest.push(entry);
          continue;
        }
        seen.add(key);
        used += tokens;
        result.entries.push({ id: entry.id, layer, authorKind: entry.authorKind, authorId: entry.authorId, content, tokens });
      }
      result.tokens += used;
      if (rest.length > 0) {
        rest.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id.localeCompare(b.id)));
        result.index.push({
          layer,
          more: rest.length,
          items: rest.slice(0, MEMORY_INDEX_IDS_PER_LAYER).map((entry) => ({
            id: entry.id,
            pinned: entry.pinned,
            tokens: estimateTokens(entry.content ?? ""),
            snippet: snippet(entry.content ?? ""),
          })),
        });
      }
    }
    return result;
  }

  /** A task ended: its unpromoted notes expire. Promoted notes already left the task layer. */
  async taskClosed(input: { workspaceId: string; channelRef: string; threadRef: string; actor: MemoryActor }): Promise<number> {
    return this.expireWhere(
      "layer = 'task' AND workspace_id = ? AND channel_ref = ? AND thread_ref = ?",
      [input.workspaceId, input.channelRef, input.threadRef],
      input.actor,
      "task closed",
    );
  }

  /** Expire unpinned entries idle for 30 days (no edit and no citation). Never deletes. */
  async sweep(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - MEMORY_EXPIRY_MS).toISOString();
    return this.expireWhere(
      "pinned = 0 AND max(updated_at, coalesce(last_used_at, updated_at)) < ?",
      [cutoff],
      { kind: "human", id: "system:expiry-sweep" },
      "idle 30 days",
    );
  }

  private async expireWhere(where: string, params: unknown[], actor: MemoryActor, reason: string): Promise<number> {
    return this.db.transaction(async () => {
      const rows = await this.db.all(`SELECT * FROM team_memory WHERE status = 'active' AND ${where}`, ...params);
      const at = this.iso();
      for (const entry of rows.map(rowToEntry)) {
        await this.commit({ ...entry, status: "expired", version: entry.version + 1, updatedAt: at }, "expire", actor, reason);
      }
      return rows.length;
    });
  }
}
