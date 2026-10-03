/**
 * Lessons tools — port of tools/lessons.py (OKF v0.2 knowledge lifecycle).
 */
/* eslint-disable complexity, max-depth -- faithful port of mcp-orchestration:
 * control structure mirrors the Python source arm-for-arm; the parity harness
 * (138 same-input cases over MCP stdio) guards behavior, not style metrics. */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { lessonsDir } from "../config.js";
import {
  LESSON_TAGS,
  pyInt,
  pyList,
  pyRepr,
  pyStr,
  pyTruthy,
  slugify,
  todayUtc,
  utcnowIso,
} from "../models.js";
import type { Store } from "../../store/store-interface.js";

export const ALLOWED_TAGS: string[] = [...LESSON_TAGS];
const ALLOWED_TAGS_SET = new Set(ALLOWED_TAGS);

function lessonsDirectory(): string {
  return lessonsDir();
}

function ensureLessonsDir(): string {
  const d = lessonsDirectory();
  mkdirSync(d, { recursive: true });
  return d;
}

function ensureIndexExists(): void {
  const p = path.join(lessonsDirectory(), "index.md");
  if (existsSync(p)) return;
  ensureLessonsDir();
  const lines = [
    "# Lessons index — OKF v0.2 wiki catalog",
    "",
    "Topic-organized catalog of `lessons/*.md`. Categories = the tag allowlist",
    "(build / deploy / workflow / harness / coordination / verification). One row",
    "per lesson: `[[wikilink]] — one-line claim (source)`. Every add / correct /",
    "remove updates this file (split into more topic headers past ~50 rows).",
    "Fast lookup: `rg -il '<kw>' lessons/`, refine `rg -i 'tags:.*<kw>' lessons/`.",
    "",
  ];
  for (const cat of ALLOWED_TAGS) {
    lines.push(`## ${cat}`);
    lines.push("");
  }
  writeFileSync(p, lines.join("\n") + "\n", "utf-8");
}

function ensureLogExists(): void {
  const p = path.join(lessonsDirectory(), "log.md");
  if (existsSync(p)) return;
  ensureLessonsDir();
  const header =
    "# Lessons log — append-only action record\n" +
    "\n" +
    "One line per store action: `YYYY-MM-DD | action (add/correct/remove) |\n" +
    "lesson topic | by`. Never rewrite history here; corrections are new lines\n" +
    "(the lesson file itself carries `last_modified`).\n" +
    "\n" +
    "```\n" +
    "2026-08-27 | seed | store created (OKF v0.2 wiki format) | owner + lead contract v0.0.1\n" +
    "```\n";
  writeFileSync(p, header, "utf-8");
}

function parseFrontmatterTags(fmText: string): string[] {
  const m = /tags:\s*\[(.*?)\]/s.exec(fmText);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((t) => t.trim().replace(/^['"]+|['"]+$/g, ""))
    .filter((t) => t.length > 0);
}

function updateIndex(slug: string, title: string, tags: string[], trackId: string): void {
  ensureIndexExists();
  const p = path.join(lessonsDirectory(), "index.md");
  const text = readFileSync(p, "utf-8");
  const primary = tags.length && ALLOWED_TAGS_SET.has(tags[0]) ? tags[0] : "workflow";
  const header = `## ${primary}`;
  const firstLine = title ? title.split(/\r\n|[\n\r\u2028\u2029]/)[0] : slug;
  const claim = (firstLine ?? slug).slice(0, 80);
  const entry = `- [[${slug}]] — ${claim} (track ${trackId})`;
  if (text.includes(`[[${slug}]]`)) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`[[${slug}]]`)) {
        lines[i] = entry;
        break;
      }
    }
    let newText = lines.join("\n");
    if (!newText.endsWith("\n")) newText += "\n";
    writeFileSync(p, newText, "utf-8");
    return;
  }
  if (text.includes(header)) {
    const lines = text.split("\n");
    const idx = lines.findIndex((l) => l.trim() === header);
    if (idx >= 0) {
      let insertAt = idx + 1;
      if (insertAt < lines.length && lines[insertAt].trim() === "") insertAt += 1;
      lines.splice(insertAt, 0, entry);
      let newText = lines.join("\n");
      if (!newText.endsWith("\n")) newText += "\n";
      writeFileSync(p, newText, "utf-8");
      return;
    }
  }
  let t = text;
  if (!t.endsWith("\n")) t += "\n";
  t = t.replace(/\s+$/, "") + `\n\n${header}\n\n${entry}\n`;
  writeFileSync(p, t, "utf-8");
}

