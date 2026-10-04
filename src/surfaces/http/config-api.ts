/**
 * Owner config REST contract — a port of state/config_api.py, backing the
 * /config* routes the way backend.py:242-277 calls it.
 *
 * Storage is two PLAIN JSON FILES under the state root; no Python import, no
 * database, no migration:
 *
 *   <state_root>/fleet.json     positions, in either the nested v2 shape
 *                               ({"version":2,"positions":{...}}) or the flat
 *                               v1 shape ({role: {...}})
 *   <state_root>/timings.json   the four timing keys
 *
 * Semantics reproduced from config_api.py: reads never create a file (an absent
 * fleet.json serves FLEET_DEFAULT with version 2); every write copies the
 * previous bytes to <name>.bak first, then writes via the store's atomic
 * tmp+rename with indent=2 and a trailing newline; and every successful write
 * appends one owner-config decision row to a ledger project. Validation runs
 * BEFORE any side effect, so a rejected write leaves no .bak and no ledger row.
 *
 * Concurrency: like Python, there is no lock on these files. Two writers race
 * last-writer-wins. That is inherited, not introduced.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TIMINGS,
  FLEET_DEFAULT,
  findRepoRoot,
  loadTimings,
  validateCron,
} from "../../domain/config.js";
import { newId, pyRepr, slugify, utcnowIso } from "../../domain/models.js";
import { REPORT_DUTY, SPAWN_SCAFFOLD } from "../../domain/tools/catalog.js";
import type { Decision, Store } from "../../store/store-interface.js";

const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** config_api.POSITION_KEYS. Keys outside this set are rejected as UNKNOWN_FIELD. */
const POSITION_KEYS = new Set([
  "models",
  "init_prompt",
  "instruction_mode",
  "spawn",
  "note",
  "cwd",
  "max_runs",
  "renew_cron",
  "schedule_name",
  "fallback",
  "checkup_cron",
  "wakes_per_life",
]);

/** config_api.MODEL_KEYS. */
const MODEL_KEYS = new Set([
  "model",
  "harness",
  "provider_arg",
  "tier",
  "quality_index",
  "priority",
  "priority_degraded",
  "degrade_when_usage",
  "max_concurrent",
  "family",
  "notes",
  "mode",
  "thinking",
  "fallback",
  "enabled",
]);

const INIT_PROMPT_MAX = 8000;
const LEDGER_PROJECT_NAME = "Owner Config Ledger";
const LEDGER_PROJECT_SLUG = slugify(LEDGER_PROJECT_NAME);

/** config.KNOWN_HARNESSES — order matters, it is interpolated into a message. */
const KNOWN_HARNESSES = ["omp", "opencode", "pi", "dsh", "claude"] as const;

export const TIMINGS_KEYS = [
  "checkup_cron",
  "deep_tick_cron",
  "timezone",
  "usage_max_age_s",
] as const;

/** config_api._error — note this is {error:{code,message}}, not the flat auth shape. */
function apiError(code: string, message: string): Record<string, unknown> {
  return { error: { code, message } };
}

export function fleetFile(stateDir: string): string {
  return path.join(stateDir, "fleet.json");
}

export function timingsFile(stateDir: string): string {
  return path.join(stateDir, "timings.json");
}

/**
 * config_api._read_fleet — (parsed document, problem). An absent file is
 * (null, null): absent is NOT an error, and reading never creates it.
 *
 * The bad-JSON message embeds CPython's JSONDecodeError text, which JSON.parse
 * cannot reproduce (V8 words it differently). The prefix, the code and the 400
 * all match; only the reason string's tail is engine-specific, and it is
 * labelled as such rather than silently reshaped.
 */
