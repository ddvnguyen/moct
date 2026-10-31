/**
 * The DSH customizations deploy, end to end against a throwaway lane.
 *
 * The defect this covers: the deploy BUILT the new plugin and INSTALLED the
 * old one. The artifact was named by the plugin's version, and the version
 * only moves on a release commit, so two different builds wrote the same
 * `file:` path with different content; pnpm's import of a `file:` tarball is
 * keyed by that path, so it kept the previously imported bytes and the lane
 * served the previous build. The deploy's verify compared versions, so it
 * reported green over a stale install.
 *
 * The deploy must therefore REPLACE the installed package (remove it before
 * the install, so pnpm re-links the bytes of the tarball that was just
 * built), name the artifact after the plugins commit, and prove the install
 * by CONTENT.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "deploy", "dsh-customizations-deploy.sh");

// Two plugins commits: the same version, two different builds.
const SHA_ONE = `aaaaaaa${"1".repeat(33)}`;
const SHA_TWO = `bbbbbbb${"2".repeat(33)}`;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The patch applier of the fake plugins repo: it marks the package. */
const APPLIER = `import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
const dir = process.argv[2];
const marker = path.join(dir, "patch-marker.txt");
if (process.env.FAIL_PATCH) { console.error("the patch failed"); process.exit(1); }
if (process.argv.includes("--verify")) {
  if (!existsSync(marker)) { console.error("the patch is not applied"); process.exit(1); }
  process.exit(0);
}
writeFileSync(marker, "patched\\n");
`;

/** The profile's postinstall: it corrupts the installed package. */
const CORRUPT = `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("node_modules/@ddvnguyen/fake-plugin/lib", { recursive: true });
writeFileSync("node_modules/@ddvnguyen/fake-plugin/lib/ledger.js", "corrupted by the install\\n");
`;

interface Fixture {
  root: string;
  plugins: string;
  lane: string;
  profile: string;
  manifest: string;
}

function fixture(options: { corruptOnInstall?: boolean; noisyBuild?: boolean; patchMaxVersionExclusive?: string } = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "dsh-deploy-"));
  dirs.push(root);

  // The plugins repo: one package, no build script (the deploy packs it as
  // it is) and the patch applier the manifest names.
  const plugins = path.join(root, "plugins");
  mkdirSync(path.join(plugins, "lib"), { recursive: true });
  mkdirSync(path.join(plugins, "scripts"), { recursive: true });
  writeFileSync(
    path.join(plugins, "package.json"),
    JSON.stringify(
      {
        name: "@ddvnguyen/fake-plugin",
        version: "0.0.1",
        files: ["lib/**/*", "scripts/**/*"],
        // A real plugin's build prints progress. stdout of build_and_pack is
        // its RESULT (the package records the install loops parse), so a
        // build that prints on stdout must not corrupt it.
        ...(options.noisyBuild
          ? { scripts: { build: "node -e \"console.log('linked 351 sibling packages into node_modules')\"" } }
          : {}),
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(plugins, "lib", "ledger.js"), "build one\n");
  writeFileSync(path.join(plugins, "scripts", "applier.mjs"), APPLIER);
  if (options.noisyBuild) {
    // prepare_plugins_repo runs this before the build; it prints to stdout too.
    writeFileSync(path.join(plugins, "scripts", "sync-paths.mjs"), "console.log('regenerated 12 tsconfig path facades');\n");
  }
  // The plugins repo compiles against a sibling harness checkout; the deploy
  // refuses to run without it.
  mkdirSync(path.join(root, "deepseek-harness"), { recursive: true });
  // The deploy installs the plugins repo with --frozen-lockfile, so it needs
  // a lockfile that matches its package.json.
  execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: plugins, encoding: "utf8" });

  // The lane: a profile with the pnpm settings it resolves with.
  const lane = path.join(root, "lane");
  const profile = path.join(lane, "data", "home", "profiles", "web");
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    path.join(profile, "package.json"),
    JSON.stringify(
      {
        name: "lane-profile",
        version: "0.0.0",
        private: true,
        dsh: { profile: { bundles: [] } },
        ...(options.corruptOnInstall ? { scripts: { postinstall: "node ./corrupt.js" } } : {}),
      },
      null,
      2,
    ),
  );
  if (options.corruptOnInstall) writeFileSync(path.join(profile, "corrupt.js"), CORRUPT);
  writeFileSync(
    path.join(profile, "pnpm-workspace.yaml"),
    `nodeLinker: hoisted\nstoreDir: ${path.join(root, "store")}\n`,
  );

  // The manifest: the single source of truth of what gets installed.
  const manifest = path.join(root, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        repos: [
          {
            repo: "ddvnguyen/moct-dsh-team-room",
            packages: [{ name: "@ddvnguyen/fake-plugin", dir: "." }],
          },
        ],
        patches: [
          {
            target: "@ddvnguyen/fake-plugin",
            script: "scripts/applier.mjs",
            ...(options.patchMaxVersionExclusive ? { maxVersionExclusive: options.patchMaxVersionExclusive } : {}),
          },
        ],
      },
      null,
      2,
    ),
  );

  return { root, plugins, lane, profile, manifest };
}

