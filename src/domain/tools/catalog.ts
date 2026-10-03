/**
 * Team catalog — port of tools/catalog.py. Live-verified via harness adapter
 * subprocess calls (omp/opencode CLIs) with CPython-identical error synthesis
 * for missing/timeout binaries so parity holds with or without the CLIs.
 */
/* eslint-disable complexity, max-depth -- faithful port of mcp-orchestration:
 * control structure mirrors the Python source arm-for-arm; the parity harness
 * (138 same-input cases over MCP stdio) guards behavior, not style metrics. */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  POSITION_TIER,
  DEFAULT_TIER,
  fleetMap,
  harnessAutoPermission,
  positionAutoPermission,
  usageMaxAgeS,
  workspacePermissionPolicy,
  type ModelRecord,
} from "../config.js";
import {
  KNOWN_HARNESSES,
  pyInt,
  pyRepr,
  pyRound0,
  pyStr,
  pyTruthy,
  pyTypeName,
  utcnowIso,
} from "../models.js";
import type { Store } from "../../store/store-interface.js";

// ---------------------------------------------------------------------------
// harness adapters (adapters/omp.py, opencode.py, base.py)
// ---------------------------------------------------------------------------

const MODEL_RE = /[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g;

interface AdapterResult {
  status: "verified" | "unverified" | "error";
  data: Record<string, unknown>[];
  error: string | null;
  checked_at: string;
}

class NotImplementedError extends Error {}
class ValueError extends Error {}

interface GhRun {
  returncode: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  timeoutSec: number,
): { ok: true; result: GhRun } | { ok: false; kind: string; message: string } {
  try {
    const out = execFileSync(args[0], args.slice(1), {
      encoding: "utf-8",
      timeout: timeoutSec * 1000,
      windowsHide: true,
    }) as string;
    return { ok: true, result: { returncode: 0, stdout: out ?? "", stderr: "" } };
  } catch (exc) {
    const err = exc as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      status?: number;
      killed?: boolean;
    };
    if (err.code === "ENOENT") {
      return {
        ok: false,
        kind: "missing",
        message: `[Errno 2] No such file or directory: '${args[0]}'`,
      };
    }
    if (err.killed) {
      return {
        ok: false,
        kind: "timeout",
        message: `Command '${pyStr(args)}' timed out after ${timeoutSec} seconds`,
      };
    }
    if (typeof err.status === "number") {
      return {
        ok: true,
        result: {
          returncode: err.status,
          stdout: String(err.stdout ?? ""),
          stderr: String(err.stderr ?? ""),
        },
      };
    }
    return { ok: false, kind: "os", message: String((exc as Error).message ?? exc) };
  }
}

function ompListModels(): AdapterResult {
  const r = runCli(["omp", "models", "--json"], 15);
  if (!r.ok) return { status: "unverified", data: [], error: r.message, checked_at: utcnowIso() };
  const { result } = r;
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  try {
    const parsed: unknown = JSON.parse(stdout);
    const raw: unknown =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)["models"]
        : parsed;
    const list = Array.isArray(raw) ? raw : [];
    const data: Record<string, unknown>[] = [];
    for (const item of list) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const model = rec["selector"] || rec["id"] || rec["name"];
      if (typeof model !== "string" || !model) continue;
      const entry: Record<string, unknown> = { model };
      for (const key of ["provider", "id", "name", "family"]) {
        const value = rec[key];
        if (typeof value === "string" && value) entry[key] = value;
      }
      data.push(entry);
    }
    if (result.returncode !== 0) {
      const errMsg = (stderr.trim() || stdout.trim() || `exit ${result.returncode}`).slice(0, 500);
      return { status: "unverified", data, error: errMsg, checked_at: utcnowIso() };
    }
    return { status: "verified", data, error: null, checked_at: utcnowIso() };
  } catch {
    /* fall through to regex fallback */
  }
  try {
    const found = [...new Set(stdout.match(MODEL_RE) ?? [])];
    const data = found.map((m) => ({ model: m }));
    const errMsg = (stderr.trim() || "failed to parse omp models output").slice(0, 500);
    return { status: "unverified", data, error: errMsg, checked_at: utcnowIso() };
  } catch (exc2) {
    return {
      status: "unverified",
      data: [],
      error: String((exc2 as Error).message ?? exc2),
      checked_at: utcnowIso(),
    };
  }
}

function opencodeListModels(): AdapterResult {
  const r = runCli(["opencode", "models"], 30);
  if (!r.ok) return { status: "unverified", data: [], error: r.message, checked_at: utcnowIso() };
  const { result } = r;
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  try {
    const found = [...new Set(stdout.match(MODEL_RE) ?? [])];
    const data = found.map((m) => ({ model: m }));
    if (result.returncode !== 0) {
      const errMsg = (stderr.trim() || stdout.trim() || `exit ${result.returncode}`).slice(0, 500);
      return { status: "unverified", data, error: errMsg, checked_at: utcnowIso() };
    }
    return { status: "verified", data, error: null, checked_at: utcnowIso() };
  } catch (exc) {
    return {
      status: "unverified",
      data: [],
      error: String((exc as Error).message ?? exc),
      checked_at: utcnowIso(),
    };
  }
}

