import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkGate, decideRunner, decideScopes, filters } from "./ci-scope.mjs";

// The filters use only literal paths, * and **; Node's matcher exercises those
// against realistic changes, including files removed or renamed by a PR.
function filterFiles(files) {
  return Object.fromEntries(Object.entries(filters).map(([scope, patterns]) => [
    scope, String(files.some((file) => patterns.some((pattern) => matchesGlob(file, pattern)))),
  ]));
}

for (const [name, files, selected] of [
  ["readme only", ["README.md"], []],
  ["docs only", ["apps/docs/content/docs/guide.mdx"], ["quality"]],
  ["web changelog", ["apps/web/features/landing/i18n/en.ts"], ["frontend", "quality"]],
  ["UI Lab", ["apps/ui-lab/src/app.tsx"], ["frontend", "quality"]],
  ["mobile UI", ["apps/mobile/app/index.tsx"], ["quality"]],
  ["migration only", ["server/migrations/999_example.up.sql"], ["backend", "sqlc"]],
  ["agent process code", ["server/pkg/agent/cursor_background.go"], ["backend"]],
  ["daemon dependency", ["server/internal/skill/service.go"], ["backend"]],
  ["native test compilation dependency", ["server/pkg/db/generated/issues.sql.go"], ["backend", "sqlc"]],
  ["Go dependencies", ["server/go.mod", "server/go.sum"], ["backend"]],
  ["Helm only", ["deploy/helm/multica/templates/deployment.yaml"], ["scripts"]],
  ["container entrypoint", ["docker/entrypoint.sh"], ["scripts"]],
  ["selfhost config", [".env.example"], ["scripts"]],
  ["shell installer", ["scripts/install.sh"], ["scripts"]],
  ["PowerShell installer", ["scripts/install.ps1.test.ps1"], []],
  ["cleanup script", ["scripts/drop-database.sh"], ["scripts"]],
  ["check script regression tests", ["scripts/check.test.sh"], ["scripts"]],
  ["performance harness", ["scripts/perf-compare.test.sh"], ["scripts"]],
  ["attachment preview source", ["server/internal/handler/attachment_text_preview.json"], ["backend", "scripts"]],
  ["attachment preview output", ["packages/views/editor/utils/text-preview-whitelist.generated.ts"], ["frontend", "quality", "scripts"]],
  ["reserved slug source", ["server/internal/handler/reserved_slugs.json"], ["backend", "scripts"]],
  ["reserved slug output", ["packages/core/paths/reserved-slugs.ts"], ["frontend", "quality", "scripts"]],
  ["integration key gates", ["server/cmd/server/router.go"], ["backend", "scripts"]],
  ["cross-module runtime contract", ["packages/core/runtimes/cli-version.ts"], ["frontend", "backend", "quality"]],
  ["lockfile", ["pnpm-lock.yaml"], ["frontend", "quality"]],
  ["workspace package patch", ["patches/example.patch"], ["frontend", "quality"]],
  ["mobile package patch", ["apps/mobile/patches/example.patch"], ["quality"]],
  ["radius policy", ["scripts/check-ui-radius-tokens.mjs"], ["quality"]],
  ["shared quality action", [".github/actions/frontend-quality/action.yml"], ["frontend", "quality"]],
  ["new bitmap", ["apps/web/public/hero.png"], ["frontend", "quality"]],
  ["mixed docs and migration", ["apps/docs/content/guide.mdx", "server/migrations/999_example.up.sql"], ["quality", "backend", "sqlc"]],
  ["CI configuration", [".github/ci-paths.json"], Object.keys(filters)],
]) {
  test(`pull requests select only affected scopes: ${name}`, () => {
    const outputs = decideScopes("pull_request", filterFiles(files));
    assert.equal(outputs.full, "false");
    assert.deepEqual(Object.keys(filters).filter((scope) => outputs[scope] === "true").sort(),
      [...selected].sort());
    assert.equal(outputs.quality_only, String(selected.includes("quality") && !selected.includes("frontend")));
  });
}

