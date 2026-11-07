#!/usr/bin/env node
// Path filtering and aggregate gates share this fail-closed decision contract.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const filters = JSON.parse(
  readFileSync(new URL("../.github/ci-paths.json", import.meta.url), "utf8"),
);

export function decideScopes(event, filtered) {
  const full = event === "schedule" || event === "workflow_dispatch";
  if (!full && event !== "push" && event !== "pull_request") {
    throw new Error(`Unsupported CI event: ${event}`);
  }
  const outputs = { full: String(full) };
  for (const scope of Object.keys(filters)) {
    if (!full && filtered[scope] !== "true" && filtered[scope] !== "false") {
      throw new Error(`Missing or invalid path-filter result: ${scope}`);
    }
    outputs[scope] = full ? "true" : filtered[scope];
  }
  // A push to main/multica-moct is a merged SHA that M-151 deploys from, and
  // deploy downloads the CI artifacts instead of rebuilding (M-161). Every
  // merge must therefore produce BOTH product artifacts, whatever the paths
  // were — a backend-only merge still publishes web-dist.
  if (event === "push") {
    outputs.frontend = "true";
    outputs.backend = "true";
  }
  // Product builds already install dependencies and run the shared checks.
  // Only allocate a separate runner when quality is the sole frontend work.
  outputs.quality_only = String(outputs.quality === "true" && outputs.frontend === "false");
  return outputs;
}

// Self-hosted runner gate (M-150): fail-closed, and the fork guard is evaluated
// before any repo variable is consulted — vars are readable from fork PRs.
export function decideRunner({ event, headRepo, repository, actor, allowlist, ciRunner, depsChanged, reviewDecision }) {
  if (event !== "pull_request" && event !== "push") {
    return { runner: '["ubuntu-latest"]', self_hosted: "false", unreviewed_deps: "false" };
  }
  // push events only fire in this repository; PRs must come from it too.
  if (event === "pull_request" && headRepo !== repository) {
    return { runner: '["ubuntu-latest"]', self_hosted: "false", unreviewed_deps: "false" };
  }
  let actors = [];
  if (allowlist) {
    try {
      const parsed = JSON.parse(allowlist);
      actors = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      actors = allowlist.split(",").map((name) => name.trim()).filter(Boolean);
    }
  }
  let labels = null;
  if (ciRunner) {
    try {
      const parsed = JSON.parse(ciRunner);
      labels = Array.isArray(parsed) && parsed.length > 0 ? parsed.map(String) : null;
    } catch {
      // Malformed CI_RUNNER fails closed to hosted: a bad runs-on label list
      // would queue jobs on runners that never pick them up.
      labels = null;
    }
  }
  const eligible = labels !== null && actors.includes(actor);
  const runner = eligible ? JSON.stringify(labels) : '["ubuntu-latest"]';
  const unreviewedDeps =
    eligible && event === "pull_request" && depsChanged === "true" && reviewDecision !== "APPROVED";
  return { runner, self_hosted: String(eligible), unreviewed_deps: String(unreviewedDeps) };
}

export function checkGate(needs, jobScopes) {
  if (needs.changes?.result !== "success") {
    throw new Error("Path filtering did not succeed");
  }
  for (const [job, scope] of Object.entries(jobScopes)) {
    const selected = needs.changes.outputs?.[scope];
    if (selected !== "true" && selected !== "false") {
      throw new Error(`Missing or invalid scope: ${scope}`);
    }
    const expected = selected === "true" ? "success" : "skipped";
    if (needs[job]?.result !== expected) {
      throw new Error(`${job}: expected ${expected}, got ${needs[job]?.result ?? "missing"}`);
    }
  }
  // A newly added dependency must have a declared scope before the gate can pass.
  for (const job of Object.keys(needs)) {
    if (job !== "changes" && !Object.hasOwn(jobScopes, job)) {
      throw new Error(`Unchecked dependency: ${job}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    switch (process.argv[2]) {
      case "decide": {
        const outputs = decideScopes(process.env.EVENT_NAME, JSON.parse(process.env.FILTER_RESULTS));
        appendFileSync(process.env.GITHUB_OUTPUT,
          Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
        break;
      }
      case "runner": {
        const result = decideRunner({
          event: process.env.EVENT_NAME,
          headRepo: process.env.HEAD_REPO || "",
          repository: process.env.REPOSITORY || "",
          actor: process.env.ACTOR || "",
          allowlist: process.env.ALLOWLIST,
          ciRunner: process.env.CI_RUNNER,
          depsChanged: process.env.DEPS_CHANGED,
          reviewDecision: process.env.REVIEW_DECISION || "",
        });
        appendFileSync(process.env.GITHUB_OUTPUT,
          Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(""));
        console.error(`runner gate: event=${process.env.EVENT_NAME} actor=${process.env.ACTOR} -> ${result.runner} (self_hosted=${result.self_hosted}, unreviewed_deps=${result.unreviewed_deps})`);
        break;
      }
      case "gate":
        checkGate(JSON.parse(process.env.NEEDS_JSON), JSON.parse(process.env.JOB_SCOPES));
        console.log("All selected CI jobs succeeded; only unselected jobs were skipped.");
        break;
      default:
        throw new Error("Usage: node scripts/ci-scope.mjs decide|runner|gate");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
