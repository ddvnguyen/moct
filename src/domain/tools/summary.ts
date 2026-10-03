/**
 * Summary pipeline — port of summary/spec.py, validate.py, diff.py plus the
 * server.py _mcp_summary_read/_mcp_summary_write adapters.
 */
/* eslint-disable complexity, max-depth -- faithful port of mcp-orchestration:
 * control structure mirrors the Python source arm-for-arm; the parity harness
 * (138 same-input cases over MCP stdio) guards behavior, not style metrics. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { MD_TOKEN_MAX, MD_TOKEN_MIN, estimateTokens, fleetMap, summaryPath } from "../config.js";
import { pyInt, pyRepr, utcnowIso } from "../models.js";
import { StateError, type Store, type Track } from "../../store/store-interface.js";

const SECTION_SCHEMA = [
  "# Orchestration Status",
  "## Track Goal",
  "## Leader",
  "## Fleet Status",
  "## Tasks",
  "## Track Summary",
  "## Blockers & Decisions",
  "## Lessons Snapshot",
  "## Resume Instructions",
];

const OUTPUT_INSTRUCTIONS =
  "return ONLY the markdown content; include the YAML frontmatter block with keys: " +
  "type: status-summary, project, tracks, generated_by, generated_at, " +
  "last_modified, tokens_estimate";

const BUILDER_PROMPT_TEMPLATE =
  "You are the cheap summarizer. Compose orchestration.md content from the provided inputs. " +
  "Include EVERY required section: {sections}. " +
  "Tasks section MUST list every task as: `- <id> <title> — <status> <progress>% (assignee)`. " +
  "Track Summary is a 5-10 line agent overview written for a resuming agent (what matters now). " +
  "Keep tokens_estimate between 4000-8000 by expanding Track Summary with per-turn detail when short " +
  "and compressing oldest entries when long. " +
  "Do NOT invent facts — only use provided inputs. " +
  "Return ONLY markdown with YAML frontmatter.";

function buildBuilderPrompt(): string {
  const sections = SECTION_SCHEMA.join(", ");
  let prompt = BUILDER_PROMPT_TEMPLATE.split("{sections}").join(sections);
  const words = prompt.split(/\s+/);
  if (words.length > 200) prompt = words.slice(0, 200).join(" ");
  return prompt;
}

function resolveBudgets(track: Track): [number, number] {
  let mdMin = MD_TOKEN_MIN;
  let mdMax = MD_TOKEN_MAX;
  try {
    const overrides = track.overrides || {};
    if (overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)) {
      if ("md_token_min" in overrides) {
        try {
          const v = pyInt(overrides["md_token_min"]);
          if (v > 0) mdMin = v;
        } catch {
          /* ignore */
        }
      }
      if ("md_token_max" in overrides) {
        try {
          const v = pyInt(overrides["md_token_max"]);
          if (v > 0) mdMax = v;
        } catch {
          /* ignore */
        }
      }
      const tb = overrides["token_budgets"];
      if (tb !== null && typeof tb === "object" && !Array.isArray(tb)) {
        const tbr = tb as Record<string, unknown>;
        if ("min" in tbr) {
          try {
            const v = pyInt(tbr["min"]);
            if (v > 0) mdMin = v;
          } catch {
            /* ignore */
          }
        }
        if ("max" in tbr) {
          try {
            const v = pyInt(tbr["max"]);
            if (v > 0) mdMax = v;
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return [mdMin, mdMax];
}

export function buildSummarySpecAsync(
  store: Store,
  track: Track,
): Promise<Record<string, unknown>> {
  return (async () => {
    try {
      let allTurns: Record<string, unknown>[] = [];
      try {
        allTurns = await store.readTurns(track.project_id, track.id);
      } catch {
        allTurns = [];
      }
      const recentTurns = allTurns.length > 10 ? allTurns.slice(-10) : [...allTurns];
      let allDecisions: Record<string, unknown>[] = [];
      try {
        allDecisions = await store.readDecisions(track.project_id);
      } catch {
        allDecisions = [];
      }
      const decisionsOneLiners = allDecisions.map((d) => {
        const did = "id" in d ? (d["id"] ?? "") : "";
        const text = "decision" in d ? (d["decision"] ?? "") : "";
        const oneLiner = typeof text === "string" ? text.slice(0, 100) : String(text).slice(0, 100);
        return { id: did, one_liner: oneLiner };
      });
      let modelHint: unknown;
      try {
        const fleet = fleetMap();
        const pos = fleet.positions["summarizer"] as unknown as Record<string, unknown> | undefined;
        const models = pos?.["models"];
        if (!Array.isArray(models) || !models.length) throw new Error("no summarizer models");
        modelHint = models[0];
      } catch {
        modelHint = "opencode-go/muse-spark-1.3-contributor";
      }
      const [mdMin, mdMax] = resolveBudgets(track);
      const spec = {
        track_id: track.id,
        project_id: track.project_id,
        goal: track.goal,
        status: track.status,
        leader: track.leader ? { ...track.leader } : null,
        workers: track.workers.map((w) => ({
          ...w,
          evaluation: w.evaluation ? { ...w.evaluation } : null,
        })),
        queue: track.queue.map((q) => ({ ...q })),
        recent_turns: recentTurns,
        decisions_one_liners: decisionsOneLiners,
        token_budgets: { min: mdMin, max: mdMax },
        md_token_min: mdMin,
        md_token_max: mdMax,
        overrides: { ...track.overrides },
        overrides_provenance: { ...track.overrides_provenance },
        section_schema: [...SECTION_SCHEMA],
        output_instructions: OUTPUT_INSTRUCTIONS,
        builder_prompt: buildBuilderPrompt(),
        model_hint: modelHint,
      };
      return { ok: true, spec };
    } catch (exc) {
      return { ok: false, error: (exc as Error).message };
    }
  })();
}

// ---------------------------------------------------------------------------
// validate + commit
// ---------------------------------------------------------------------------

const REQUIRED_SECTIONS = [...SECTION_SCHEMA];
const FRONTMATTER_RE = /^---\n(.*?)\n---/s;

function parseFrontmatter(content: string): [Record<string, string> | null, string | null] {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return [null, "frontmatter missing (expected ^---\\n...\\n---)"];
  const raw = m[1];
  const data: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (!t.includes(":")) continue;
    const idx = t.indexOf(":");
    data[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return [data, null];
}

function stripChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

function normalizeLine(line: string): string {
  let l = line.trim().toLowerCase();
  l = l.replace(/[^\w\s]/g, "");
  l = l.replace(/\s+/g, " ").trim();
  return l;
}

function normalizeBlock(block: string): string {
  const parts: string[] = [];
  for (const rawLine of block.split("\n")) {
    const nl = normalizeLine(rawLine);
    if (nl) parts.push(nl);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function checkRepetition(content: string): string[] {
  const m = FRONTMATTER_RE.exec(content);
  const body = m ? content.slice(m[0].length) : content;
  const rawBlocks = body.trim().split(/\n\s*\n/);
  const blocks = rawBlocks.map((b) => b.trim()).filter((b) => b.length > 0);
  if (blocks.length < 2) return [];
  const normBlocks = blocks.map(normalizeBlock);
  const filteredBlocks = normBlocks.filter((nb) => nb.length > 0);
  if (!filteredBlocks.length) return [];
  const blockCounter = new Map<string, number>();
  for (const nb of filteredBlocks) blockCounter.set(nb, (blockCounter.get(nb) ?? 0) + 1);
  const totalBlocks = filteredBlocks.length;
  let duplicatedBlocks = 0;
  for (const cnt of blockCounter.values()) if (cnt > 1) duplicatedBlocks += cnt;
  const blockRatio = totalBlocks ? (duplicatedBlocks / totalBlocks) * 100 : 0;
  const allLines: string[] = [];
  for (const b of blocks) {
    for (const line of b.split("\n")) allLines.push(line);
  }
  const normLines = allLines.map(normalizeLine).filter((ln) => ln.length > 0);
  let lineRatio = 0;
  if (normLines.length) {
    const lineCounter = new Map<string, number>();
    for (const nl of normLines) lineCounter.set(nl, (lineCounter.get(nl) ?? 0) + 1);
    let duplicatedLines = 0;
    for (const cnt of lineCounter.values()) if (cnt > 1) duplicatedLines += cnt;
    lineRatio = (duplicatedLines / normLines.length) * 100;
  }
  const maxRatio = blockRatio > lineRatio ? blockRatio : lineRatio;
  if (maxRatio > 30) {
    let pct = Math.round(maxRatio);
    // CPython round() is half-even; mirror the bump rule for values that
    // round down to <= 30 while exceeding it.
    if (maxRatio - Math.floor(maxRatio) === 0.5 && Math.floor(maxRatio) % 2 === 1)
      pct = Math.floor(maxRatio);
    if (pct <= 30 && maxRatio > 30) pct = 31;
    return [`excessive repetition: ${pct}% repeated blocks`];
  }
  return [];
}

function checkPlaceholder(content: string): string[] {
  const errors: string[] = [];
  if (content.includes("TODO")) errors.push("placeholder text 'TODO' found");
  if (content.includes("FIXME")) errors.push("placeholder text 'FIXME' found");
  if (content.includes("<...>")) errors.push("placeholder text '<...>' found");
  return errors;
}

function atomicWriteText(dest: string, content: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  const ext = path.extname(dest);
  const tmp = dest.slice(0, dest.length - ext.length) + `${ext}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, dest);
}

export async function validateAndCommit(
  store: Store,
  track: Track,
  content: string,
  generatedBy = "",
): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  const [fmData, fmErr] = parseFrontmatter(content);
  if (fmErr) {
    errors.push(fmErr);
  } else {
    const fm = fmData as Record<string, string>;
    const typeVal = stripChars(stripChars((fm["type"] ?? "").trim(), '"'), "'");
    if (typeVal !== "status-summary") {
      errors.push(`frontmatter type must be 'status-summary', got ${pyRepr(typeVal)}`);
    }
    const projRaw = fm["project"] ?? "";
    const cleaned = stripChars(
      stripChars(stripChars(stripChars(projRaw.trim(), '"'), "'"), "[]"),
      "",
    ).trim();
    if (cleaned !== track.project_id) {
      if (!projRaw.includes(track.project_id)) {
        errors.push(
          `frontmatter project must equal ${pyRepr(track.project_id)}, got ${pyRepr(projRaw)}`,
        );
      }
    }
  }
  for (const sec of REQUIRED_SECTIONS) {
    if (!content.includes(sec)) errors.push(`missing required section: ${pyRepr(sec)}`);
  }
  const [mdMin, mdMax] = resolveBudgets(track);
  const nTokens = estimateTokens(content);
  if (nTokens < mdMin || nTokens > mdMax) {
    errors.push(`token estimate ${nTokens} out of bounds [${mdMin}, ${mdMax}]`);
  }
  errors.push(...checkPlaceholder(content));
  errors.push(...checkRepetition(content));
  if (errors.length) {
    try {
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "summary_rejected",
          project_id: track.project_id,
          track_id: track.id,
          payload: { errors, tokens_estimate: nTokens },
        },
        track.project_id,
      );
    } catch {
      /* best-effort */
    }
    return { ok: false, errors };
  }
  let dest: string;
  try {
    dest = summaryPath();
  } catch (exc) {
    return { ok: false, errors: [`failed to resolve summary path: ${(exc as Error).message}`] };
  }
  try {
    atomicWriteText(dest, content);
  } catch (exc) {
    return { ok: false, errors: [`failed to write summary: ${(exc as Error).message}`] };
  }
  try {
    await store.appendEvent(
      {
        ts: utcnowIso(),
        type: "summary_committed",
        project_id: track.project_id,
        track_id: track.id,
        payload: { path: dest, tokens_estimate: nTokens, generated_by: generatedBy },
      },
      track.project_id,
    );
  } catch {
    /* best-effort */
  }
  return { ok: true, path: dest, tokens_estimate: nTokens };
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

function extractClaims(content: string): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  let m = /Leader\s*:\s*([^\s\n\r]+)/i.exec(content);
  if (m) {
    let val = m[1].trim().replace(/[,;\]]+$/, "");
    val = val.replace(/[,\]]+$/, "");
    claims["leader"] = val;
  } else {
    const m2 = /leader[^\n]{0,40}([a-zA-Z0-9._-]{3,})/i.exec(content);
    if (m2) claims["leader"] = m2[1];
  }
  m = /Status\s*:\s*(running|blocked|idle|handing_off|active|done|archived)/i.exec(content);
  if (m) {
    claims["status"] = m[1].toLowerCase();
  } else {
    for (const secName of ["## Track Summary", "## Leader", "## Current Status"]) {
      const idx = content.indexOf(secName);
      if (idx === -1) continue;
      const sliceEnd = content.indexOf("##", idx + secName.length);
      const section =
        sliceEnd !== -1 ? content.slice(idx, sliceEnd) : content.slice(idx, idx + 2000);
      const m3 = /\b(running|blocked|idle|handing_off|active|done|archived)\b/i.exec(section);
      if (m3) {
        claims["status"] = m3[1].toLowerCase();
        break;
      }
    }
  }
  m = /workers?\s*[:-]?\s*(\d+)/i.exec(content);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n)) claims["workers"] = n;
  } else {
    const m2 = /(\d+)[ \t]+workers?/i.exec(content);
    if (m2) {
      const n = parseInt(m2[1], 10);
      if (!Number.isNaN(n)) claims["workers"] = n;
    }
  }
  const blockers: string[] = [];
  const idx = content.indexOf("## Blockers & Decisions");
  if (idx !== -1) {
    let rest = content.slice(idx + "## Blockers & Decisions".length);
    const nextH = /\n##\s+/.exec(rest);
    if (nextH) rest = rest.slice(0, nextH.index);
    const decisionsCut = rest.split(/\n#+\s*decisions\b|\n\*\*decisions/i)[0];
    for (const line of decisionsCut.split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("- ")) blockers.push(stripped.slice(2).trim());
      else if (stripped.startsWith("-") && stripped.length > 1)
        blockers.push(stripped.slice(1).trim());
    }
  }
  claims["blockers"] = blockers;
  return claims;
}

export async function diffSummaryVsState(
  store: Store,
  track: Track,
  content = "",
): Promise<Record<string, unknown>> {
  const unreadable = { ok: true, claims: {}, state: {}, mismatches: [], verdict: "unreadable" };
  if (!content) {
    try {
      const p = summaryPath();
      if (!existsSync(p)) return unreadable;
      content = readFileSync(p, "utf-8");
    } catch {
      return unreadable;
    }
  }
  if (!content || !content.trim()) return unreadable;
  const claims = extractClaims(content);
  const leaderVal = track.leader ? track.leader.agent_id : null;
  const statusVal = track.status;
  const workersVal = track.workers.length;
  let turns: Record<string, unknown>[] = [];
  try {
    turns = await store.readTurns(track.project_id, track.id);
  } catch {
    turns = [];
  }
  const last3 = turns.length >= 3 ? turns.slice(-3) : turns;
  const blockerSet = new Set<string>();
  for (const t of last3) {
    const bs = t["blockers"];
    if (!Array.isArray(bs)) continue;
    for (const b of bs) {
      if (typeof b === "string" && b.trim()) blockerSet.add(b.trim());
    }
  }
  const blockersState = [...blockerSet].sort();
  const state = {
    leader: leaderVal,
    status: statusVal,
    workers: workersVal,
    blockers: blockersState,
  };
  const mismatches: Record<string, unknown>[] = [];
  if ("leader" in claims) {
    if (claims["leader"] !== leaderVal) {
      mismatches.push({ field: "leader", claim: claims["leader"], state: leaderVal });
    }
  }
  if ("status" in claims) {
    const stateNorm = String(statusVal).toLowerCase();
    const claimNorm = String(claims["status"]).toLowerCase();
    if (stateNorm === "active" && ["active", "running", "idle"].includes(claimNorm)) {
      // consistent
    } else if (claimNorm !== stateNorm) {
      mismatches.push({ field: "status", claim: claims["status"], state: statusVal });
    }
  }
  if ("workers" in claims) {
    if (claims["workers"] !== workersVal) {
      mismatches.push({ field: "workers", claim: claims["workers"], state: workersVal });
    }
  }
  const claimBlockers = (claims["blockers"] as string[]) ?? [];
  const normBlockers = (lst: unknown[]): Set<string> => {
    const out = new Set<string>();
    for (const b of lst) {
      if (typeof b !== "string") continue;
      const s = b.trim();
      if (!s || s.toLowerCase() === "none") continue;
      out.add(s);
    }
    return out;
  };
  const setClaim = normBlockers(claimBlockers);
  const setState = new Set<string>(blockersState);
  let decisionPrefixes: string[] = [];
  try {
    const decisions = await store.readDecisions(track.project_id);
    for (const d of decisions) {
      if (
        (d["track_id"] === null || d["track_id"] === undefined || d["track_id"] === track.id) &&
        typeof d["decision"] === "string"
      ) {
        decisionPrefixes.push((d["decision"] as string).trim());
      }
    }
  } catch {
    /* ledger read failure must not corrupt the diff verdict */
  }
  const matchesDecision = (claim: string): boolean => {
    const probe = claim.slice(0, 60).toLowerCase();
    return decisionPrefixes.some((dp) => {
      const head = dp.slice(0, 60).toLowerCase();
      return head.startsWith(probe) || probe.startsWith(head);
    });
  };
  const extraClaims = new Set<string>(
    [...setClaim].filter((c) => !setState.has(c) && !matchesDecision(c)),
  );
  const missingState = new Set<string>([...setState].filter((c) => !setClaim.has(c)));
  if (extraClaims.size || missingState.size) {
    mismatches.push({
      field: "blockers",
      claim: [...extraClaims].sort().length ? [...extraClaims].sort() : claimBlockers,
      state: [...missingState].sort().length ? [...missingState].sort() : blockersState,
    });
  }
  return {
    ok: true,
    claims,
    state,
    mismatches,
    verdict: mismatches.length ? "mismatched" : "consistent",
  };
}

// ---------------------------------------------------------------------------
// MCP adapters (server.py _mcp_summary_read / _mcp_summary_write)
// ---------------------------------------------------------------------------

export async function summaryRead(
  store: Store,
  trackId: string,
  action = "spec",
  content = "",
): Promise<Record<string, unknown>> {
  let track: Track;
  try {
    track = await store.getTrack(trackId);
  } catch (exc) {
    if (exc instanceof StateError) {
      return {
        ok: false,
        error: (exc as Error).message,
        hint: "list tracks with track_list or track_status",
      };
    }
    throw exc;
  }
  if (action === "spec") return buildSummarySpecAsync(store, track);
  if (action === "diff") return diffSummaryVsState(store, track, content);
  return {
    ok: false,
    error: `invalid action ${pyRepr(action)}`,
    hint: "must be one of: spec, diff",
  };
}

export async function summaryWrite(
  store: Store,
  trackId: string,
  content: string,
  generatedBy = "",
): Promise<Record<string, unknown>> {
  let track: Track;
  try {
    track = await store.getTrack(trackId);
  } catch (exc) {
    if (exc instanceof StateError) {
      return {
        ok: false,
        error: (exc as Error).message,
        hint: "list tracks with track_list or track_status",
      };
    }
    throw exc;
  }
  return validateAndCommit(store, track, content, generatedBy);
}

export { SECTION_SCHEMA };