function getAdapterListModels(harnessName: string): AdapterResult {
  if (!(KNOWN_HARNESSES as readonly string[]).includes(harnessName))
    throw new ValueError("unknown harness");
  if (harnessName === "omp") return ompListModels();
  if (harnessName === "opencode") return opencodeListModels();
  throw new NotImplementedError("adapter not implemented (P2), see DESIGN.md §8");
}

// ---------------------------------------------------------------------------
// team_catalog
// ---------------------------------------------------------------------------

const CATALOG_ITEM_KEYS = [
  "harness",
  "provider_arg",
  "mode",
  "max_concurrent",
  "family",
  "tier",
  "quality_index",
  "thinking",
  "priority",
  "priority_degraded",
  "degrade_when_usage",
  "fallback",
  "enabled",
  "notes",
];

export function teamCatalog(store: Store, harness = "omp", position = ""): Record<string, unknown> {
  try {
    if (!(KNOWN_HARNESSES as readonly string[]).includes(harness)) {
      return {
        ok: false,
        error: `unknown harness: ${harness}`,
        hint: `known harnesses: ${KNOWN_HARNESSES.join(", ")}`,
      };
    }
    let fleetReg: ReturnType<typeof fleetMap>;
    try {
      fleetReg = fleetMap(store.root);
    } catch (exc) {
      return {
        ok: false,
        error: `failed to load fleet map: ${(exc as Error).message}`,
        hint: "check fleet.json",
      };
    }
    let positionsMap = fleetReg.positions || {};
    if (typeof positionsMap !== "object" || positionsMap === null || Array.isArray(positionsMap)) {
      return { ok: false, error: "fleet map positions is not a dict", hint: "check fleet.json" };
    }
    if (position) {
      if (!(position in positionsMap)) {
        return {
          ok: false,
          error: `unknown position: ${position}`,
          hint: `known positions: ${Object.keys(positionsMap).sort().join(", ")}`,
        };
      }
      positionsMap = { [position]: positionsMap[position] };
    }
    function attempt(
      harnessName: string,
    ): [string, string | null, string, Record<string, unknown>[]] {
      let status = "unverified";
      let error: string | null = null;
      let checkedAt = utcnowIso();
      let data: Record<string, unknown>[] = [];
      try {
        const result = getAdapterListModels(harnessName);
        status = result.status;
        error = result.error;
        checkedAt = result.checked_at || utcnowIso();
        data = [...(result.data || [])];
      } catch (exc) {
        if (exc instanceof NotImplementedError) {
          error = (exc as Error).message;
        } else if (exc instanceof ValueError) {
          throw exc;
        } else {
          error = String((exc as Error).message ?? exc);
        }
      }
      return [status, error, checkedAt, data];
    }
    let fallbackFrom: string | null = null;
    let adapterStatus: string,
      adapterError: string | null,
      adapterCheckedAt: string,
      adapterData: Record<string, unknown>[];
    try {
      [adapterStatus, adapterError, adapterCheckedAt, adapterData] = attempt(harness);
    } catch (exc) {
      return {
        ok: false,
        error: String((exc as Error).message ?? exc),
        hint: `known harnesses: ${KNOWN_HARNESSES.join(", ")}`,
      };
    }
    if (adapterStatus !== "verified" && harness === "omp") {
      const [fbStatus, fbError, fbCheckedAt, fbData] = attempt("opencode");
      if (fbStatus === "verified") {
        fallbackFrom = "omp";
        harness = "opencode";
        adapterStatus = fbStatus;
        adapterError = fbError;
        adapterCheckedAt = fbCheckedAt;
        adapterData = fbData;
      } else if (fbError) {
        adapterError = `omp: ${adapterError}; opencode: ${fbError}`;
      }
    }
    const liveSet = new Set<string>();
    if (adapterStatus === "verified") {
      for (const entry of adapterData) {
        const m = entry["model"];
        if (typeof m === "string" && m) liveSet.add(m);
      }
    }
    const outPositions: Record<string, Record<string, unknown>[]> = {};
    for (const [posName, entry] of Object.entries(positionsMap)) {
      const records = [
        ...((entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? (entry.models as ModelRecord[] | undefined)
          : undefined) || []),
        ...((entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? (entry.fallback as ModelRecord[] | undefined)
          : undefined) || []),
      ];
      const entries: Record<string, unknown>[] = [];
      for (const rec of records) {
        const modelStr =
          rec !== null && typeof rec === "object" ? (rec as ModelRecord).model : String(rec);
        const item: Record<string, unknown> = {
          position: posName,
          model: modelStr,
          mcp_tier: POSITION_TIER[posName] ?? DEFAULT_TIER,
          live_verified: liveSet.has(modelStr),
          checked_at: adapterCheckedAt,
        };
        if (rec !== null && typeof rec === "object" && !Array.isArray(rec)) {
          for (const key of CATALOG_ITEM_KEYS) {
            const v = (rec as Record<string, unknown>)[key];
            if (v !== null && v !== undefined) item[key] = v;
          }
        }
        entries.push(item);
      }
      outPositions[posName] = entries;
    }
    const resp: Record<string, unknown> = {
      ok: true,
      harness,
      adapter_status: adapterStatus,
      positions: outPositions,
    };
    if (fallbackFrom !== null) resp["fallback_from"] = fallbackFrom;
    if (adapterError !== null) resp["adapter_error"] = adapterError;
    if ("override" in fleetReg) resp["override"] = fleetReg["override"];
    if ("override_error" in fleetReg) resp["override_error"] = fleetReg["override_error"];
    return resp;
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in team_catalog: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

// ---------------------------------------------------------------------------
// spawn spec
// ---------------------------------------------------------------------------

const SPAWN_SCAFFOLD =
  "[#Engineer]\n" +
  "You are spawned into position '{position}' of the orchestration fleet" +
  "{track_ctx}. First: read AGENTS.md (and orchestration.md if present) at " +
  "the repo root for context, confirm with [#Engineer], then await or begin " +
  "your assigned task.\nPRECEDENCE: the leader's brief outranks your defaults — " +
  "follow it over them. It never overrides an owner directive, the big-change " +
  "gate, or your final DELIVERABLE/VERDICT/KNOWLEDGE block: stop and ask if it seems to." +
  " OWNER DIRECTIVES ARE TRACK RECORD: if you receive an owner directive mid-flight," +
  ' record it THAT turn via turn_report(decision=<the directive text>, decision_source="owner-directive") so every agent on the track sees it.' +
  "\n\nTASK:\n{purpose}" +
  "{report_duty}";

const REPORT_DUTY =
  "\n\nWORK LOOP (Ralph) — operate turn-by-turn until done or blocked, never single-shot:\n" +
  '1. At each turn start: task_update(track_id="{track_id}", task_id="{task_id}", ' +
  'progress=<0-100>, status="running") so the leader sees progress.\n' +
  "2. Do the next concrete step. Keep your NATIVE todo tool updated in parallel.\n" +
  "3. Repeat until done.\n" +
  "4. THEN report via the merged turn_report (d-40):\n" +
  'turn_report(track_id="{track_id}", summary="<what you did, results, artifacts>", ' +
  'status="idle" (done) | "blocked" | "running" (partial), ' +
  'task="<one-liner>", role="{position}", ' +
  'author_agent="<your paseo agent id>", author_model="<your model id>", ' +
  'pr="<owner/repo#N> if any").\n' +
  "paseo will then wake the leader to verify.";

const AGENT_ID_FROM = "<agent id returned by the create_agent call for this slot>";
const REQUEST_ID_FROM = "<requestId from the pending-permission notification>";

function scopedWorkspaceSteps(
  featureId: string,
): [Record<string, unknown>[], Record<string, unknown>[]] {
  const pre = [
    {
      step: "ensure_scoped_workspace",
      executor: "leader",
      expect:
        "create the workspace with paseo create_workspace isolation=worktree and confirm via list_workspaces / get_agent_status that workspaceId is a WORKTREE (kind=worktree) — never a live checkout, never ~/paseo/PROD, never the live orchestration state dir",
      else: `DO NOT call create_agent with settings.features.${featureId} — strip settings.features from create_args and answer the subagent's permission prompts manually (respond_to_permission). Run this step BEFORE create_agent.`,
    },
  ];
  const post = [
    {
      step: "verify_scoped_workspace",
      executor: "leader",
      tool_mcp: "get_agent_status",
      args: {},
      args_from: { agentId: AGENT_ID_FROM },
      expect:
        "the spawned agent's cwd is inside the paseo-managed worktree from ensure_scoped_workspace (and its workspaceId is that workspace)",
      else: {
        tool_mcp: "update_agent",
        args: { settings: { features: { [featureId]: false } } },
        args_from: { agentId: AGENT_ID_FROM },
        // eslint-disable-next-line unicorn/no-thenable -- wire contract: post-spawn steps carry a `then` key
        then: "re-read features[].value once",
        note: "REVOKE then ESCALATE to the owner — the agent is not in a scoped worktree, so it must not hold auto-allow. Never loop.",
      },
    },
  ];
  return [pre, post];
}

function autoPermissionPlan(
  harnessName: string,
): [Record<string, unknown>, Record<string, unknown>[]] {
  const mechanism = harnessAutoPermission(harnessName);
  const featureId = mechanism.feature_id;
  if (featureId) {
    const settingsPatch: Record<string, unknown> = { features: { [featureId]: true } };
    return [
      settingsPatch,
      [
        {
          step: "verify_auto_permission",
          executor: "leader",
          tool_mcp: "get_agent_status",
          args: {},
          args_from: { agentId: AGENT_ID_FROM },
          expect: `features[${featureId}].value == true`,
          else: {
            tool_mcp: "update_agent",
            args: { settings: { features: { [featureId]: true } } },
            args_from: { agentId: AGENT_ID_FROM },
            // eslint-disable-next-line unicorn/no-thenable -- wire contract: post-spawn steps carry a `then` key
            then: `re-read features[${featureId}].value once`,
          },
          note:
            "YOU execute this, after create_agent — the subagent never repairs its own flag. Fill agentId from the create_agent response. If features[" +
            `${featureId}].value reads false, issue the \`else\` update_agent ONCE (leader-issued), then re-read once. Observed 2026-09-30 on a live opencode agent: a leader-issued write read TRUE immediately on a running agent and was still true >=20s later on an idle one. A SELF-issued write on the agent's own id read back false every time, as did a write racing an active turn — do not rely on either. Still false after one leader repair + re-read -> ESCALATE to the owner, do not loop. Re-verify after any LATER update_agent settings write to the same agent: a settings write can reset it. The create-time settings key is the primary mechanism; this step is the detector that makes a silent miss visible.`,
        },
      ],
    ];
  }
  const modes = [...(mechanism.permissive_modes || [])];
  let expect = "auto-accept feature or permissive mode";
  if (modes.length) expect = `auto-accept feature or permissive mode (${modes.join("/")})`;
  return [
    {},
    [
      {
        step: "ensure_auto_permission",
        executor: "leader",
        tool_mcp: "inspect_provider",
        args: { provider: harnessName },
        expect,
        else: {
          tool_mcp: "respond_to_permission",
          args: { response: { behavior: "allow" } },
          args_from: { agentId: AGENT_ID_FROM, requestId: REQUEST_ID_FROM },
          note: 'YOU execute this, after create_agent — the subagent never answers its own permission prompts. No known auto-accept for this harness — answer the subagent\'s prompts promptly; inside its worktree allow, outside it stop and ask the owner. Fill agentId from create_agent and requestId from the notification; a request carrying _meta["paseo/requireApproval"] is never auto-accepted, so those still reach you',
        },
      },
    ],
  ];
}

function slotHarness(record: Record<string, unknown>, def: string): string {
  const providerArg = String(record["provider_arg"] || "");
  if (providerArg.includes("/")) return providerArg.split("/", 2)[0];
  return String(record["harness"] || def || "");
}

function pyFormat(template: unknown, vars: Record<string, string>): string {
  if (typeof template !== "string") {
    throw new Error(`'${pyTypeName(template)}' object has no attribute 'format'`);
  }
  const ESC0 = "\u0000";
  const ESC1 = "\u0001";
  let t = template.split("{{").join(ESC0).split("}}").join(ESC1);
  t = t.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}|\{\}/g, (m, name: string) => {
    if (m === "{}") throw new Error("IndexError: Replacement index 0 out of range");
    if (!(name in vars)) throw new Error(`KeyError: '${name}'`);
    return vars[name];
  });
  // leftover single braces (e.g. {0}, {a.b}) also fail in Python; treat as KeyError
  const bad = /\{[^{}]*\}/.exec(t);
  if (bad) throw new Error(`KeyError: '${bad[0]}'`);
  return t.split(ESC0).join("{").split(ESC1).join("}");
}