// M-161: every merge (push) must produce BOTH product artifacts for M-151 to
// download, so push forces the frontend and backend lanes regardless of paths.
test("pushes force the frontend and backend lanes so merged SHAs carry artifacts", () => {
  for (const files of [[], ["README.md"], ["apps/web/x.ts"], ["server/migrations/x.up.sql"]]) {
    const outputs = decideScopes("push", filterFiles(files));
    assert.equal(outputs.full, "false");
    assert.equal(outputs.frontend, "true", JSON.stringify(files));
    assert.equal(outputs.backend, "true", JSON.stringify(files));
    // frontend is forced, so the quality-only runner never doubles up
    assert.equal(outputs.quality_only, "false", JSON.stringify(files));
    // non-product scopes still follow the paths
    const expectSqlc = files.some((f) => f.startsWith("server/migrations/"));
    assert.equal(outputs.sqlc, String(expectSqlc), JSON.stringify(files));
  }
});

test("manual runs select every scope without a path-filter result", () => {
  const { quality_only, ...scopes } = decideScopes("workflow_dispatch", {});
  assert.ok(Object.values(scopes).every((value) => value === "true"));
  assert.equal(quality_only, "false", "the full frontend build owns quality checks");
  // The schedule trigger left ci.yml in M-161: nightly.yml has no path filter
  // and never calls decide, so an accidental schedule event must fail closed.
  assert.throws(() => decideScopes("schedule", filterFiles(["README.md"])), /Unsupported/);
});

test("missing, malformed and unsupported filter results fail closed", () => {
  for (const value of [undefined, "", "unknown", true]) {
    assert.throws(() => decideScopes("push", { ...filterFiles([]), backend: value }), /backend/);
  }
  assert.throws(() => decideScopes("unknown", filterFiles([])), /Unsupported/);
});

// Read the production wiring without installing workspace dependencies in the
// lightweight changes job. These fields deliberately use single-line syntax;
// unsupported formatting fails the assertions instead of being silently ignored.
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const jobSource = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
const headings = [...jobSource.matchAll(/^  ([\w-]+):$/gm)];
const jobs = Object.fromEntries(headings.map((match, index) => [
  match[1], jobSource.slice(match.index, headings[index + 1]?.index),
]));
function field(source, pattern) {
  const match = source.match(pattern);
  assert.ok(match, `Missing production field: ${pattern}`);
  return match[1];
}
function productionMapping(gate) {
  return JSON.parse(field(jobs[gate], /^          JOB_SCOPES: '(.+)'$/m));
}
function productionNeeds(gate, outputs) {
  const dependencies = field(jobs[gate], /^    needs: \[(.+)\]$/m).split(", ");
  return Object.fromEntries(dependencies.map((job) => {
    if (job === "changes") return [job, { result: "success", outputs }];
    const scope = field(jobs[job], /^    if: \$\{\{ needs\.changes\.outputs\.(\w+) == 'true' \}\}$/m);
    return [job, { result: outputs[scope] === "true" ? "success" : "skipped" }];
  }));
}

