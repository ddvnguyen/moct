/**
 * The artifact helper of the DSH customizations deploy: the build marker and
 * the CONTENT comparison.
 *
 * Why: the deploy used to prove a deploy by comparing versions. The version
 * of a plugin only moves on a release commit, so two different builds carry
 * the same version and a stale install was indistinguishable from a good
 * one - the lane served the previous build while every check was green.
 * The proof has to be the bytes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HELPER = fileURLToPath(new URL("../../scripts/deploy/package-artifact.mjs", import.meta.url));

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function work(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pkg-artifact-"));
  dirs.push(dir);
  return dir;
}

/** A package tree packed the way npm pack packs it. */
function packTarball(root: string, ledger: string): string {
  const pkg = path.join(root, "pkg");
  mkdirSync(path.join(pkg, "lib"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "fake-plugin", version: "0.0.1" }));
  writeFileSync(path.join(pkg, "lib", "ledger.js"), ledger);
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  const packed = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", path.join(root, "artifacts")], {
    cwd: pkg,
    encoding: "utf8",
  });
  const name = packed.trim().split("\n").pop()!.trim();
  return path.join(root, "artifacts", name);
}

/** The tree npm pack produced, as it sits inside the tarball. */
function extract(tarball: string, into: string): string {
  execFileSync("tar", ["-xzf", tarball, "-C", into]);
  return path.join(into, "package");
}

function run(args: string[], env: NodeJS.ProcessEnv = process.env): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [HELPER, ...args], { encoding: "utf8", env });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * A directory on a DIFFERENT device from `dir`, or null when this host has
 * only one. A lane has two: the artifacts live on the nvme while TMPDIR is
 * tmpfs. That boundary is where the first live deploy died - `inject` built
 * the tarball in /tmp and could not rename it onto the lane's artifacts dir
 * (EXDEV). A fixture that keeps everything on one device cannot see it.
 */
function otherDeviceThan(dir: string): string | null {
  for (const candidate of ["/dev/shm", tmpdir()]) {
    try {
      if (statSync(candidate).dev !== statSync(dir).dev) return candidate;
    } catch {
      // not present on this host
    }
  }
  return null;
}

const foreignTmp = otherDeviceThan(tmpdir());

describe("package-artifact", () => {
  it("writes the build marker into the artifact", () => {
    const root = work();
    const tarball = packTarball(root, "build one\n");
    const marker = path.join(root, "build-info.json");
    writeFileSync(marker, JSON.stringify({ pluginsSha: "c11c5ccd" }));

    expect(run(["inject", tarball, marker]).status).toBe(0);

    const unpacked = extract(tarball, work());
    const written = JSON.parse(readFileSync(path.join(unpacked, "build-info.json"), "utf8"));
    expect(written.pluginsSha).toBe("c11c5ccd");
    // The rest of the package is untouched by the injection.
    expect(readFileSync(path.join(unpacked, "lib", "ledger.js"), "utf8")).toBe("build one\n");
  });

  it.skipIf(foreignTmp === null)("injects when TMPDIR is on another device than the artifact", () => {
    const root = work();
    const tarball = packTarball(root, "build one\n");
    const marker = path.join(root, "build-info.json");
    writeFileSync(marker, JSON.stringify({ pluginsSha: "c11c5ccd" }));

    // The lane's shape: TMPDIR (tmpfs) and the artifact dir (nvme) are
    // different devices, and a file cannot be renamed across them. The
    // helper's scratch space therefore has to live beside the artifact.
    const env = { ...process.env, TMPDIR: foreignTmp! };
    expect(run(["inject", tarball, marker], env).status).toBe(0);

    const unpacked = extract(tarball, work());
    expect(JSON.parse(readFileSync(path.join(unpacked, "build-info.json"), "utf8")).pluginsSha).toBe("c11c5ccd");
    // The scratch dir does not survive the injection.
    expect(readdirSync(path.dirname(tarball)).filter((name) => name.startsWith(".pkg-artifact-"))).toEqual([]);
    // The content check reads both trees; it is unaffected by the boundary.
    expect(run(["verify", tarball, unpacked], env).status).toBe(0);
  });

  it("accepts an installed tree that carries the artifact's bytes", () => {
    const root = work();
    const tarball = packTarball(root, "build one\n");
    const installed = path.join(root, "installed");
    mkdirSync(path.join(installed, "lib"), { recursive: true });
    writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "fake-plugin", version: "0.0.1" }));
    writeFileSync(path.join(installed, "lib", "ledger.js"), "build one\n");

    const result = run(["verify", tarball, installed]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("carries the bytes");
  });

  it("fails loudly when the installed tree is an older build", () => {
    const root = work();
    const tarball = packTarball(root, "build two\n");
    const installed = path.join(root, "installed");
    mkdirSync(path.join(installed, "lib"), { recursive: true });
    writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "fake-plugin", version: "0.0.1" }));
    writeFileSync(path.join(installed, "lib", "ledger.js"), "build one\n");

    const result = run(["verify", tarball, installed]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lib/ledger.js");
    expect(result.stderr).toContain("does not carry the build");
  });

  it("fails when a file of the artifact is missing from the installed tree", () => {
    const root = work();
    const tarball = packTarball(root, "build one\n");
    const installed = path.join(root, "installed");
    mkdirSync(installed, { recursive: true });
    writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "fake-plugin", version: "0.0.1" }));

    const result = run(["verify", tarball, installed]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MISSING");
  });

  it("fails when the package is not installed at all", () => {
    const root = work();
    const tarball = packTarball(root, "build one\n");
    const result = run(["verify", tarball, path.join(root, "nowhere")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MISSING");
  });

  it("ignores the dependencies pnpm puts under the installed package", () => {
    const root = work();
    const tarball = packTarball(root, "build one\n");
    const installed = path.join(root, "installed");
    mkdirSync(path.join(installed, "lib"), { recursive: true });
    writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "fake-plugin", version: "0.0.1" }));
    writeFileSync(path.join(installed, "lib", "ledger.js"), "build one\n");
    // pnpm links the package's own dependencies under it: they belong to the
    // resolver, not to the artifact.
    mkdirSync(path.join(installed, "node_modules", "some-dep"), { recursive: true });
    writeFileSync(path.join(installed, "node_modules", "some-dep", "index.js"), "not part of the package\n");

    expect(run(["verify", tarball, installed]).status).toBe(0);
  });

  it("prints the marker of an installed package", () => {
    const root = work();
    const installed = path.join(root, "installed");
    mkdirSync(installed, { recursive: true });
    writeFileSync(path.join(installed, "build-info.json"), JSON.stringify({ pluginsSha: "c11c5ccd" }));

    const result = run(["show", installed]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).pluginsSha).toBe("c11c5ccd");
    expect(existsSync(path.join(installed, "build-info.json"))).toBe(true);
  });
});
