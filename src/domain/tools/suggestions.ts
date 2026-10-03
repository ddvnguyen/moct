/**
 * Suggestion flow — port of tools/suggestions.py (fleet -> leader, d-25).
 */
/* eslint-disable complexity, max-depth -- faithful port of mcp-orchestration:
 * control structure mirrors the Python source arm-for-arm; the parity harness
 * (138 same-input cases over MCP stdio) guards behavior, not style metrics. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { referencesDir } from "../config.js";
import { suggestionDump } from "../dump.js";
import {
  newId,
  pyInt,
  pyRepr,
  pyStr,
  pyTruthy,
  pyTypeName,
  slugify,
  todayUtc,
  utcnowIso,
  type SuggestionRecord,
} from "../models.js";
import { StateError, type Store } from "../../store/store-interface.js";
import { decisionRecord } from "./reporting.js";
import { lessonAdd } from "./lessons.js";

export const ALLOWED_KINDS = new Set(["lesson", "reference", "process"]);
export const ALLOWED_STATUS = new Set(["pending", "approved", "rejected"]);

function referencesDirectory(): string {
  return referencesDir();
}

function todayStr(): string {
  return todayUtc();
}

function validateTags(tags: unknown): [string[] | null, Record<string, unknown> | null] {
  if (tags === null || tags === undefined) return [[], null];
  if (!Array.isArray(tags)) {
    return [null, { ok: false, error: "tags must be a list", hint: "provide list of tags" }];
  }
  const cleaned: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") {
      return [
        null,
        { ok: false, error: `tag ${pyRepr(t)} must be string`, hint: "tags are strings" },
      ];
    }
    const s = t.trim();
    if (!s) continue;
    cleaned.push(s);
  }
  return [cleaned, null];
}

async function getTrackOrError(
  store: Store,
  trackId: string,
): Promise<[Awaited<ReturnType<Store["getTrack"]>> | null, Record<string, unknown> | null]> {
  try {
    const track = await store.getTrack(String(trackId).trim());
    return [track, null];
  } catch (exc) {
    return [
      null,
      {
        ok: false,
        error: (exc as Error).message,
        hint: "track not found; verify track_id via track_list",
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// suggestion_add
// ---------------------------------------------------------------------------

export async function suggestionAdd(
  store: Store,
  trackId: string,
  agentId: string,
  kind: string,
  title: string,
  body: string,
  tags: unknown = null,
): Promise<Record<string, unknown>> {
  try {
    if (!trackId || !String(trackId).trim()) {
      return {
        ok: false,
        error: "track_id must be non-empty",
        hint: "provide track_id from track_create",
      };
    }
    if (!agentId || !String(agentId).trim()) {
      return { ok: false, error: "agent_id must be non-empty", hint: "provide proposer agent_id" };
    }
    if (!kind || !ALLOWED_KINDS.has(String(kind).trim().toLowerCase())) {
      return {
        ok: false,
        error: `kind must be one of ${pyRepr([...ALLOWED_KINDS].sort())}`,
        hint: "kind in lesson|reference|process",
      };
    }
    const kindNorm = String(kind).trim().toLowerCase();
    if (!title || !String(title).trim()) {
      return { ok: false, error: "title must be non-empty", hint: "provide suggestion title" };
    }
    if (body === null || body === undefined || !String(body).trim()) {
      return { ok: false, error: "body must be non-empty", hint: "provide markdown body" };
    }
    const [tagsCleaned0, err] = validateTags(tags);
    if (err !== null) return err;
    const tagsCleaned = tagsCleaned0 || [];
    const [track, terr] = await getTrackOrError(store, trackId);
    if (terr !== null) return terr;
    if (!track) throw new Error("track resolution produced no object");
    let slug: string;
    try {
      slug = slugify(String(title).trim());
    } catch (exc) {
      return {
        ok: false,
        error: (exc as Error).message,
        hint: "title must slugify to [a-z0-9._-]",
      };
    }
    const record: SuggestionRecord = {
      id: newId("sugg"),
      track_id: track.id,
      project_id: track.project_id,
      agent_id: String(agentId).trim(),
      kind: kindNorm,
      title: String(title).trim(),
      body: String(body).trim(),
      tags: tagsCleaned,
      status: "pending",
      slug,
      created_at: utcnowIso(),
      reviewed_at: null,
      reviewer: null,
      note: "",
      result: {},
    };
    await store.lock(`suggestions-${track.project_id}`, async () => {
      const suggestions = await store.readSuggestions(track.project_id);
      suggestions.push(suggestionDump(record));
      await store.writeSuggestions(track.project_id, suggestions);
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "suggestion_added",
          track_id: track.id,
          project_id: track.project_id,
          payload: {
            suggestion_id: record.id,
            kind: kindNorm,
            title: record.title,
            slug,
            agent_id: record.agent_id,
            tags: tagsCleaned,
          },
        },
        track.project_id,
      );
    });
    return {
      ok: true,
      suggestion: suggestionDump(record),
      suggestion_id: record.id,
      slug,
      hint: "suggestion stored pending; leader reviews via suggestion_review",
    };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in suggestion_add: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

// ---------------------------------------------------------------------------
// suggestion_review (LEADER-ONLY)
// ---------------------------------------------------------------------------

export async function suggestionReview(
  store: Store,
  trackId: string,
  suggestionId: string,
  approve: unknown,
  reviewer: string,
  note: unknown = "",
): Promise<Record<string, unknown>> {
  try {
    if (!trackId || !String(trackId).trim()) {
      return { ok: false, error: "track_id must be non-empty" };
    }
    if (!suggestionId || !String(suggestionId).trim()) {
      return {
        ok: false,
        error: "suggestion_id must be non-empty",
        hint: "provide id from suggestion_add",
      };
    }
    if (typeof approve !== "boolean") {
      return { ok: false, error: "approve must be bool", hint: "true=approve, false=reject" };
    }
    if (!reviewer || !String(reviewer).trim()) {
      return { ok: false, error: "reviewer must be non-empty", hint: "leader agent_id required" };
    }
    const reviewerNorm = String(reviewer).trim();
    const noteStr = pyStr(pyTruthy(note) ? note : "");
    const [track, terr] = await getTrackOrError(store, trackId);
    if (terr !== null) return terr;
    if (!track) throw new Error("track resolution produced no object");
    const fullTrack = track;
    if (fullTrack.leader === null) {
      return {
        ok: false,
        error: "track has no leader",
        hint: "register leader first via leader_register",
      };
    }
    if (reviewerNorm !== fullTrack.leader.agent_id) {
      return {
        ok: false,
        error: `only leader can review suggestions (leader=${fullTrack.leader.agent_id}, reviewer=${reviewerNorm})`,
        hint: "call as the track leader agent",
      };
    }
    const cleanSuggestionId = String(suggestionId).trim();
    return await store.lock(`suggestions-${fullTrack.project_id}`, async () => {
      const suggestions = await store.readSuggestions(fullTrack.project_id);
      const idx = suggestions.findIndex((s) => s["id"] === cleanSuggestionId);
      if (idx === -1) {
        return {
          ok: false,
          error: `suggestion not found: ${cleanSuggestionId}`,
          hint: "use suggestion_list to find ids",
        };
      }
      const rec = suggestions[idx];
      if (rec["track_id"] !== fullTrack.id) {
        return {
          ok: false,
          error: `suggestion ${cleanSuggestionId} belongs to track ${rec["track_id"]}, not ${fullTrack.id}`,
          hint: "verify track_id",
        };
      }
      if (rec["status"] !== "pending") {
        return {
          ok: false,
          error: `suggestion already reviewed: status=${rec["status"]}`,
          hint: "pending suggestions only",
        };
      }
      if (!approve) {
        rec["status"] = "rejected";
        rec["reviewed_at"] = utcnowIso();
        rec["reviewer"] = reviewerNorm;
        rec["note"] = noteStr;
        rec["result"] = { action: "rejected" };
        suggestions[idx] = rec;
        await store.writeSuggestions(fullTrack.project_id, suggestions);
        await store.appendEvent(
          {
            ts: utcnowIso(),
            type: "suggestion_reviewed",
            track_id: fullTrack.id,
            project_id: fullTrack.project_id,
            payload: {
              suggestion_id: cleanSuggestionId,
              kind: rec["kind"],
              status: "rejected",
              reviewer: reviewerNorm,
              note: noteStr,
            },
          },
          fullTrack.project_id,
        );
        return { ok: true, suggestion: rec, status: "rejected", hint: "suggestion rejected" };
      }
      const kindVal = rec["kind"];
      const title = "title" in rec ? rec["title"] : "";
      const bodyText = "body" in rec ? rec["body"] : "";
      const tagsVal = "tags" in rec ? rec["tags"] : [];
      let result: Record<string, unknown> = {};
      if (kindVal === "lesson") {
        const lessonRes = await lessonAdd(
          store,
          fullTrack.id,
          title as string,
          bodyText as string,
          tagsVal as string[],
        );
        if (!lessonRes["ok"]) {
          return {
            ok: false,
            error: `lesson_add failed: ${lessonRes["error"]}`,
            hint: (lessonRes["hint"] as string) ?? "",
            lesson_result: lessonRes,
          };
        }
        result = {
          action: "lesson_added",
          slug: lessonRes["slug"],
          path: lessonRes["path"],
          lesson_result: lessonRes,
        };
      } else if (kindVal === "reference") {
        try {
          const refDir = referencesDirectory();
          mkdirSync(refDir, { recursive: true });
          let newSlug: string;
          try {
            newSlug = slugify(String(title).trim());
          } catch (exc) {
            return { ok: false, error: (exc as Error).message, hint: "title must slugify" };
          }
          const dest = path.join(refDir, `${newSlug}.md`);
          const date = todayStr();
          const frontmatter =
            "---\n" +
            "type: Reference\n" +
            `title: ${title}\n` +
            `slug: ${newSlug}\n` +
            "generated:\n" +
            `  by: ${reviewerNorm}\n` +
            `  at: ${date}\n` +
            `  track: ${fullTrack.id}\n` +
            `  suggestion: ${cleanSuggestionId}\n` +
            `last_modified: ${date}\n` +
            "---\n";
          if (typeof bodyText !== "string") {
            throw new Error(`'${pyTypeName(bodyText)}' object has no attribute 'strip'`);
          }
          if (existsSync(dest)) {
            let existing = readFileSync(dest, "utf-8");
            if (!existing.endsWith("\n")) existing += "\n";
            const appended = existing + "\n---\n\n" + bodyText.trim() + "\n";
            const tmp = `${dest}.tmp.${process.pid}`;
            writeFileSync(tmp, appended, "utf-8");
            renameSync(tmp, dest);
            result = { action: "reference_appended", slug: newSlug, path: dest };
          } else {
            const content = frontmatter + "\n" + bodyText.trim() + "\n";
            const tmp = `${dest}.tmp.${process.pid}`;
            writeFileSync(tmp, content, "utf-8");
            renameSync(tmp, dest);
            result = { action: "reference_written", slug: newSlug, path: dest };
          }
        } catch (exc) {
          return {
            ok: false,
            error: `failed to write reference: ${(exc as Error).message}`,
            hint: "check references directory permissions",
          };
        }
      } else if (kindVal === "process") {
        const decRes = await decisionRecord(
          store,
          fullTrack.id,
          String(title).trim(),
          String(bodyText).trim(),
          "leader",
          false,
          reviewerNorm,
        );
        if (!decRes["ok"]) {
          return {
            ok: false,
            error: `decision_record failed: ${decRes["error"]}`,
            hint: (decRes["hint"] as string) ?? "",
            decision_result: decRes,
          };
        }
        result = {
          action: "decision_recorded",
          decision_id: decRes["decision_id"],
          decision_result: decRes,
        };
      } else {
        return { ok: false, error: `unknown kind ${pyRepr(kindVal)}` };
      }
      rec["status"] = "approved";
      rec["reviewed_at"] = utcnowIso();
      rec["reviewer"] = reviewerNorm;
      rec["note"] = noteStr;
      rec["result"] = result;
      suggestions[idx] = rec;
      await store.writeSuggestions(fullTrack.project_id, suggestions);
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "suggestion_reviewed",
          track_id: fullTrack.id,
          project_id: fullTrack.project_id,
          payload: {
            suggestion_id: cleanSuggestionId,
            kind: kindVal,
            status: "approved",
            reviewer: reviewerNorm,
            note: noteStr,
            result,
          },
        },
        fullTrack.project_id,
      );
      return {
        ok: true,
        suggestion: rec,
        status: "approved",
        result,
        hint: `suggestion approved: ${result["action"]}`,
      };
    });
  } catch (exc) {
    if (exc instanceof StateError) return { ok: false, error: (exc as Error).message };
    return {
      ok: false,
      error: `unexpected error in suggestion_review: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

// ---------------------------------------------------------------------------
// suggestion_list
// ---------------------------------------------------------------------------

export async function suggestionList(
  store: Store,
  trackId: unknown = "",
  status: unknown = "",
  kind: unknown = "",
  limit: unknown = 50,
): Promise<Record<string, unknown>> {
  try {
    const cleanTrackId = pyStr(pyTruthy(trackId) ? trackId : "").trim();
    const cleanStatus = pyStr(pyTruthy(status) ? status : "")
      .trim()
      .toLowerCase();
    const cleanKind = pyStr(pyTruthy(kind) ? kind : "")
      .trim()
      .toLowerCase();
    if (cleanStatus && !ALLOWED_STATUS.has(cleanStatus)) {
      return {
        ok: false,
        error: `invalid status ${pyRepr(cleanStatus)}`,
        hint: `allowed: ${pyRepr([...ALLOWED_STATUS].sort())}`,
      };
    }
    if (cleanKind && !ALLOWED_KINDS.has(cleanKind)) {
      return {
        ok: false,
        error: `invalid kind ${pyRepr(cleanKind)}`,
        hint: `allowed: ${pyRepr([...ALLOWED_KINDS].sort())}`,
      };
    }
    let lim: number;
    try {
      lim = pyInt(limit);
    } catch {
      lim = 50;
    }
    if (lim < 1) lim = 1;
    if (lim > 100) lim = 100;
    let allSuggestions: Record<string, unknown>[] = [];
    if (cleanTrackId) {
      let track;
      try {
        track = await store.getTrack(cleanTrackId);
      } catch (exc) {
        return { ok: false, error: (exc as Error).message, hint: "track not found" };
      }
      const items = await store.readSuggestions(track.project_id);
      allSuggestions = items.filter((s) => s["track_id"] === cleanTrackId);
    } else {
      for (const proj of await store.listProjects()) {
        try {
          const items = await store.readSuggestions(proj.id);
          allSuggestions.push(...items);
        } catch {
          /* skip unreadable projects */
        }
      }
    }
    const total = allSuggestions.length;
    if (cleanStatus) allSuggestions = allSuggestions.filter((s) => s["status"] === cleanStatus);
    if (cleanKind) allSuggestions = allSuggestions.filter((s) => s["kind"] === cleanKind);
    allSuggestions.sort((a, b) => {
      const ka = String(a["created_at"] ?? "");
      const kb = String(b["created_at"] ?? "");
      if (ka !== kb) return ka < kb ? 1 : -1;
      return 0;
    });
    const sliced = allSuggestions.slice(0, lim);
    return {
      ok: true,
      count: sliced.length,
      suggestions: sliced,
      total: !(cleanStatus || cleanKind) ? total : allSuggestions.length,
    };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in suggestion_list: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}
