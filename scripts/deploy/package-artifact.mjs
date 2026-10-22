#!/usr/bin/env node
// The artifact helper of the DSH customizations deploy.
//
//   inject <tarball> <build-info.json>   write the build marker into the tarball
//   verify <tarball> <installed-dir>      compare the installed tree with the artifact
//   show <installed-dir>                  print the build marker of an installed package
//
// Why this exists: the deploy used to prove a deploy by comparing VERSIONS.
// The version of a plugin only moves on a release commit, so two different
// builds carry the same version and a stale install was indistinguishable
// from a good one. The proof has to be the CONTENT: the bytes the lane runs
// must be the bytes the deploy just built.
//
// The marker (build-info.json) is written INTO the artifact, so the installed
// package carries the commit it was built from and the lane can answer
// "which plugins commit am I running?" from a file.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "build-info.json";

function die(message) {
  console.error(`package-artifact: ${message}`);
  process.exit(2);
}

function tar(args) {
  try {
    return execFileSync("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString().trim() : error.message;
    die(`tar ${args.join(" ")} failed: ${detail}`);
  }
}

// The files of a directory, relative to it, sorted. `skip` names the
// directory trees that are not part of the package: pnpm puts a package's
// own dependencies under <installed>/node_modules, and those belong to the
// resolver, not to the artifact.
function filesOf(dir, skip = []) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (prefix === "" && skip.includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.push(rel);
      // Symlinks and other special entries are not part of an npm tarball.
    }
  };
  walk(dir, "");
  return out;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// inject: write the marker into the artifact. The tarball is unpacked, the
// marker is added to its package/ root and the tarball is written back. The
// package/ prefix is what npm pack produces and what pnpm expects from a
// file: tarball, so it is kept exactly.
function inject(tarball, markerFile) {
  if (!fs.existsSync(tarball)) die(`no such tarball: ${tarball}`);
  if (!fs.existsSync(markerFile)) die(`no such build info: ${markerFile}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-artifact-"));
  try {
    tar(["-xzf", tarball, "-C", work]);
    const root = path.join(work, "package");
    if (!fs.existsSync(root)) die(`the tarball has no package/ root: ${tarball}`);
    fs.copyFileSync(markerFile, path.join(root, MARKER));
    // The rewritten tarball is written INSIDE the destination directory and
    // renamed within it. A rename cannot cross a filesystem (EXDEV), and the
    // deploy's artifact directory is often on another one than the temp
    // directory; a rename inside one directory is atomic, so a reader never
    // sees a half-written artifact.
    const out = path.join(path.dirname(tarball), `.${path.basename(tarball)}.tmp-${process.pid}`);
    try {
      tar(["-czf", out, "-C", work, "package"]);
      fs.renameSync(out, tarball);
    } finally {
      fs.rmSync(out, { force: true });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  // The reports go to stderr: the helper is called from inside command
  // substitutions in the deploy, and stdout there is parsed as data.
  console.error(`wrote ${MARKER} into ${path.basename(tarball)}`);
}

// verify: the installed tree must carry the artifact's bytes. The installed
// tree is compared file by file (sha256), the artifact's file set is the
// expected one, and every difference is named.
function verify(tarball, installed) {
  if (!fs.existsSync(tarball)) die(`no such tarball: ${tarball}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-artifact-"));
  const differences = [];
  try {
    tar(["-xzf", tarball, "-C", work]);
    const root = path.join(work, "package");
    if (!fs.existsSync(root)) die(`the tarball has no package/ root: ${tarball}`);
    if (!fs.existsSync(installed)) {
      console.error(`MISSING  ${installed} is not installed`);
      process.exit(1);
    }
    const expected = filesOf(root);
    const actual = filesOf(installed, ["node_modules"]);
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    for (const rel of expected) {
      if (!actualSet.has(rel)) {
        differences.push(`MISSING  ${rel} is in the artifact but not installed`);
        continue;
      }
      const a = sha256(path.join(installed, rel));
      const b = sha256(path.join(root, rel));
      if (a !== b) differences.push(`DIFFERS ${rel} installed=${a.slice(0, 12)} artifact=${b.slice(0, 12)}`);
    }
    for (const rel of actual) {
      if (!expectedSet.has(rel)) differences.push(`EXTRA   ${rel} is installed but not in the artifact`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  if (differences.length === 0) {
    console.error(`OK  ${installed} carries the bytes of ${path.basename(tarball)}`);
    return;
  }
  for (const line of differences) console.error(line);
  console.error(
    `the installed package does not carry the build in ${path.basename(tarball)} (${differences.length} difference(s))`,
  );
  process.exit(1);
}

// show: the marker of an installed package - the answer to "which plugins
// commit am I running?".
function show(installed) {
  const file = path.join(installed, MARKER);
  if (!fs.existsSync(file)) {
    console.error(`no ${MARKER} in ${installed}`);
    process.exit(1);
  }
  console.log(fs.readFileSync(file, "utf8").trim());
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "inject":
    if (rest.length !== 2) die("usage: inject <tarball> <build-info.json>");
    inject(rest[0], rest[1]);
    break;
  case "verify":
    if (rest.length !== 2) die("usage: verify <tarball> <installed-dir>");
    verify(rest[0], rest[1]);
    break;
  case "show":
    if (rest.length !== 1) die("usage: show <installed-dir>");
    show(rest[0]);
    break;
  default:
    die("usage: package-artifact.mjs inject|verify|show ...");
}
