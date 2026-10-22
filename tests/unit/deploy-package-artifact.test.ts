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

function run(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [HELPER, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// The device of a path: two paths on the same device can be renamed into
// each other, two paths on different devices cannot (rename(2) fails with
// EXDEV).
//
// A directory that is on a DIFFERENT device than the system temp dir, or
// null when the machine has only one.
//
// On the runner the lane's artifacts dir (/mnt/workspace, xfs) and TMPDIR
// (/tmp, tmpfs) are different devices - that is the configuration that
// killed the first lane deploy of the fix.
function otherDeviceDir(): string | null {
  const candidates = ["/dev/shm", "/run", "/mnt/workspace"];
  const tmpDevice = statSync(tmpdir()).dev;
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      if (statSync(candidate).dev === tmpDevice) continue;
      const probe = mkdtempSync(path.join(candidate, ".pkg-artifact-probe-"));
      rmSync(probe, { recursive: true, force: true });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

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

  // The defect: the helper unpacked the artifact into the SYSTEM TEMP DIR and
  // renamed the result onto the artifact. On the runner the lane's artifacts
  // dir and TMPDIR are different devices, and rename(2) cannot cross devices
  // - so the deploy died with EXDEV before it installed anything.
  //
  // The proof must not depend on the machine having two devices: the helper
  // must not use the system temp dir AT ALL. Pointing TMPDIR at a path that
  // cannot be used makes any use of it fail loudly.
  it("injects the marker without touching the system temp dir", () => {
    const root = work();
    const tarball = packTarball(root, "build one\n");
    const marker = path.join(root, "build-info.json");
    writeFileSync(marker, JSON.stringify({ pluginsSha: "c11c5ccd" }));

    const result = run(["inject", tarball, marker], { TMPDIR: path.join(root, "no-such-tmpdir") });
    expect(result.status).toBe(0);

    const unpacked = extract(tarball, work());
    expect(JSON.parse(readFileSync(path.join(unpacked, "build-info.json"), "utf8")).pluginsSha).toBe("c11c5ccd");
  });

  it("verifies without touching the system temp dir", () => {
    const root = work();
    const tarball = packTarball(root, "build one\n");
    const installed = path.join(root, "installed");
    mkdirSync(path.join(installed, "lib"), { recursive: true });
    writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "fake-plugin", version: "0.0.1" }));
    writeFileSync(path.join(installed, "lib", "ledger.js"), "build one\n");

    const result = run(["verify", tarball, installed], { TMPDIR: path.join(root, "no-such-tmpdir") });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("carries the bytes");
  });

  it("leaves no work directory behind in the artifacts dir", () => {
    const root = work();
    const tarball = packTarball(root, "build one\n");
    const marker = path.join(root, "build-info.json");
    writeFileSync(marker, JSON.stringify({ pluginsSha: "c11c5ccd" }));

    expect(run(["inject", tarball, marker]).status).toBe(0);

    // The work directory is created next to the artifact, so it must be gone
    // afterwards: a stray directory in the lane's artifacts dir would be
    // picked up as an artifact by the next deploy.
    expect(readdirSync(path.dirname(tarball))).toEqual([path.basename(tarball)]);
  });

  // The real thing: an artifact on a device that is NOT the temp dir's
  // device. This is the configuration of the runner, and it is where the
  // first lane deploy of the fix died.
  it("injects the marker into an artifact on another device", () => {
    const elsewhere = otherDeviceDir();
    if (!elsewhere) {
      // One device on this machine: the TMPDIR cases above already prove the
      // helper does not use it, which is the whole of the defect.
      expect(true).toBe(true);
      return;
    }
    const root = mkdtempSync(path.join(elsewhere, ".pkg-artifact-test-"));
    dirs.push(root);
    const tarball = packTarball(root, "build one\n");
    const marker = path.join(root, "build-info.json");
    writeFileSync(marker, JSON.stringify({ pluginsSha: "c11c5ccd" }));

    expect(statSync(path.dirname(tarball)).dev).not.toBe(statSync(tmpdir()).dev);

    const result = run(["inject", tarball, marker]);
    expect(result.status).toBe(0);

    const unpacked = extract(tarball, work());
    expect(JSON.parse(readFileSync(path.join(unpacked, "build-info.json"), "utf8")).pluginsSha).toBe("c11c5ccd");
  });
});