function appendLog(slug: string, by: string, action = "lesson-add"): void {
  ensureLogExists();
  const p = path.join(lessonsDirectory(), "log.md");
  const date = todayUtc();
  const text = readFileSync(p, "utf-8");
  const hasPipeHeader = text.includes("| Date") || text.includes("| 2026");
  const row = hasPipeHeader
    ? `| ${date} | ${action} | ${slug}.md | ${by} |\n`
    : `${date} | ${action} | ${slug}.md | ${by}\n`;
  appendFileSync(p, row, "utf-8");
}

function renderFrontmatter(
  slug: string,
  title: string,
  tags: string[],
  trackId: string,
  by: string,
): string {
  const date = todayUtc();
  const sources = [`track ${trackId} — ${slug} — ${date}`];
  const tagsStr = tags.join(", ");
  let fm =
    "---\n" +
    "type: Lesson\n" +
    `title: ${title}\n` +
    `tags: [${tagsStr}]\n` +
    "verified: machine-confirmed\n" +
    "sources:\n";
  for (const s of sources) fm += `  - "${s}"\n`;
  fm += `generated:\n  by: ${by}\n  at: ${date}\nlast_modified: ${date}\n---\n`;
  return fm;
}

export async function lessonAdd(
  store: Store,
  trackId: string,
  title: string,
  body: string,
  tags: unknown = null,
): Promise<Record<string, unknown>> {
  try {
    const tagList = pyTruthy(tags) ? pyList(tags) : [];
    const normalized = (tagList as unknown[])
      .map((t) => String(t).trim())
      .filter((t) => t.length > 0)
      .map((t) => t.toLowerCase());
    if (!trackId || !String(trackId).trim()) {
      return {
        ok: false,
        error: "track_id must be non-empty",
        hint: "provide track_id from track_create",
      };
    }
    if (!title || !String(title).trim()) {
      return {
        ok: false,
        error: "title must be non-empty",
        hint: "provide a short topic title (slugified to filename)",
      };
    }
    if (body === null || body === undefined || !String(body).trim()) {
      return {
        ok: false,
        error: "body must be non-empty",
        hint: "provide markdown body with evidence and [[wikilinks]]",
      };
    }
    if (!normalized.length) {
      return {
        ok: false,
        error: "tags must be a non-empty list",
        hint: `allowed tags: ${ALLOWED_TAGS.join(", ")}`,
      };
    }
    const invalid = normalized.filter((t) => !ALLOWED_TAGS_SET.has(t));
    if (invalid.length) {
      return {
        ok: false,
        error: `invalid tags ${pyRepr(invalid)}`,
        hint: `allowed tags: ${ALLOWED_TAGS.join(", ")}`,
      };
    }
    let track;
    try {
      track = await store.getTrack(String(trackId).trim());
    } catch (exc) {
      return {
        ok: false,
        error: (exc as Error).message,
        hint: "track not found; verify track_id via track_list",
      };
    }
    const by = track.leader ? track.leader.agent_id : "unknown";
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
    ensureLessonsDir();
    const dir = lessonsDirectory();
    const dest = path.join(dir, `${slug}.md`);
    const isUpdate = existsSync(dest);
    const fm = renderFrontmatter(slug, String(title).trim(), normalized, track.id, by);
    const content = fm + "\n" + String(body).trim() + "\n";
    const tmp = `${dest}.tmp.${process.pid}`;
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, dest);
    try {
      updateIndex(slug, String(title).trim(), normalized, track.id);
    } catch (exc) {
      return {
        ok: false,
        error: `failed to update lessons/index.md: ${(exc as Error).message}`,
        hint: "check lessons directory permissions",
      };
    }
    try {
      appendLog(slug, by, isUpdate ? "lesson-correct" : "lesson-add");
    } catch (exc) {
      return {
        ok: false,
        error: `failed to update lessons/log.md: ${(exc as Error).message}`,
        hint: "check lessons directory permissions",
      };
    }
    try {
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "lesson_added",
          track_id: track.id,
          project_id: track.project_id,
          payload: { slug, title: String(title).trim(), tags: normalized, by, updated: isUpdate },
        },
        track.project_id,
      );
    } catch {
      /* lesson file already written; event failure is non-fatal */
    }
    return {
      ok: true,
      slug,
      path: dest,
      tags: normalized,
      updated: isUpdate,
      hint: `written lessons/${slug}.md; index + log updated; event lesson_added appended`,
    };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in lesson_add: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