for (const gate of ["frontend", "backend"]) {
  test(`production ${gate} gate matches every dependency, condition and scope output`, () => {
    const mapping = productionMapping(gate);
    assert.match(jobs[gate], /^    if: \$\{\{ !cancelled\(\) \}\}$/m);
    assert.match(jobs[gate], /^          NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}$/m);
    assert.match(jobs[gate], /^        run: node scripts\/ci-scope\.mjs gate$/m);
    for (const scope of Object.values(mapping)) {
      assert.ok(jobs.changes.includes(`      ${scope}: \${{ steps.decide.outputs.${scope} }}`));
    }
    const scopes = Object.keys(filters);
    // Exercise mixed scopes too: installers and quality may run without the
    // corresponding product backend/frontend suite being selected.
    for (let mask = 0; mask < 2 ** scopes.length; mask++) {
      const filtered = Object.fromEntries(scopes.map((scope, bit) => [scope, String(Boolean(mask & (1 << bit)))]));
      const outputs = decideScopes("pull_request", filtered);
      checkGate(productionNeeds(gate, outputs), mapping);
    }
    checkGate(productionNeeds(gate, decideScopes("workflow_dispatch", {})), mapping);
  });

  test(`production ${gate} gate rejects unsuccessful or missing selected jobs`, () => {
    const mapping = productionMapping(gate);
    for (const job of Object.keys(mapping)) {
      // A docs-only run selects the standalone quality runner; a full
      // dispatch selects every other dependency in this workflow.
      const outputs = job === "frontend-quality"
        ? decideScopes("pull_request", filterFiles(["apps/docs/content/guide.mdx"]))
        : decideScopes("workflow_dispatch", {});
      for (const result of ["failure", "cancelled", "skipped", undefined]) {
        const input = productionNeeds(gate, outputs);
        assert.equal(input[job].result, "success");
        input[job].result = result;
        assert.throws(() => checkGate(input, mapping), new RegExp(job));
      }
      const missing = productionNeeds(gate, outputs);
      delete missing[job];
      assert.throws(() => checkGate(missing, mapping), new RegExp(job));
    }
  });

  test(`production ${gate} gate rejects invalid filtering and unchecked dependencies`, () => {
    const mapping = productionMapping(gate);
    const unselected = () => productionNeeds(gate, decideScopes("pull_request", filterFiles([])));
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      const input = unselected();
      input.changes.result = result;
      assert.throws(() => checkGate(input, mapping), /Path filtering/);
    }
    for (const [job, scope] of Object.entries(mapping)) {
      const failed = unselected();
      failed[job].result = "failure";
      assert.throws(() => checkGate(failed, mapping), new RegExp(job));
      for (const value of [undefined, "", "unknown"]) {
        const invalid = unselected();
        invalid.changes.outputs[scope] = value;
        assert.throws(() => checkGate(invalid, mapping), /scope/);
      }
    }
    const extra = unselected();
    extra.extra = { result: "failure" };
    assert.throws(() => checkGate(extra, mapping), /Unchecked dependency/);
  });
}

// M-161: the platform jobs, the vulnerability scan and -race moved to
// nightly.yml, and ci.yml lost its schedule trigger. Pin that split: the
// nightly run must carry them, and the PR path must not.
test("nightly.yml carries the jobs ci.yml dropped, and ci.yml no longer schedules", () => {
  const nightly = readFileSync(new URL("../.github/workflows/nightly.yml", import.meta.url), "utf8");
  assert.match(nightly, /^  schedule:$/m);
  assert.match(nightly, /- cron: "23 3 \* \* \*"/);
  const nightlyJobs = Object.fromEntries(
    [...nightly.matchAll(/^  ([\w-]+):$/gm)].map((m) => [m[1], true]),
  );
  for (const job of ["backend-race", "go-vulnerability-scan", "windows-execenv", "macos-runtime", "installer"]) {
    assert.ok(nightlyJobs[job], `nightly.yml missing ${job}`);
  }
  // Moved jobs must be gone from the PR path, and so must its schedule.
  assert.doesNotMatch(workflow, /^  schedule:$/m);
  for (const job of ["backend-race", "go-vulnerability-scan", "windows-execenv", "macos-runtime", "installer", "image-budget"]) {
    assert.ok(!jobs[job], `ci.yml still defines ${job}`);
    assert.doesNotMatch(workflow, new RegExp(`^    needs: \[[^\]]*${job}[^\]]*\]$`, "m"), `a gate still waits on ${job}`);
  }
  // The three-platform matrix keeps running, just nightly.
  assert.match(nightly, /        os: \[ubuntu-latest, macos-latest, windows-latest\]$/m);
  assert.doesNotMatch(nightly, /continue-on-error:/);
  // Nightly jobs stay hosted: schedule/dispatch never selects the mmx pool.
  assert.doesNotMatch(nightly, /fromJSON\(.*runner.*\)/);
});

test("quality checks have exactly one runner and reuse the product build install", () => {
  const invocation = "uses: ./.github/actions/frontend-quality";
  const owners = Object.entries(jobs).filter(([, source]) => source.includes(invocation)).map(([job]) => job);
  // M-161: the composite moved from frontend-build to frontend-lint, which
  // already installs the workspace the action reuses.
  assert.deepEqual(owners.sort(), ["frontend-lint", "frontend-quality"]);
  assert.equal(productionMapping("frontend")["frontend-quality"], "quality_only");
  assert.match(jobs["frontend-lint"], /      - name: Check frontend quality\n        uses: \.\/\.github\/actions\/frontend-quality\n/);
  for (const frontend of ["true", "false"]) {
    for (const quality of ["true", "false"]) {
      const outputs = decideScopes("pull_request", { ...filterFiles([]), frontend, quality });
      const results = productionNeeds("frontend", outputs);
      const runners = owners.filter((job) => results[job].result === "success");
      assert.equal(runners.length, frontend === "true" || quality === "true" ? 1 : 0);
    }
  }
  const action = readFileSync(new URL("../.github/actions/frontend-quality/action.yml", import.meta.url), "utf8");
  assert.match(action, /run: pnpm knip/);
  assert.match(action, /continue-on-error: true/);
  assert.doesNotMatch(action, /pnpm install/);
});