export function readFleet(stateDir: string): {
  data: Record<string, unknown> | null;
  problem: string | null;
} {
  const file = fleetFile(stateDir);
  if (!existsSync(file)) return { data: null, problem: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (exc) {
    return { data: null, problem: `fleet.json is not valid JSON: ${(exc as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { data: null, problem: "fleet.json must contain a JSON object" };
  }
  return { data: parsed as Record<string, unknown>, problem: null };
}

/**
 * config_api._positions_of.
 *
 * Reproduces a deliberate divergence from config.fleetMap: fleetMap skips
 * _REGISTRY_CONFIG_KEYS (spawn/worktree_roots/tiers/version), this does not. So
 * in a FLAT fleet.json a sibling `spawn`/`tiers` object is served as a position
 * of that name, and PUT /config/positions/tiers would clobber the tier map.
 * The live file is nested, where siblings are correctly ignored. Kept verbatim
 * because it is the contract the settings page is written against — do not
 * "fix" it here without changing the Python side in the same change.
 */
export function positionsOf(
  data: Record<string, unknown> | null,
): Record<string, Record<string, unknown>> {
  if (data === null) return {};
  const nested = data["positions"];
  const raw: Record<string, unknown> =
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : Object.fromEntries(Object.entries(data).filter(([key]) => key !== "version"));
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = value as Record<string, unknown>;
    }
  }
  return out;
}

/** config_api._effective_roles — the built-in defaults UNION whatever fleet.json adds. */
export function effectiveRoles(stored: Record<string, unknown>): Set<string> {
  return new Set([...Object.keys(FLEET_DEFAULT), ...Object.keys(stored)]);
}

// ---------------------------------------------------------------------------
// Validation (config_api._validate_model / _model_list / _position)
// ---------------------------------------------------------------------------

type Validated<T> = { value: T; error: null } | { value: null; error: Record<string, unknown> };

function isInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

/* eslint-disable complexity -- faithful port of config_api._validate_model: the
 * check order is the contract, not an implementation detail. It decides which
 * message a record that breaks two rules at once reports, and the int-field
 * iteration order (quality_index, priority, priority_degraded,
 * degrade_when_usage, max_concurrent) mirrors the Python dict literal for the
 * same reason. Flattening this into helpers would change observable output. */
function validateModel(rec: unknown, where: string): Validated<unknown> {
  if (typeof rec === "string") {
    if (!MODEL_RE.test(rec)) {
      return {
        value: null,
        error: apiError("INVALID_MODEL_ID", `${where}: invalid model id ${pyRepr(rec)}`),
      };
    }
    return { value: rec, error: null };
  }
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
    return {
      value: null,
      error: apiError(
        "INVALID_FIELD",
        `${where}: model entry must be a model id string or an object`,
      ),
    };
  }
  const record = rec as Record<string, unknown>;
  const unknown = Object.keys(record)
    .filter((key) => !MODEL_KEYS.has(key))
    .sort();
  if (unknown.length > 0) {
    return {
      value: null,
      error: apiError("UNKNOWN_FIELD", `${where}: unknown model field(s): ${unknown.join(", ")}`),
    };
  }
  const model = record["model"];
  if (typeof model !== "string" || !MODEL_RE.test(model)) {
    return {
      value: null,
      error: apiError(
        "INVALID_MODEL_ID",
        `${where}: invalid model id ${pyRepr(model)} (must match ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$)`,
      ),
    };
  }
  if (
    "harness" in record &&
    !KNOWN_HARNESSES.includes(record["harness"] as (typeof KNOWN_HARNESSES)[number])
  ) {
    return {
      value: null,
      error: apiError(
        "INVALID_HARNESS",
        `${where}: unknown harness ${pyRepr(record["harness"])} (known: ${KNOWN_HARNESSES.join(", ")})`,
      ),
    };
  }
  // Iteration order is the Python dict-literal order: it decides which message
  // wins when a record breaks two of these at once.
  const intChecks: Array<[string, number, number]> = [
    ["quality_index", 0, 100],
    ["priority", -100, 100],
    ["priority_degraded", -100, 100],
    ["degrade_when_usage", 0, 1 << 31],
    ["max_concurrent", 0, 1 << 31],
  ];
  for (const [field, lo, hi] of intChecks) {
    if (!(field in record)) continue;
    const value = record[field];
    if (typeof value === "boolean" || !isInt(value)) {
      return { value: null, error: apiError("INVALID_FIELD", `${where}: ${field} must be an int`) };
    }
    const numeric = value as number;
    if (numeric < lo || numeric > hi) {
      return {
        value: null,
        error: apiError("INVALID_FIELD", `${where}: ${field}=${numeric} out of range ${lo}..${hi}`),
      };
    }
  }
  if ("tier" in record) {
    const tier = record["tier"];
    if (typeof tier !== "string" || tier.length < 1 || tier.length > 32) {
      return {
        value: null,
        error: apiError(
          "INVALID_FIELD",
          `${where}: tier must be a non-empty string of at most 32 chars`,
        ),
      };
    }
  }
  // An explicit null means "cleared" and round-trips — the live fleet.json has
  // `mode: null`, so rejecting it would make the live file unwritable.
  for (const field of ["provider_arg", "family", "notes", "mode", "thinking"]) {
    const value = record[field];
    if (field in record && value !== null && value !== undefined && typeof value !== "string") {
      return {
        value: null,
        error: apiError("INVALID_FIELD", `${where}: ${field} must be a string`),
      };
    }
  }
  for (const field of ["fallback", "enabled"]) {
    const value = record[field];
    if (field in record && value !== null && value !== undefined && typeof value !== "boolean") {
      return {
        value: null,
        error: apiError("INVALID_FIELD", `${where}: ${field} must be a boolean`),
      };
    }
  }
  return { value: rec, error: null };
}

function validateModelList(entries: unknown, where: string): Validated<unknown[]> {
  if (!Array.isArray(entries)) {
    return { value: null, error: apiError("INVALID_FIELD", `${where} must be a list`) };
  }
  const out: unknown[] = [];
  for (const [index, rec] of entries.entries()) {
    const stored = validateModel(rec, `${where}[${index}]`);
    if (stored.error !== null) return { value: null, error: stored.error };
    out.push(stored.value);
  }
  return { value: out, error: null };
}

/**
 * config_api._validate_position. Check order is load-bearing: it decides which
 * error a doubly-invalid body reports.
 */
/* eslint-disable-next-line complexity -- same reason as validateModel: the order
 * of these checks is what decides which error a doubly-invalid position reports. */
export function validatePosition(body: unknown): Validated<Record<string, unknown>> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { value: null, error: apiError("INVALID_FIELD", "position must be a JSON object") };
  }
  const record = { ...(body as Record<string, unknown>) };
  const unknown = Object.keys(record)
    .filter((key) => !POSITION_KEYS.has(key))
    .sort();
  if (unknown.length > 0) {
    return {
      value: null,
      error: apiError("UNKNOWN_FIELD", `unknown position field(s): ${unknown.join(", ")}`),
    };
  }
  if (!("models" in record)) {
    return { value: null, error: apiError("INVALID_FIELD", "position.models is required") };
  }
  const models = validateModelList(record["models"], "models");
  if (models.error !== null) return { value: null, error: models.error };
  record["models"] = models.value;

  if ("fallback" in record) {
    const fallback = validateModelList(record["fallback"], "fallback");
    if (fallback.error !== null) return { value: null, error: fallback.error };
    record["fallback"] = fallback.value;
  }
  if ("init_prompt" in record) {
    const prompt = record["init_prompt"];
    if (typeof prompt !== "string") {
      return { value: null, error: apiError("INVALID_FIELD", "init_prompt must be a string") };
    }
    // Length in code points, matching len() on a Python str.
    if ([...prompt].length > INIT_PROMPT_MAX) {
      return {
        value: null,
        error: apiError(
          "INVALID_FIELD",
          `init_prompt is ${[...prompt].length} chars, max ${INIT_PROMPT_MAX}`,
        ),
      };
    }
  }
  record["init_prompt"] ??= "";
  const mode = "instruction_mode" in record ? record["instruction_mode"] : "extend";
  if (mode !== "extend" && mode !== "replace") {
    return {
      value: null,
      error: apiError(
        "INVALID_FIELD",
        `instruction_mode must be 'extend' or 'replace', got ${pyRepr(mode)}`,
      ),
    };
  }
  record["instruction_mode"] = mode;

  if ("checkup_cron" in record) {
    const problem = validateCron(record["checkup_cron"]);
    if (problem !== null) {
      return { value: null, error: apiError("INVALID_CRON", `checkup_cron: ${problem}`) };
    }
  }
  if ("wakes_per_life" in record) {
    const wakes = record["wakes_per_life"];
    if (
      typeof wakes === "boolean" ||
      !isInt(wakes) ||
      (wakes as number) < 1 ||
      (wakes as number) > 10000
    ) {
      return {
        value: null,
        error: apiError(
          "INVALID_FIELD",
          `wakes_per_life must be an int in 1..10000, got ${pyRepr(wakes)}`,
        ),
      };
    }
  }
  return { value: record, error: null };
}

/** config_api._validate_timings — a full replace, so every key is mandatory. */
export function validateTimings(body: unknown): Validated<Record<string, unknown>> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { value: null, error: apiError("INVALID_FIELD", "timings must be a JSON object") };
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record)
    .filter((key) => !(TIMINGS_KEYS as readonly string[]).includes(key))
    .sort();
  if (unknown.length > 0) {
    return {
      value: null,
      error: apiError("UNKNOWN_FIELD", `unknown timing field(s): ${unknown.join(", ")}`),
    };
  }
  const missing = TIMINGS_KEYS.filter((key) => !(key in record));
  if (missing.length > 0) {
    return {
      value: null,
      error: apiError("INVALID_FIELD", `missing timing field(s): ${missing.join(", ")}`),
    };
  }
  for (const key of ["checkup_cron", "deep_tick_cron"]) {
    const problem = validateCron(record[key]);
    if (problem !== null)
      return { value: null, error: apiError("INVALID_CRON", `${key}: ${problem}`) };
  }
  const tz = record["timezone"];
  if (typeof tz !== "string" || tz.length === 0) {
    return {
      value: null,
      error: apiError("INVALID_TIMING", "timezone must be a non-empty string"),
    };
  }
  try {
    // eslint-disable-next-line no-new -- the constructor throws on a bad zone; that is the validation
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    return { value: null, error: apiError("INVALID_TIMING", `unknown timezone ${pyRepr(tz)}`) };
  }
  const age = record["usage_max_age_s"];
  // One message covers both the type error and the range error, as in Python.
  if (typeof age === "boolean" || !isInt(age) || (age as number) < 60 || (age as number) > 86400) {
    return {
      value: null,
      error: apiError(
        "INVALID_TIMING",
        `usage_max_age_s must be an int between 60 and 86400, got ${pyRepr(age)}`,
      ),
    };
  }
  const out: Record<string, unknown> = {};
  for (const key of TIMINGS_KEYS) out[key] = record[key];
  return { value: out, error: null };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const LEADER_DOCS: Array<[string, string]> = [
  [
    "Leader contract",
    "orchestration/hermes-lead-template/skills/autonomous-ai-agents/paseo-lead-orchestration/SKILL.md",
  ],
  ["Lead charter (human-maintained)", "orchestration/LEAD_CHARTER.md"],
];

/**
 * config_api._leader_docs. Always two entries; `text` is the whole file or "".
 * The root is walked up from this module's directory, not from cwd — a cwd
 * probe makes text silently empty in a daemon started from elsewhere.
 */
export function leaderDocs(): Array<{ name: string; path: string; text: string }> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = findRepoRoot(here);
  return LEADER_DOCS.map(([name, rel]) => {
    let text = "";
    try {
      const candidate = path.join(root, rel);
      if (existsSync(candidate)) text = readFileSync(candidate, "utf-8");
    } catch {
      text = "";
    }
    return { name, path: rel, text };
  });
}

/** config_api.get_config — the GET /config body. */
export function getConfig(stateDir: string): Record<string, unknown> {
  const { data, problem } = readFleet(stateDir);
  if (problem !== null) return apiError("INVALID_FIELD", problem);
  const stored = positionsOf(data);
  const roles = [
    ...Object.keys(FLEET_DEFAULT),
    ...Object.keys(stored).filter((role) => !(role in FLEET_DEFAULT)),
  ];
  const positions: Record<string, Record<string, unknown>> = {};
  for (const role of roles) {
    const raw = stored[role];
    // A role with no stored entry serves a copy of its built-in default.
    const pos: Record<string, unknown> =
      raw === undefined ? { ...FLEET_DEFAULT[role] } : { ...raw };
    if (typeof pos["init_prompt"] !== "string") pos["init_prompt"] = "";
    if (pos["instruction_mode"] !== "extend" && pos["instruction_mode"] !== "replace") {
      pos["instruction_mode"] = "extend";
    }
    positions[role] = pos;
  }
  return {
    // Unvalidated on purpose: Python serves whatever the file holds, and a
    // non-numeric version reaches the client verbatim.
    version: data === null ? 2 : (data["version"] ?? 1),
    positions,
    timings: loadTimings(stateDir),
    scaffold: { spawn_template: SPAWN_SCAFFOLD, report_duty: REPORT_DUTY },
    leader_docs: leaderDocs(),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * config_api._audit. Best-effort by contract: a config write that landed must
 * not be reported as failed because the ledger append threw, so the failure is
 * swallowed (and reported through onError when the caller supplies one).
 */
async function audit(
  store: Store,
  subject: string,
  summary: string,
  route: string,
  onError?: (exc: unknown) => void,
): Promise<void> {
  try {
    let project = null;
    for (const existing of await store.listProjects()) {
      if (existing.slug === LEDGER_PROJECT_SLUG) {
        project = existing;
        break;
      }
    }
    if (project === null) project = await store.createProject(LEDGER_PROJECT_NAME);
    const decision: Decision = {
      id: newId("d"),
      ts: utcnowIso(),
      track_id: null,
      project_id: project.id,
      decision: `${subject}: ${summary}`,
      rationale: route,
      source: "owner-config",
      irreversible: false,
      author: "",
    };
    await store.appendDecision(decision, project.id);
  } catch (exc) {
    onError?.(exc);
  }
}

/** Copy the current bytes aside before the write, as config_api._write_fleet does. */
function backupIfPresent(file: string): void {
  if (!existsSync(file)) return;
  copyFileSync(file, `${file}.bak`);
}

/**
 * config_api._write_fleet. Preserves the file's own shape: a nested v2 document
 * stays nested, a flat one stays flat, and an absent file starts as nested v2.
 */
async function writeFleet(
  store: Store,
  stateDir: string,
  data: Record<string, unknown> | null,
  role: string,
  normalized: Record<string, unknown>,
  verb: "created" | "replaced",
): Promise<Record<string, unknown>> {
  const file = fleetFile(stateDir);
  backupIfPresent(file);
  let next: Record<string, unknown>;
  if (data === null) {
    next = { version: 2, positions: { [role]: normalized } };
  } else if (
    data["positions"] !== null &&
    typeof data["positions"] === "object" &&
    !Array.isArray(data["positions"])
  ) {
    next = { ...data, positions: { ...(data["positions"] as object), [role]: normalized } };
  } else {
    next = { ...data, [role]: normalized };
  }
  await store.writeJsonAtomic(file, next);
  const models = Array.isArray(normalized["models"]) ? normalized["models"].length : 0;
  await audit(
    store,
    "fleet.json",
    `position '${role}' ${verb} (models=${models}, instruction_mode=${normalized["instruction_mode"]})`,
    `owner config API ${verb} /config/positions/${role}`,
  );
  return { position: normalized };
}

/** config_api.put_position — full replace of one EXISTING position (404 otherwise). */
export async function putPosition(
  store: Store,
  stateDir: string,
  role: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const { data, problem } = readFleet(stateDir);
  if (problem !== null) return apiError("INVALID_FIELD", problem);
  const stored = positionsOf(data);
  const roles = effectiveRoles(stored);
  if (!roles.has(role)) {
    return apiError(
      "POSITION_NOT_FOUND",
      `unknown position: ${role} (known: ${[...roles].sort().join(", ")})`,
    );
  }
  const normalized = validatePosition(body);
  if (normalized.error !== null) return normalized.error;
  return writeFleet(store, stateDir, data, role, normalized.value, "replaced");
}

/** config_api.post_position — create a NEW position ({role, position}); 409 on clash. */
export async function postPosition(
  store: Store,
  stateDir: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return apiError("INVALID_FIELD", "body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const role = record["role"];
  if (typeof role !== "string" || role.length === 0) {
    return apiError("INVALID_FIELD", "role is required (a non-empty string)");
  }
  if (!ROLE_RE.test(role)) {
    return apiError(
      "INVALID_ROLE",
      `invalid role name ${pyRepr(role)} (must match ^[a-z][a-z0-9_-]{0,31}$)`,
    );
  }
  const { data, problem } = readFleet(stateDir);
  if (problem !== null) return apiError("INVALID_FIELD", problem);
  if (effectiveRoles(positionsOf(data)).has(role)) {
    return apiError("POSITION_EXISTS", `position '${role}' already exists`);
  }
  const normalized = validatePosition(record["position"]);
  if (normalized.error !== null) return normalized.error;
  return writeFleet(store, stateDir, data, role, normalized.value, "created");
}

/** config_api.put_timings — validated full replace of the four timing keys. */
export async function putTimings(
  store: Store,
  stateDir: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const normalized = validateTimings(body);
  if (normalized.error !== null) return normalized.error;
  const previous = loadTimings(stateDir);
  const file = timingsFile(stateDir);
  backupIfPresent(file);
  await store.writeJsonAtomic(file, { ...DEFAULT_TIMINGS, ...normalized.value });
  const changed: string[] = [];
  for (const key of TIMINGS_KEYS) {
    const before = (previous as Record<string, unknown>)[key];
    const after = (normalized.value as Record<string, unknown>)[key];
    if (before !== after) changed.push(`${key}: ${pyRepr(before)} -> ${pyRepr(after)}`);
  }
  await audit(
    store,
    "timings.json",
    changed.length > 0 ? changed.join("; ") : "no effective change",
    "owner config API PUT /config/timings",
  );
  return { timings: normalized.value };
}
