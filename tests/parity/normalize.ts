/**
 * Parity normalization (owner decision D5: normalized field equality).
 *
 * Volatile fields are replaced by format-checked tokens, independently per
 * side (each side's appearance order drives its ordinal map, so equal
 * structures tokenize identically):
 *   generated ids   id matching /^(p|t|task|d|sugg|eval)-[0-9a-f]{10}$/ (whole
 *                   string or substring) -> <id:prefix#ordinal>
 *   timestamps      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ whole or
 *                   substring -> <ts>
 *   tmp paths       server tmp-dir prefix -> <tmp>
 * Comparison is exact after normalization EXCEPT *age_s fields, which compare
 * with |a-b| <= 1 (two servers stamp two clocks; a straddling second boundary
 * is a race, not a divergence), and both-null equality.
 */

const ID_RE = /\b(p|t|task|d|sugg|eval)-[0-9a-f]{10}\b/g;
const TS_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g;

export interface NormaOptions {
  tmpPrefixes: string[];
}

export function normalizeSide(value: unknown, opts: NormaOptions): unknown {
  const idOrdinals = new Map<string, number>();
  const idCounters = new Map<string, number>();
  const tokenForId = (id: string): string => {
    const prefix = id.split("-")[0];
    if (!idOrdinals.has(id)) {
      const n = (idCounters.get(prefix) ?? 0) + 1;
      idCounters.set(prefix, n);
      idOrdinals.set(id, n);
    }
    return `<id:${prefix}#${idOrdinals.get(id)}>`;
  };
  const normString = (s: string): string => {
    let out = s;
    out = out.replace(TS_RE, "<ts>");
    out = out.replace(ID_RE, (m) => tokenForId(m));
    for (const p of opts.tmpPrefixes) {
      if (p && out.includes(p)) out = out.split(p).join("<tmp>");
    }
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return normString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => cmpKey(a, b));
      const out: Record<string, unknown> = {};
      for (const [k, val] of entries) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

function cmpKey(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export interface Diff {
  path: string;
  a: unknown;
  b: unknown;
}

export function diffNormalized(a: unknown, b: unknown, path = "$", out: Diff[] = []): Diff[] {
  if (typeof a === "number" && typeof b === "number" && /(^|\.)age_s$|_age_s$/.test(path)) {
    if (Math.abs(a - b) > 1) out.push({ path, a, b });
    return out;
  }
  if (a === null || b === null || typeof a !== typeof b) {
    if (a !== b) out.push({ path, a, b });
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ path, a: `[len ${a.length}]`, b: `[len ${b.length}]` });
      return out;
    }
    a.forEach((x, i) => diffNormalized(x, (b as unknown[])[i], `${path}[${i}]`, out));
    return out;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of [...keys].sort()) {
      if (!(k in ao)) {
        out.push({ path: `${path}.${k}`, a: "<missing>", b: bo[k] });
      } else if (!(k in bo)) {
        out.push({ path: `${path}.${k}`, a: ao[k], b: "<missing>" });
      } else {
        diffNormalized(ao[k], bo[k], `${path}.${k}`, out);
      }
    }
    return out;
  }
  if (a !== b) out.push({ path, a, b });
  return out;
}

export function canonical(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