test("the CLI writes real Actions outputs and exits nonzero on a failed gate", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "output");
  const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "decide"], {
    env: { ...process.env, EVENT_NAME: "pull_request", FILTER_RESULTS: JSON.stringify(filterFiles(["README.md"])), GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(output, "utf8"), /^backend=false$/m);
  assert.match(readFileSync(output, "utf8"), /^frontend=false$/m);
  const failed = productionNeeds("backend", decideScopes("workflow_dispatch", {}));
  failed["backend-build"].result = "failure";
  const gate = spawnSync(process.execPath, [script, "gate"], {
    env: { ...process.env, NEEDS_JSON: JSON.stringify(failed), JOB_SCOPES: JSON.stringify(productionMapping("backend")) },
    encoding: "utf8",
  });
  assert.equal(gate.status, 1);
  assert.match(gate.stderr, /backend-build/);
});

// --- Self-hosted runner gate (M-150) ---

const runnerBase = {
  event: "pull_request",
  headRepo: "ddvnguyen/multica-x",
  repository: "ddvnguyen/multica-x",
  actor: "ddvnguyen",
  allowlist: '["ddvnguyen","claude"]',
  ciRunner: '["self-hosted","linux","mmx"]',
  depsChanged: "false",
  reviewDecision: "",
};

test("runner gate: fork PRs are hosted even with a valid CI_RUNNER and allow-listed actor", () => {
  const result = decideRunner({ ...runnerBase, headRepo: "someone-else/multica-x" });
  assert.equal(result.runner, '["ubuntu-latest"]');
  assert.equal(result.self_hosted, "false");
  // Fork guard runs before vars are consulted: no scratch caches either.
  assert.equal(result.unreviewed_deps, "false");
});

test("runner gate: same-repo PR by allow-listed actor runs on mmx labels", () => {
  const result = decideRunner(runnerBase);
  assert.equal(result.runner, '["self-hosted","linux","mmx"]');
  assert.equal(result.self_hosted, "true");
});

test("runner gate: non-allow-listed actor, empty allowlist or empty CI_RUNNER stay hosted", () => {
  for (const over of [
    { actor: "random-octocat" },
    { allowlist: "" },
    { allowlist: "[]" },
    { ciRunner: "" },
    { ciRunner: "not json [" },
    { ciRunner: "[]" },
  ]) {
    const result = decideRunner({ ...runnerBase, ...over });
    assert.equal(result.runner, '["ubuntu-latest"]', JSON.stringify(over));
    assert.equal(result.self_hosted, "false", JSON.stringify(over));
  }
});

test("runner gate: schedule and dispatch events never leave hosted", () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const result = decideRunner({ ...runnerBase, event });
    assert.equal(result.runner, '["ubuntu-latest"]');
    assert.equal(result.self_hosted, "false");
  }
});

test("runner gate: push events are gated on allow-listed actors only", () => {
  const push = { ...runnerBase, event: "push", headRepo: "" };
  assert.equal(decideRunner(push).self_hosted, "true");
  assert.equal(decideRunner({ ...push, actor: "random-octocat" }).self_hosted, "false");
});

test("runner gate: unreviewed dependency changes isolate caches until approval", () => {
  const deps = { ...runnerBase, depsChanged: "true" };
  assert.equal(decideRunner(deps).unreviewed_deps, "true");
  assert.equal(decideRunner({ ...deps, reviewDecision: "APPROVED" }).unreviewed_deps, "false");
  assert.equal(decideRunner({ ...deps, reviewDecision: "CHANGES_REQUESTED" }).unreviewed_deps, "true");
  assert.equal(decideRunner({ ...runnerBase, depsChanged: "false" }).unreviewed_deps, "false");
  // After merge (push event) the shared caches re-warm; isolation never applies.
  assert.equal(decideRunner({ ...deps, event: "push", headRepo: "" }).unreviewed_deps, "false");
  // Hosted runs have no shared caches to poison.
  assert.equal(decideRunner({ ...deps, actor: "random-octocat" }).unreviewed_deps, "false");
});