export function fleetSpawnSpec(
  store: Store,
  position: string,
  count: unknown = 1,
  title = "",
  trackId = "",
  purpose = "",
  taskId = "",
  model = "",
  harness = "omp",
): Record<string, unknown> {
  try {
    if (!position) {
      // NOTE: catalog.py reads `positions` before assignment here (NameError ->
      // outer unexpected-error branch). Unreachable via fleet(), which guards
      // position first; the name + text below mirror CPython exactly.
      const unbound = new Error("local variable 'positions' referenced before assignment");
      unbound.name = "NameError";
      throw unbound;
    }
    if (position === "leader") {
      return {
        ok: false,
        error: "leader position is filled via leader_handoff + leader_register, not spawned",
        hint: "initiate leader_handoff, then the successor registers itself",
      };
    }
    let countNum: number;
    if (typeof count === "boolean") countNum = count ? 1 : 0;
    else if (typeof count === "number" && Number.isInteger(count)) countNum = count;
    else return { ok: false, error: "count must be 1..3", hint: "spawn in small batches" };
    if (!(countNum >= 1 && countNum <= 3)) {
      return { ok: false, error: "count must be 1..3", hint: "spawn in small batches" };
    }
    const registry = fleetMap(store.root);
    const positions = registry.positions || {};
    if (!(position in positions)) {
      return {
        ok: false,
        error: `unknown position: ${position}`,
        hint: `known positions: ${Object.keys(positions).sort().join(", ")}`,
      };
    }
    if (!(KNOWN_HARNESSES as readonly string[]).includes(harness)) {
      return {
        ok: false,
        error: `unknown harness: ${harness}`,
        hint: `known harnesses: ${KNOWN_HARNESSES.join(", ")}`,
      };
    }
    if (harness === "dsh") {
      return {
        ok: false,
        error: "adapter not implemented (P2), see DESIGN.md §8 - harness dsh",
        hint: "use harness='omp' (default), 'opencode' or 'pi'",
      };
    }
    const entry = positions[position] as unknown as Record<string, unknown>;
    const enabled = (rs: unknown[]) =>
      rs.filter((r) => (r as Record<string, unknown>)["enabled"] !== false);
    let primary = enabled(((entry["models"] as unknown[]) || []) as unknown[]);
    let fallback = enabled(((entry["fallback"] as unknown[]) || []) as unknown[]);
    const spawnDefaultsRaw = entry["spawn"];
    const spawnDefaults =
      spawnDefaultsRaw !== null &&
      typeof spawnDefaultsRaw === "object" &&
      !Array.isArray(spawnDefaultsRaw)
        ? (spawnDefaultsRaw as Record<string, unknown>)
        : {};
    if (model) {
      const picked = [...primary, ...fallback].filter((r) => {
        const rec = r as Record<string, unknown>;
        return rec["model"] === model || rec["family"] === model;
      });
      if (!picked.length) {
        return {
          ok: false,
          error: `model ${pyRepr(model)} not registered for position ${pyRepr(position)}`,
          hint: "team_catalog or fleet_recommend for valid models",
        };
      }
      primary = picked;
      fallback = [];
    }
    let trackCtx = "";
    let reportDuty = "";
    if (trackId) {
      trackCtx = ` (track ${trackId})`;
      reportDuty = REPORT_DUTY.split("{track_id}")
        .join(trackId)
        .split("{position}")
        .join(position)
        .split("{task_id}")
        .join(taskId || "<task_id from your brief>");
    }
    const roster =
      "FLEET ROSTER (literal @role mentions refer to these positions): " +
      Object.keys(positions).join(", ");
    const initPromptRaw = entry["init_prompt"];
    const initPrompt = typeof initPromptRaw === "string" ? initPromptRaw : "";
    const instructionModeRaw = entry["instruction_mode"];
    const instructionMode =
      instructionModeRaw === "extend" || instructionModeRaw === "replace"
        ? instructionModeRaw
        : "extend";
    const purposeText = purpose || "(assigned by leader after spawn)";
    let prompt: string;
    if (instructionMode === "replace" && initPrompt) {
      prompt = initPrompt + "\n" + roster + "\n\nTASK:\n" + purposeText + reportDuty;
    } else {
      const tpl = SPAWN_SCAFFOLD.split("\n\nTASK:").join(`\n${roster}\n\nTASK:`);
      prompt = tpl
        .split("{position}")
        .join(position)
        .split("{track_ctx}")
        .join(trackCtx)
        .split("{purpose}")
        .join(purposeText)
        .split("{report_duty}")
        .join(reportDuty);
      if (initPrompt) {
        prompt += "\n\nOWNER-ADDED INSTRUCTIONS (roles config init_prompt):\n" + initPrompt;
      }
    }
    const slots: Record<string, unknown>[] = [];
    const slotCaveats: string[] = [];
    for (const [i, recRaw] of [...primary, ...fallback].slice(0, countNum).entries()) {
      const rec = recRaw as Record<string, unknown>;
      const eff: Record<string, unknown> = rec["harness_explicit"]
        ? rec
        : { ...rec, harness, provider_arg: `${harness}/${rec["model"]}` };
      const template = (spawnDefaults["title_template"] as string) || "{position} agent";
      let titleI: string;
      try {
        titleI = pyFormat(template, { position, task: title || position });
      } catch {
        titleI = `${position} agent`;
      }
      if (countNum > 1) titleI += ` #${i + 1}`;
      const createArgs: Record<string, unknown> = {
        provider: eff["provider_arg"],
        title: titleI,
        initialPrompt: prompt,
      };
      if (spawnDefaults["workspace_id"]) createArgs["workspaceId"] = spawnDefaults["workspace_id"];
      if (spawnDefaults["notify_on_finish"] ?? true) createArgs["notifyOnFinish"] = true;
      const labelsRaw = spawnDefaults["labels"];
      const labels: Record<string, unknown> = {
        ...((labelsRaw !== null && typeof labelsRaw === "object" && !Array.isArray(labelsRaw)
          ? labelsRaw
          : {}) as Record<string, unknown>),
      };
      if (!("role" in labels)) labels["role"] = position;
      createArgs["labels"] = labels;
      const steps: Record<string, unknown>[] = [];
      if (eff["mode"]) {
        steps.push({
          step: "set_mode",
          tool_mcp: "set_agent_mode",
          args: { modeId: eff["mode"] },
          args_from: { agentId: AGENT_ID_FROM },
          why: `${eff["model"]} spawns in a different default mode`,
        });
      }
      if (eff["max_concurrent"]) {
        steps.push({
          step: "concurrency_cap",
          cap: eff["max_concurrent"],
          why: eff["notes"] ?? "",
        });
      }
      if (eff["thinking"]) {
        steps.push({
          step: "set_thinking",
          tool_mcp: "update_agent",
          args: { settings: { thinkingOptionId: eff["thinking"] } },
          args_from: { agentId: AGENT_ID_FROM },
          why: `position default thinking=${eff["thinking"]}`,
        });
      }
      const [autoOk0, autoError] = positionAutoPermission(entry, registry.fleet_spawn);
      let autoOk = autoOk0;
      if (autoError) slotCaveats.push(autoError);
      const workspaceId = String(spawnDefaults["workspace_id"] || "");
      let preSteps: Record<string, unknown>[] = [];
      if (autoOk) {
        const [allowed, reason] = workspacePermissionPolicy(workspaceId, store.root);
        if (!allowed) {
          autoOk = false;
          slotCaveats.push(`auto_accept NOT requested: ${reason}`);
        } else {
          const slotHarnessName = slotHarness(eff, harness);
          const [autoSettings, autoSteps] = autoPermissionPlan(slotHarnessName);
          const featureId = harnessAutoPermission(slotHarnessName).feature_id;
          if (!autoSettings || !Object.keys(autoSettings).length) {
            slotCaveats.push(
              `no auto-accept feature for harness ${pyRepr(slotHarnessName)} — the subagent gets the probe step and the leader answers its prompts; no auto_accept key was invented.`,
            );
            steps.push(...autoSteps);
          } else if (!featureId) {
            slotCaveats.push(
              "auto_accept requested WITHOUT the scoped-workspace steps: no feature id for harness " +
                `${pyRepr(slotHarnessName)} to name in them.`,
            );
            steps.push(...autoSteps);
          } else {
            const settings = (createArgs["settings"] ?? {}) as Record<string, unknown>;
            createArgs["settings"] = settings;
            for (const [group, values] of Object.entries(autoSettings)) {
              const target = (settings[group] ?? {}) as Record<string, unknown>;
              settings[group] = target;
              Object.assign(target, values as Record<string, unknown>);
            }
            const [pre, post] = scopedWorkspaceSteps(featureId);
            preSteps = pre;
            slotCaveats.push(
              `auto_accept requested for a subagent in workspace ${workspaceId || "(caller workspace, unresolved)"}: ${reason}. The SERVER verified only what it can — run ensure_scoped_workspace BEFORE create_agent and verify_scoped_workspace AFTER it. A request carrying _meta["paseo/requireApproval"] is documented as never auto-accepted on the ACP/freebuff host path but is UNVERIFIED for opencode auto_accept; do not rely on it.`,
            );
            steps.push(...autoSteps);
            steps.push(...post);
          }
        }
      }
      slots.push({
        pre_spawn_steps: preSteps,
        slot: i + 1,
        record: eff,
        tool_mcp: "create_agent",
        args_mcp: createArgs,
        tool_cli: `paseo agent create --provider ${eff["provider_arg"]} --title "${titleI}"`,
        post_spawn_steps: steps,
      });
    }
    const note0 = (entry["note"] as string) ?? "";
    const caveats = [...(note0 ? [note0] : []), ...slotCaveats];
    if (instructionMode === "replace" && !initPrompt) {
      caveats.push(
        "instruction_mode=replace but roles config init_prompt is empty - scaffold used as-is",
      );
    }
    const tier = POSITION_TIER[position] ?? DEFAULT_TIER;
    return {
      ok: true,
      position,
      harness,
      mcp_tier: tier,
      dispatch_note: `provider first segment selects the harness (${harness}); non-explicit records rebased, explicit pins kept. The tier (${tier}) comes from fleet.json \`tiers.byCwd\` (or \`tiers.byAgentId\`) matched against the spawned agent's cwd, which beats MCP_ORCH_TIER; a repo-wide MCP_ORCH_TIER in .mcp.json / opencode.json is ONE value for every agent in the checkout and is only the fallback (d-39/d-41 tiers)`,
      registry_source:
        (registry as unknown as Record<string, unknown>)["override"] ?? "built-in defaults",
      slots,
      caveats,
    };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in fleet_spawn_spec: ${(exc as Error).message}`,
      hint: "check fleet.json registry shape",
    };
  }
}

// ---------------------------------------------------------------------------
// fleet_recommend
// ---------------------------------------------------------------------------

function isPlainDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function fleetRecommend(
  store: Store,
  position: string,
  usage: unknown = null,
  quota: unknown = null,
  live = false,
): Record<string, unknown> {
  try {
    const usageDict = toStrIntDict(usage);
    const quotaDict = toAnyDict(quota);
    let liveSource: Record<string, unknown> | null = null;
    if (live) {
      const snap = readUsageSnapshot(store);
      if (snap && Object.keys(snap).length) {
        liveSource = { ts: snap["ts"], source: (snap["source"] as string) ?? "" };
        const snapUsage = snap["usage"];
        if (snapUsage !== null && typeof snapUsage === "object" && !Array.isArray(snapUsage)) {
          for (const [k, v] of Object.entries(snapUsage as Record<string, unknown>)) {
            if (!(k in usageDict)) usageDict[k] = v as number;
          }
        } else {
          throw new Error(`'${pyTypeName(snapUsage)}' object has no attribute 'items'`);
        }
      }
    }
    const registry = fleetMap(store.root);
    const positions = registry.positions || {};
    if (!(position in positions)) {
      return {
        ok: false,
        error: `unknown position: ${position}`,
        hint: `known positions: ${Object.keys(positions).sort().join(", ")}`,
      };
    }
    const entry = positions[position] as unknown as Record<string, unknown>;
    const records = [
      ...((entry["models"] as unknown[]) || []).filter(
        (r) => (r as Record<string, unknown>)["enabled"] !== false,
      ),
      ...((entry["fallback"] as unknown[]) || []).filter(
        (r) => (r as Record<string, unknown>)["enabled"] !== false,
      ),
    ];
    const recs: Record<string, unknown>[] = [];
    for (const recRaw of records) {
      const rec = recRaw as Record<string, unknown>;
      const model = rec["model"] as string;
      const family = rec["family"] as string | null;
      let used = pyInt(model in usageDict ? usageDict[model] : 0);
      if (family && family !== model) {
        used += pyInt(family in usageDict ? usageDict[family] : 0);
      }
      let q: unknown;
      if (model in quotaDict) q = quotaDict[model];
      else if (family) q = quotaDict[family];
      const reasons: string[] = [];
      let verdict = "recommended";
      const basePriority = (rec["priority"] as number | null) ?? null;
      let effective: number | null =
        basePriority !== null && basePriority !== undefined ? basePriority : 9;
      const degradeAt = rec["degrade_when_usage"];
      if (degradeAt !== null && degradeAt !== undefined && used >= pyInt(degradeAt)) {
        const degraded = (rec["priority_degraded"] as number | null) ?? effective;
        reasons.push(
          `usage ${used} >= degrade_when_usage ${degradeAt}: priority ${effective}->${degraded}`,
        );
        effective = degraded;
      }
      const cap = rec["max_concurrent"];
      if (cap !== null && cap !== undefined && used >= pyInt(cap)) {
        verdict = "blocked";
        reasons.push(`usage ${used} >= max_concurrent ${cap}`);
      }
      if (q !== null && q !== undefined) {
        if (q === "exhausted" || (typeof q === "number" && q <= 0)) {
          verdict = "blocked";
          reasons.push("quota exhausted");
        } else if (typeof q === "number" && q < 0.25) {
          reasons.push(`quota low (${pyRound0(q * 100)}% remaining)`);
        }
      }
      if (verdict === "recommended" && reasons.length) verdict = "degraded";
      if (verdict === "recommended" && !reasons.length) reasons.push("no pressure");
      recs.push({
        model,
        family: family ?? null,
        harness: rec["harness"] ?? null,
        provider_arg: rec["provider_arg"] ?? null,
        tier: rec["tier"] ?? "",
        quality_index: rec["quality_index"] ?? null,
        base_priority: basePriority,
        effective_priority: effective,
        usage: used,
        max_concurrent: cap ?? null,
        quota: q ?? null,
        verdict,
        reasons,
      });
    }
    recs.sort((a, b) => {
      const ea = a["effective_priority"] as number;
      const eb = b["effective_priority"] as number;
      if (ea !== eb) return ea - eb;
      const qa = -(((a["quality_index"] as number) ?? 0) || 0);
      const qb = -(((b["quality_index"] as number) ?? 0) || 0);
      return qa - qb;
    });
    recs.forEach((r, i) => {
      r["rank"] = i + 1;
    });
    const top = recs.find((r) => r["verdict"] !== "blocked") ?? null;
    const out: Record<string, unknown> = {
      ok: true,
      position,
      top: top ? top["model"] : null,
      recommendations: recs,
    };
    if (liveSource) out["live_usage"] = liveSource;
    return out;
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in fleet_recommend: ${(exc as Error).message}`,
      hint: "check usage/quota argument shapes",
    };
  }
}