function deploy(fx: Fixture, sha: string, extra: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const env = {
    ...process.env,
    LANE: "x",
    PLUGINS_ROOT: fx.plugins,
    DSH_ROOT: fx.lane,
    MANIFEST: fx.manifest,
    PLUGINS_SHA: sha,
    PLUGINS_BRANCH: "master",
    DSH_HARNESS_DIR: "deepseek-harness",
    ...extra,
  };
  const result = spawnSync("bash", [SCRIPT], { env, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function installedLedger(fx: Fixture): string {
  return readFileSync(path.join(fx.profile, "node_modules", "@ddvnguyen", "fake-plugin", "lib", "ledger.js"), "utf8");
}

function artifacts(fx: Fixture): string[] {
  const dir = path.join(fx.lane, "artifacts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".tgz")).sort();
}

describe("the DSH customizations deploy", () => {
  it(
    "installs the build it packed and names the plugins commit it runs",
    () => {
      const fx = fixture();
      const result = deploy(fx, SHA_ONE);
      expect(result.status).toBe(0);

      // The lane carries the build that was just built.
      expect(installedLedger(fx)).toBe("build one\n");

      // The artifact is named after the plugins commit, not after the version
      // alone: a version only moves on a release commit, so two builds would
      // write the same path with different content.
      const packed = artifacts(fx);
      expect(packed).toHaveLength(1);
      expect(packed[0]).toContain("aaaaaaa");
      expect(packed[0]).toContain("0.0.1");

      // The installed package carries the commit it was built from.
      const marker = JSON.parse(
        readFileSync(path.join(fx.profile, "node_modules", "@ddvnguyen", "fake-plugin", "build-info.json"), "utf8"),
      );
      expect(marker.pluginsSha).toBe(SHA_ONE);
      expect(marker.pluginsShortSha).toBe("aaaaaaa");
      expect(marker.artifact).toBe(packed[0]);
      // The deploy names the commit the lane runs (the log goes to stderr:
      // stdout is the script's data channel).
      expect(`${result.stdout}${result.stderr}`).toContain(SHA_ONE);
    },
    180_000,
  );

  it(
    "lands a second build of the SAME version - the defect this card fixes",
    () => {
      const fx = fixture();
      expect(deploy(fx, SHA_ONE).status).toBe(0);
      expect(installedLedger(fx)).toBe("build one\n");

      // The plugins repo moves on, the version does not.
      writeFileSync(path.join(fx.plugins, "lib", "ledger.js"), "build two\n");
      const second = deploy(fx, SHA_TWO);
      expect(second.status).toBe(0);

      // The lane runs the second build. Before the fix the install reused the
      // previously imported bytes and the lane kept serving build one.
      expect(installedLedger(fx)).toBe("build two\n");
      // Two builds, two artifacts: the path moved with the content.
      expect(artifacts(fx)).toHaveLength(2);
      expect(artifacts(fx)[0]).toContain("aaaaaaa");
      expect(artifacts(fx)[1]).toContain("bbbbbbb");
    },
    180_000,
  );

  it(
    "rolls the profile back to the build it ran before when the deploy fails",
    () => {
      const fx = fixture();
      expect(deploy(fx, SHA_ONE).status).toBe(0);
      expect(installedLedger(fx)).toBe("build one\n");

      // The plugins repo moves on and the patch fails: the deploy must put
      // the profile back on the build it ran before.
      writeFileSync(path.join(fx.plugins, "lib", "ledger.js"), "build two\n");
      const failed = deploy(fx, SHA_TWO, { FAIL_PATCH: "1" });
      expect(failed.status).not.toBe(0);
      expect(`${failed.stdout}${failed.stderr}`).toContain("ROLLING BACK");
      expect(installedLedger(fx)).toBe("build one\n");
    },
    180_000,
  );

  it(
    "skips a patch loudly when the installed target is at or above its maxVersionExclusive",
    () => {
      // The applier would fail (FAIL_PATCH), so a green deploy proves it was skipped.
      const skipped = deploy(fixture({ patchMaxVersionExclusive: "0.0.1" }), SHA_ONE, { FAIL_PATCH: "1" });
      expect(skipped.status).toBe(0);
      expect(`${skipped.stdout}${skipped.stderr}`).toContain("SKIPPING the @ddvnguyen/fake-plugin patch");

      // Below the bound the patch still runs, and a failure still rolls back.
      const applied = deploy(fixture({ patchMaxVersionExclusive: "0.0.2" }), SHA_ONE, { FAIL_PATCH: "1" });
      expect(applied.status).not.toBe(0);
      expect(`${applied.stdout}${applied.stderr}`).toContain("ROLLING BACK");
    },
    180_000,
  );

  it(
    "rolls the profile back when the SAME sha is rebuilt and the deploy fails",
    () => {
      const fx = fixture();
      expect(deploy(fx, SHA_ONE).status).toBe(0);
      expect(installedLedger(fx)).toBe("build one\n");

      // The plugins repo moves on but the sha stays: the artifact path does
      // not move, so this build overwrites the tarball the profile runs. The
      // snapshot has to be a copy taken BEFORE the pack - otherwise the
      // rollback restores the new bytes and the "rollback" changes nothing.
      writeFileSync(path.join(fx.plugins, "lib", "ledger.js"), "build two\n");
      const failed = deploy(fx, SHA_ONE, { FAIL_PATCH: "1" });
      expect(failed.status).not.toBe(0);
      expect(`${failed.stdout}${failed.stderr}`).toContain("ROLLING BACK");
      expect(installedLedger(fx)).toBe("build one\n");
    },
    180_000,
  );

  it(
    "survives a build that writes to stdout",
    () => {
      // The first live deploy read "linked 351 sibling packages into
      // node_modules" as a package name and compared an empty tarball path.
      // The build's output belongs on stderr; the result of the pack step is
      // the only thing stdout may carry.
      const fx = fixture({ noisyBuild: true });
      const result = deploy(fx, SHA_ONE);
      expect(result.status).toBe(0);
      expect(installedLedger(fx)).toBe("build one\n");
      expect(artifacts(fx)).toHaveLength(1);
    },
    180_000,
  );

  it(
    "fails the deploy loudly when the installed package does not carry the build",
    () => {
      // The install corrupts the package it just linked: the deploy must
      // notice the CONTENT, not the version.
      const fx = fixture({ corruptOnInstall: true });
      const result = deploy(fx, SHA_ONE);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("lib/ledger.js");
      expect(`${result.stdout}${result.stderr}`).toContain("does not carry the build");
    },
    180_000,
  );
});