test("the CLI writes runner outputs for runs-on: fromJSON(...)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "output");
  const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "runner"], {
    env: {
      ...process.env,
      EVENT_NAME: "pull_request",
      HEAD_REPO: "ddvnguyen/multica-x",
      REPOSITORY: "ddvnguyen/multica-x",
      ACTOR: "ddvnguyen",
      ALLOWLIST: '["ddvnguyen"]',
      CI_RUNNER: '["self-hosted","linux","mmx"]',
      DEPS_CHANGED: "true",
      REVIEW_DECISION: "",
      GITHUB_OUTPUT: output,
    },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const written = readFileSync(output, "utf8");
  assert.match(written, /^runner=\["self-hosted","linux","mmx"\]$/m);
  assert.match(written, /^self_hosted=true$/m);
  assert.match(written, /^unreviewed_deps=true$/m);
});

test("production runner wiring: changes decides, heavy frontend jobs consume, every job has a timeout", () => {
  // The changes job is the single source of truth for the runner decision.
  assert.match(jobs.changes, /^        id: runner$/m);
  assert.match(jobs.changes, /^      runner: \$\{\{ steps\.runner\.outputs\.runner \}\}$/m);
  assert.match(jobs.changes, /^      self_hosted: \$\{\{ steps\.runner\.outputs\.self_hosted \}\}$/m);
  assert.match(jobs.changes, /^      unreviewed_deps: \$\{\{ steps\.runner\.outputs\.unreviewed_deps \}\}$/m);
  assert.match(jobs.changes, /^    runs-on: ubuntu-latest$/m);
  // The gate itself never runs on self-hosted: forks reach it.
  assert.match(jobs.changes, /Reject pull_request_target.*workflow_run|pull_request_target.*workflow_run.*must not/m);

  // Every frontend turbo job moves to self-hosted (M-161 split: typecheck,
  // lint and build each got their own runner). The frontend and backend
  // aggregates must stay hosted so the required check name always reports
  // even if the self-hosted pool drains.
  const switched = ["frontend-typecheck", "frontend-lint", "frontend-build",
    "frontend-test", "frontend-views-test", "frontend-quality"];
  for (const job of switched) {
    assert.match(jobs[job], /^    runs-on: \$\{\{ fromJSON\(needs\.changes\.outputs\.runner\) \}\}$/m, job);
    assert.match(jobs[job], /^    timeout-minutes: \d+$/m, job);
  }
  // Gate aggregates and the light jobs stay hosted and must not consume the runner output.
  for (const job of ["frontend", "backend", "script-checks", "sqlc-check"]) {
    assert.doesNotMatch(jobs[job], /fromJSON\(needs\.changes\.outputs\.runner\)/, job);
    assert.match(jobs[job], /^    runs-on: ubuntu-latest$/m, job);
    assert.match(jobs[job], /^    timeout-minutes: \d+$/m, job);
  }
  // Backend shards stay hosted (Postgres services + the M-150 firewall rule).
  for (const job of ["backend-build", "backend-test-db", "backend-test-pkg", "backend-agent-tests"]) {
    assert.doesNotMatch(jobs[job], /fromJSON\(needs\.changes\.outputs\.runner\)/, job);
    assert.match(jobs[job], /^    runs-on: ubuntu-latest$/m, job);
    assert.match(jobs[job], /^    timeout-minutes: \d+$/m, job);
  }
  // The firewall proof runs on the self-hosted path only.
  assert.match(jobs["mmx-firewall"], /^    if: \$\{\{ needs\.changes\.outputs\.self_hosted == 'true' \}\}$/m);
  assert.match(jobs["mmx-firewall"], /curl --max-time 3 "http:\/\/127\.0\.0\.1:\$\{CANARY_PORT:-39180\}\/"/);
  assert.match(jobs["mmx-firewall"], /curl --max-time 3 "http:\/\/\$\{gw\}:\$\{CANARY_PORT:-39180\}\/"/);
  assert.match(jobs["mmx-firewall"], /rc" -ne 28/);
});