function toStrIntDict(v: unknown): Record<string, unknown> {
  if (!pyTruthy(v)) return {};
  if (!isPlainDict(v)) throw new TypeError(`'${pyTypeName(v)}' object is not iterable`);
  return { ...(v as Record<string, unknown>) };
}

function toAnyDict(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (!isPlainDict(v)) throw new TypeError(`'${pyTypeName(v)}' object is not iterable`);
  return { ...(v as Record<string, unknown>) };
}

// ---------------------------------------------------------------------------
// usage snapshot io
// ---------------------------------------------------------------------------

const USAGE_FILE = "usage.json";

function usagePath(store: Store): string {
  return path.join(store.root, USAGE_FILE);
}

export function readUsageSnapshot(store: Store): Record<string, unknown> | null {
  const file = usagePath(store);
  if (!existsSync(file)) return null;
  try {
    const snap = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const tsMs = Date.parse(String(snap["ts"]).replace(/Z$/, "+00:00"));
    if (Number.isNaN(tsMs)) return null;
    if (Date.now() - tsMs > usageMaxAgeS() * 1000) return null;
    return snap;
  } catch {
    return null;
  }
}

export function fleetUsageReport(
  store: Store,
  usage: unknown,
  source = "",
  note = "",
): Record<string, unknown> {
  try {
    if (!isPlainDict(usage) || !Object.keys(usage as object).length) {
      return {
        ok: false,
        error: "usage must be a non-empty dict {model: count}",
        hint: "count running agents per model via paseo first",
      };
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(usage as Record<string, unknown>)) {
      const vOk =
        (typeof v === "number" && Number.isInteger(v) && v >= 0) || typeof v === "boolean";
      if (typeof k !== "string" || !vOk || (typeof v === "number" && v < 0)) {
        return {
          ok: false,
          error: `invalid usage entry ${pyRepr(k)}: ${pyRepr(v)}`,
          hint: "keys are model ids or families, values non-negative ints",
        };
      }
      clean[k] = v;
    }
    const snapshot = { ts: utcnowIso(), source, note, usage: clean };
    const file = usagePath(store);
    const tmp = path.join(path.dirname(file), "usage.tmp");
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
    renameSync(tmp, file);
    return { ok: true, stored: file, snapshot, fresh_window_s: usageMaxAgeS() };
  } catch (exc) {
    return {
      ok: false,
      error: `failed to store usage snapshot: ${(exc as Error).message}`,
      hint: "check state dir permissions",
    };
  }
}

