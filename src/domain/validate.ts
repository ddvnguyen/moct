/**
 * Validation helpers — port of reporting.py _validate_* + _as_int +
 * _window_cutoff + _parse_event_types, and models.py field validators.
 * Validator error MESSAGES are contract (they feed the mapped error dicts).
 */
import { pyFloat, pyInt, pyRepr, sinceIso } from "./models.js";
import type { ModelScores, Telemetry, WorkerEvaluation } from "./models.js";

function isIntLike(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function clamp100(v: number): number {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

/** models.Telemetry validators verbatim. Throws Error with the exact message. */
export function validateTelemetry(v: unknown): Telemetry | null {
  if (v === null || v === undefined) return null;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("telemetry must be object or null");
  }
  const d = v as Record<string, unknown>;
  const out: Telemetry = { compactions: null, tokens_in: null, tokens_out: null, cache_pct: null };
  for (const k of ["compactions", "tokens_in", "tokens_out"] as const) {
    const val = d[k];
    if (val === null || val === undefined) {
      out[k] = null;
      continue;
    }
    if (typeof val === "boolean") throw new Error("must be int or null, not bool");
    if (!isIntLike(val)) throw new Error("must be int or null");
    out[k] = val < 0 ? 0 : val;
  }
  const cache = d["cache_pct"];
  if (cache === null || cache === undefined) {
    out.cache_pct = null;
    return out;
  }
  if (typeof cache === "boolean") throw new Error("cache_pct must be float or null, not bool");
  if (typeof cache !== "number") throw new Error("cache_pct must be float or null");
  if (cache < 0) {
    out.cache_pct = 0;
    return out;
  }
  if (cache > 100) {
    out.cache_pct = 100;
    return out;
  }
  out.cache_pct = cache;
  return out;
}

function clampScoreField(v: unknown): number {
  if (typeof v === "boolean") throw new Error("must be int, not bool");
  if (!isIntLike(v)) throw new Error("must be int 0-100");
  return clamp100(v);
}

function notesField(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") throw new Error("notes must be str");
  return v;
}

/** models.WorkerEvaluation construction verbatim. */
export function validateWorkerEvaluation(input: {
  confidence: unknown;
  effectiveness: unknown;
  guideline_adherence: unknown;
  task_complexity: unknown;
  task_size: unknown;
  notes?: unknown;
  telemetry?: unknown;
}): WorkerEvaluation {
  let telemetry: Telemetry | null = null;
  const tv = input.telemetry;
  if (tv === null || tv === undefined) telemetry = null;
  else if (tv !== null && typeof tv === "object" && !Array.isArray(tv))
    telemetry = validateTelemetry(tv);
  else throw new Error("telemetry must be object or null");
  return {
    confidence: clampScoreField(input.confidence),
    effectiveness: clampScoreField(input.effectiveness),
    guideline_adherence: clampScoreField(input.guideline_adherence),
    task_complexity: clampScoreField(input.task_complexity),
    task_size: clampScoreField(input.task_size),
    notes: notesField(input.notes ?? ""),
    telemetry,
  };
}

/** models.ModelScores construction verbatim. */
export function validateModelScoresFields(input: Record<string, unknown>): ModelScores {
  return {
    truthfulness: clampScoreField(input["truthfulness"]),
    confidence: clampScoreField(input["confidence"]),
    effectiveness: clampScoreField(input["effectiveness"]),
    guideline_adherence: clampScoreField(input["guideline_adherence"]),
  };
}

export interface EvalError {
  ok: false;
  error: string;
  hint: string;
  [k: string]: unknown;
}

function hasIntSignal(msg: string): boolean {
  return (
    msg.includes("must be int") ||
    msg.toLowerCase().includes("valid integer") ||
    msg.toLowerCase().includes("input should be a valid integer") ||
    msg.includes("cache_pct")
  );
}

/** reporting._validate_evaluation_dict verbatim. */
export function validateEvaluationDict(raw: unknown): [WorkerEvaluation | null, EvalError | null] {
  if (raw === null || raw === undefined) return [null, null];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [
      null,
      {
        ok: false,
        error: "evaluation must be an object",
        hint: "provide {confidence, effectiveness, guideline_adherence, task_complexity, task_size, notes, telemetry}",
      },
    ];
  }
  const d = raw as Record<string, unknown>;
  for (const key of [
    "confidence",
    "effectiveness",
    "guideline_adherence",
    "task_complexity",
    "task_size",
  ]) {
    if (!(key in d)) {
      return [
        null,
        {
          ok: false,
          error: `evaluation missing required field: ${key}`,
          hint: "confidence, effectiveness, guideline_adherence, task_complexity, task_size are required ints 0-100",
        },
      ];
    }
  }
  try {
    const evalObj = validateWorkerEvaluation({
      confidence: d["confidence"],
      effectiveness: d["effectiveness"],
      guideline_adherence: d["guideline_adherence"],
      task_complexity: d["task_complexity"],
      task_size: d["task_size"],
      notes: d["notes"] ?? "",
      telemetry: d["telemetry"] ?? null,
    });
    return [evalObj, null];
  } catch (exc) {
    const msg = (exc as Error).message;
    if (hasIntSignal(msg)) {
      return [
        null,
        {
          ok: false,
          error: `invalid evaluation: ${msg}`,
          hint: "scores/task fields must be ints 0-100 (floats/strings rejected, ints clamped); telemetry nullable {compactions,tokens_in,tokens_out,cache_pct}",
        },
      ];
    }
    return [
      null,
      {
        ok: false,
        error: `invalid evaluation: ${msg}`,
        hint: "scores/task fields must be ints 0-100, notes str, telemetry nullable",
      },
    ];
  }
}