export function lessonList(
  store: Store,
  tag: unknown = "",
  search: unknown = "",
  limit: unknown = 50,
): Record<string, unknown> {
  try {
    let lim: number;
    try {
      lim = pyInt(limit);
    } catch {
      lim = 50;
    }
    if (lim < 1) lim = 1;
    if (lim > 100) lim = 100;
    const tagNorm = pyStr(pyTruthy(tag) ? tag : "")
      .trim()
      .toLowerCase();
    void store;
    if (tagNorm && !ALLOWED_TAGS_SET.has(tagNorm)) {
      return {
        ok: false,
        error: `invalid tag ${pyRepr(tagNorm)}`,
        hint: `allowed tags: ${ALLOWED_TAGS.join(", ")}`,
      };
    }
    const searchNorm = pyStr(pyTruthy(search) ? search : "")
      .trim()
      .toLowerCase();
    const dir = lessonsDirectory();
    if (!existsSync(dir)) return { ok: true, count: 0, lessons: [] };
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "index.md" && f !== "log.md")
      .map((f) => path.join(dir, f))
      .sort();
    const lessons: Record<string, unknown>[] = [];
    for (const f of files) {
      let raw: string;
      try {
        raw = readFileSync(f, "utf-8");
      } catch {
        continue;
      }
      let fmTags: string[] = [];
      let fmVerified = "";
      let fmTitle = "";
      let fmGeneratedAt = "";
      let fmLastModified = "";
      if (raw.startsWith("---")) {
        const end = raw.indexOf("\n---", 3);
        if (end !== -1) {
          const fmText = raw.slice(0, end + 4);
          fmTags = parseFrontmatterTags(fmText);
          const mTitle = /^title:\s*(.+)$/m.exec(fmText);
          if (mTitle) fmTitle = mTitle[1].trim();
          const mVerified = /^verified:\s*(.+)$/m.exec(fmText);
          if (mVerified) fmVerified = mVerified[1].trim();
          const mAt = /at:\s*(\d{4}-\d{2}-\d{2})/.exec(fmText);
          if (mAt) fmGeneratedAt = mAt[1];
          const mLm = /^last_modified:\s*(\d{4}-\d{2}-\d{2})/m.exec(fmText);
          if (mLm) fmLastModified = mLm[1].trim();
        }
      }
      const slug = path.basename(f).replace(/\.md$/, "");
      if (tagNorm && !fmTags.map((t) => t.toLowerCase()).includes(tagNorm)) continue;
      if (searchNorm) {
        const hay = `${slug} ${fmTitle} ${raw}`.toLowerCase();
        if (!hay.includes(searchNorm)) continue;
      }
      const title = fmTitle || slug;
      lessons.push({
        slug,
        title,
        tags: fmTags,
        verified: fmVerified,
        generated_at: fmGeneratedAt,
        last_modified: fmLastModified,
        path: f,
      });
    }
    lessons.sort((a, b) => {
      const ka = String(a["last_modified"] ?? "");
      const kb = String(b["last_modified"] ?? "");
      if (ka !== kb) return ka < kb ? 1 : -1;
      const sa = String(a["slug"] ?? "");
      const sb = String(b["slug"] ?? "");
      if (sa !== sb) return sa < sb ? 1 : -1;
      return 0;
    });
    const sliced = lessons.slice(0, lim);
    return { ok: true, count: sliced.length, lessons: sliced, total: lessons.length };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in lesson_list: ${(exc as Error).message}`,
      hint: "check lessons directory",
    };
  }
}