export function fleetUsageGet(store: Store, includeStale = true): Record<string, unknown> {
  const snap = readUsageSnapshot(store);
  if (snap === null) {
    const file = usagePath(store);
    if (!existsSync(file)) {
      return {
        ok: true,
        snapshot: null,
        hint: "no usage reported yet; an agent with paseo access should call fleet_usage_report",
      };
    }
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8"));
      if (!includeStale) {
        return {
          ok: true,
          snapshot: null,
          stale: true,
          hint: "snapshot expired; report fresh usage",
          fresh_window_s: usageMaxAgeS(),
        };
      }
      return { ok: true, snapshot: raw, stale: true, fresh_window_s: usageMaxAgeS() };
    } catch (exc) {
      return { ok: false, error: `usage.json unreadable: ${(exc as Error).message}` };
    }
  }
  return { ok: true, snapshot: snap, stale: false, fresh_window_s: usageMaxAgeS() };
}

// ---------------------------------------------------------------------------
// fleet / fleet_usage dispatchers
// ---------------------------------------------------------------------------

export function fleet(
  store: Store,
  mode = "catalog",
  harness = "omp",
  position = "",
  usage: unknown = null,
  quota: unknown = null,
  live = false,
  count: unknown = 1,
  title = "",
  trackId = "",
  purpose = "",
  taskId = "",
  model = "",
): Record<string, unknown> {
  if (mode === "catalog") return teamCatalog(store, harness, position);
  if (mode === "recommend") {
    if (!position) {
      return {
        ok: false,
        error: "position is required for mode=recommend",
        hint: "mode=catalog lists positions",
      };
    }
    return fleetRecommend(store, position, usage, quota, live);
  }
  if (mode === "spawn") {
    if (!position) {
      return {
        ok: false,
        error: "position is required for mode=spawn",
        hint: "mode=catalog lists positions",
      };
    }
    return fleetSpawnSpec(store, position, count, title, trackId, purpose, taskId, model, harness);
  }
  return {
    ok: false,
    error: `invalid mode ${pyRepr(mode)}`,
    hint: "must be one of: catalog, recommend, spawn",
  };
}

export function fleetUsage(
  store: Store,
  action = "get",
  usage: unknown = null,
  source = "",
  note = "",
  includeStale = true,
): Record<string, unknown> {
  if (action === "get") return fleetUsageGet(store, includeStale);
  if (action === "report")
    return fleetUsageReport(store, (usage ?? {}) as Record<string, unknown>, source, note);
  return {
    ok: false,
    error: `invalid action ${pyRepr(action)}`,
    hint: "must be one of: get, report",
  };
}