/** reporting._validate_evaluation_args verbatim. */
export function validateEvaluationArgs(
  confidence: unknown,
  effectiveness: unknown,
  guidelineAdherence: unknown,
  notes: unknown = "",
  taskComplexity: unknown = null,
  taskSize: unknown = null,
  telemetry: unknown = null,
): [WorkerEvaluation | null, EvalError | null] {
  if (
    taskComplexity === null ||
    taskComplexity === undefined ||
    taskSize === null ||
    taskSize === undefined
  ) {
    return [
      null,
      {
        ok: false,
        error: "evaluation missing required field: task_complexity/task_size",
        hint: "task_complexity and task_size are required ints 0-100",
      },
    ];
  }
  try {
    const evalObj = validateWorkerEvaluation({
      confidence,
      effectiveness,
      guideline_adherence: guidelineAdherence,
      task_complexity: taskComplexity,
      task_size: taskSize,
      notes: notes ?? "",
      telemetry,
    });
    return [evalObj, null];
  } catch (exc) {
    const msg = (exc as Error).message;
    if (hasIntSignal(msg)) {
      return [
        null,
        {
          ok: false,
          error: `invalid evaluation: ${msg}`,
          hint: "scores/task fields must be ints 0-100 (floats/strings rejected, ints clamped); telemetry nullable",
        },
      ];
    }
    return [
      null,
      {
        ok: false,
        error: `invalid evaluation: ${msg}`,
        hint: "scores/task fields must be ints 0-100, notes str, telemetry nullable",
      },
    ];
  }
}

const REQUIRED_MODEL_SCORES = [
  "truthfulness",
  "confidence",
  "effectiveness",
  "guideline_adherence",
];

/** reporting._validate_model_scores verbatim. */
export function validateModelScores(raw: unknown): [ModelScores | null, EvalError | null] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [
      null,
      {
        ok: false,
        error: "scores must be an object",
        hint: "provide {truthfulness, confidence, effectiveness, guideline_adherence} ints 0-100 (truthfulness is merged hallucination measure)",
      },
    ];
  }
  const d = raw as Record<string, unknown>;
  for (const key of REQUIRED_MODEL_SCORES) {
    if (!(key in d)) {
      return [
        null,
        {
          ok: false,
          error: `scores missing required field: ${key}`,
          hint: "truthfulness, confidence, effectiveness, guideline_adherence are required ints 0-100",
        },
      ];
    }
  }
  if ("hallucination" in d) {
    return [
      null,
      {
        ok: false,
        error: "scores must not contain hallucination (merged into truthfulness)",
        hint: "provide truthfulness (merged hallucination) — hallucination field removed d-32",
      },
    ];
  }
  try {
    return [validateModelScoresFields(d), null];
  } catch (exc) {
    const msg = (exc as Error).message;
    if (
      msg.includes("must be int") ||
      msg.toLowerCase().includes("valid integer") ||
      msg.toLowerCase().includes("input should be a valid integer")
    ) {
      return [
        null,
        {
          ok: false,
          error: `invalid scores: ${msg}`,
          hint: "scores must be ints 0-100 (floats/strings rejected, ints clamped)",
        },
      ];
    }
    return [
      null,
      { ok: false, error: `invalid scores: ${msg}`, hint: "scores must be ints 0-100, notes str" },
    ];
  }
}

/** reporting._as_int verbatim. */
export function asInt(value: unknown, dflt = 0): number {
  if (value === null || value === undefined || value === "") return dflt;
  try {
    return pyInt(value);
  } catch {
    return dflt;
  }
}

/** reporting._window_cutoff verbatim (ValueError text preserved). */
export function windowCutoff(minutes: unknown, now: string): string {
  if (minutes === null || minutes === undefined || minutes === "") return "";
  let value: number;
  try {
    value = pyFloat(minutes);
  } catch {
    throw new Error(`since_minutes must be a number, got ${pyRepr(minutes)}`);
  }
  if (Number.isNaN(value))
    throw new Error(`since_minutes must be a number, got ${pyRepr(minutes)}`);
  if (value <= 0) return "";
  return sinceIso(value, now);
}

/** reporting._parse_event_types verbatim. */
export function parseEventTypes(raw: unknown): string[] {
  return String(raw ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
