/**
 * Unit tests for the LAO #69 config port (pin 13fc0cb): agentCwd() precedence
 * and _detect_repo_root fail-open in isUnsafeTierKey().
 *
 * No DB, no servers — pure functions, milliseconds.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentCwd, detectRepoRoot, isUnsafeTierKey, stateRoot } from "../../src/domain/config.js";

const savedCwd = process.cwd();
const savedEnv = process.env["PASEO_AGENT_CWD"];
const tmpDirs: string[] = [];

afterEach(() => {
  process.chdir(savedCwd);
  if (savedEnv === undefined) delete process.env["PASEO_AGENT_CWD"];
  else process.env["PASEO_AGENT_CWD"] = savedEnv;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-cwd-"));
  tmpDirs.push(dir);
  return dir;
}

describe("agentCwd precedence (LAO #69)", () => {
  it("explicit argument beats the env var", () => {
    process.env["PASEO_AGENT_CWD"] = "/from-env";
    expect(agentCwd("/explicit")).toBe("/explicit");
  });
  it("env var beats the process cwd", () => {
    process.env["PASEO_AGENT_CWD"] = "/from-env";
    process.chdir(freshDir());
    expect(agentCwd(null)).toBe("/from-env");
    expect(agentCwd(undefined)).toBe("/from-env");
  });
  it("falls back to the process cwd when nothing else is set", () => {
    delete process.env["PASEO_AGENT_CWD"];
    const dir = freshDir();
    process.chdir(dir);
    expect(agentCwd(null)).toBe(dir);
  });
  it("blank explicit and blank env fall through to the process cwd", () => {
    process.env["PASEO_AGENT_CWD"] = "   ";
    const dir = freshDir();
    process.chdir(dir);
    expect(agentCwd("  ")).toBe(dir);
  });
});

describe("detectRepoRoot / isUnsafeTierKey fail-open (LAO #69)", () => {
  it("returns null with no markers, and the guard fails OPEN", () => {
    const dir = freshDir();
    process.chdir(dir);
    expect(detectRepoRoot()).toBeNull();
    // No root to be an ancestor of: refusing every key would collapse all
    // sessions to MCP_ORCH_TIER, so the guard allows (fleet.json still gates).
    expect(isUnsafeTierKey("/any/session/cwd")).toBe(false);
  });
  it("empty candidate is never unsafe", () => {
    expect(isUnsafeTierKey("")).toBe(false);
    expect(isUnsafeTierKey("   ")).toBe(false);
  });
  it("root and its ancestors are unsafe; anything else is not", () => {
    const root = freshDir();
    writeFileSync(path.join(root, "AGENTS.md"), "x");
    mkdirSync(path.join(root, "orchestration"));
    const sub = path.join(root, "sub", "deep");
    mkdirSync(sub, { recursive: true });
    process.chdir(sub);
    expect(detectRepoRoot()).toBe(root);
    expect(isUnsafeTierKey(root)).toBe(true);
    expect(isUnsafeTierKey(path.dirname(root))).toBe(true);
    expect(isUnsafeTierKey(sub)).toBe(false);
    expect(isUnsafeTierKey(path.join(tmpdir(), "unrelated"))).toBe(false);
  });
});

describe("stateRoot default (F6: no cwd drift)", () => {
  it("resolves <detected repo root>/orchestration/state/mcp with env unset, even when cwd is a marker-less dir under the root", () => {
    const savedStateDir = process.env["MCP_ORCH_STATE_DIR"];
    const savedRepoRoot = process.env["FLEET_REPO_ROOT"];
    delete process.env["MCP_ORCH_STATE_DIR"];
    delete process.env["FLEET_REPO_ROOT"];
    try {
      const root = freshDir();
      writeFileSync(path.join(root, "AGENTS.md"), "x");
      mkdirSync(path.join(root, "orchestration"));
      const deep = path.join(root, "sub", "deep");
      mkdirSync(deep, { recursive: true });
      process.chdir(deep);
      expect(stateRoot()).toBe(path.join(root, "orchestration", "state", "mcp"));
    } finally {
      if (savedStateDir === undefined) delete process.env["MCP_ORCH_STATE_DIR"];
      else process.env["MCP_ORCH_STATE_DIR"] = savedStateDir;
      if (savedRepoRoot === undefined) delete process.env["FLEET_REPO_ROOT"];
      else process.env["FLEET_REPO_ROOT"] = savedRepoRoot;
    }
  });
  it("env override wins over repo detection", () => {
    const savedStateDir = process.env["MCP_ORCH_STATE_DIR"];
    const savedRepoRoot = process.env["FLEET_REPO_ROOT"];
    try {
      const root = freshDir();
      writeFileSync(path.join(root, "AGENTS.md"), "x");
      mkdirSync(path.join(root, "orchestration"));
      process.env["MCP_ORCH_STATE_DIR"] = "/from-env/state";
      delete process.env["FLEET_REPO_ROOT"];
      process.chdir(root);
      expect(stateRoot()).toBe(path.resolve("/from-env/state"));
    } finally {
      if (savedStateDir === undefined) delete process.env["MCP_ORCH_STATE_DIR"];
      else process.env["MCP_ORCH_STATE_DIR"] = savedStateDir;
      if (savedRepoRoot === undefined) delete process.env["FLEET_REPO_ROOT"];
      else process.env["FLEET_REPO_ROOT"] = savedRepoRoot;
    }
  });
});
