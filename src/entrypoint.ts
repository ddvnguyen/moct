/**
 * Is this module the process entrypoint?
 *
 * Both entrypoints (dist/daemon.js and dist/mcp.js) are started by a systemd
 * unit whose ExecStart is `node <root>/current/dist/<file>.js`, where `current`
 * is a symlink to the release directory. Node resolves that symlink before it
 * builds import.meta.url, so argv[1] and import.meta.url differ in their last
 * path component and a literal comparison is false: the module loads, runs
 * nothing, and exits 0 silently. That is how run 39010151404 spent 30s on a unit
 * that "started", never listened and logged nothing at all. Comparing the
 * realpath of argv[1] makes the guard independent of how the path was reached.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isEntrypoint(metaUrl: string, argvPath: string | undefined): boolean {
  if (argvPath === undefined) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    // argvPath no longer resolves (deleted between exec and here): fall back to
    // the literal comparison rather than throwing inside a module-level guard.
    return metaUrl === pathToFileURL(argvPath).href;
  }
}
