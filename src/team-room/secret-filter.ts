/**
 * Secret filter for team memory writes (schema v8). Memory content is injected
 * into every Turn of every expert that can read it, so a credential written
 * there would leak far wider than the message it came from. The filter runs on
 * create, edit and restore, and rejects instead of redacting: the writer learns
 * which rule fired and rewrites the note.
 *
 * The result names the rule, never the matched text, so a rejection never
 * echoes the secret back into a log or a model transcript.
 */

export interface SecretRule {
  readonly name: string;
  readonly pattern: RegExp;
}

export const SECRET_RULES: readonly SecretRule[] = [
  { name: "openai-style-key", pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "private-key-block", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  {
    name: "assigned-credential",
    pattern: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
];

/**
 * A long unbroken run of base64 or hex. Git SHAs (40 hex), UUIDs and hashes are
 * common in engineering notes, so pure hex needs 64+ characters, and a base64
 * run must mix lower case, upper case and digits across 32+ characters.
 */
function highEntropyRun(text: string): boolean {
  if (/\b[0-9a-f]{64,}\b/i.test(text)) return true;
  for (const match of text.matchAll(/[A-Za-z0-9+/_-]{32,}={0,2}/g)) {
    const run = match[0];
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) && !/^[0-9a-f-]+$/i.test(run)) return true;
  }
  return false;
}

/** The first rule the text trips, or null when it is clean. */
export function detectSecret(text: string): string | null {
  for (const rule of SECRET_RULES) if (rule.pattern.test(text)) return rule.name;
  return highEntropyRun(text) ? "high-entropy-string" : null;
}
