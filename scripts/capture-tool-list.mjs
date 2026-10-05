// capture-tool-list.mjs — MANUAL op (never from CI/tests).
//
// Boots the Python MCP server (current source via PYTHONPATH) with
// MCP_ORCH_TIER=all and saves the tools/list result as the checked-in
// input-schema snapshot served verbatim by the TS MCP server.
// Usage: npm run snapshot:schemas --workspace=@getpaseo/fleet-backend
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = path.join(PKG, ".tmp");
mkdirSync(TMP, { recursive: true });

const SRC = "/mnt/WorkDisk/Workplace/LLM-Agents-Orchestration/mcp-orchestration/src";
const VENV_PY =
  "/mnt/WorkDisk/Workplace/LLM-Agents-Orchestration/mcp-orchestration/.venv-cd/bin/python";

const server = spawn(VENV_PY, ["-m", "mcp_orchestration.server"], {
  cwd: TMP,
  env: {
    ...process.env,
    PYTHONPATH: SRC,
    MCP_ORCH_DB_PATH: path.join(TMP, "capture.db"),
    MCP_ORCH_STATE_DIR: path.join(TMP, "capture-state"),
    MCP_ORCH_TIER: "all",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
let nextId = 1;
function send(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}
server.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* notifications */
    }
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);
await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "capture", version: "0" },
});
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
await sleep(300);
const list = await send("tools/list", {});
const tools = list.result.tools;
const names = tools.map((t) => t.name);
console.log(`captured ${tools.length} tools: ${names.join(",")}`);
const out = path.join(PKG, "src", "surfaces", "mcp", "tool-list.snapshot.json");
writeFileSync(out, JSON.stringify(tools, null, 2) + "\n");
// The snapshot is a CHECKED-IN file, so regenerating it must be byte-reproducible
// or every regeneration shows up as a spurious diff. Measured: writing
// JSON.stringify(tools, null, 2) here and comparing against the committed file gave
// 135 differing lines while the parsed JSON was IDENTICAL — oxfmt collapses the
// expanded `"required": [...]` arrays. Format it here so the documented command
// reproduces the committed bytes on its own.
const oxfmt = path.join(PKG, "..", "..", "node_modules", ".bin", "oxfmt");
const formatted = spawnSync(oxfmt, [out], { stdio: "inherit" });
if (formatted.status !== 0) {
  console.error(
    `capture: oxfmt failed (${oxfmt}) — the snapshot is written UNFORMATTED and will\n` +
      `  differ from the committed file. Fix the formatter path, or run oxfmt on it\n` +
      `  by hand before committing.`,
  );
}
console.log(`wrote ${out}`);
server.kill();
process.exit(0);
