/**
 * shared/src/full-stack.ts
 *
 * WHAT IT'S FOR
 *   Puts the team's full stack (the orchestrator's FULL_STACK_BRANCH: main plus everyone's latest
 *   green work) on this laptop, so anyone can run the whole project, not just their own part. It
 *   goes into a sibling folder of the clone, "<clone>-full-stack", as a git worktree: your own
 *   working tree, branch and uncommitted work are never touched. Running it again updates it.
 *
 * OWNER: A (branch feat/orchestrator). USED BY: the MCP tool get_full_stack (mcp/src/server.ts) and
 *        `npm run full-stack -- --demo <clone>` (scripts/full-stack.ts).
 *
 * NOTES
 *   - node_modules is linked from the clone (a junction on Windows), so the project runs right away.
 *     If the full stack added a dependency, run npm install in the folder.
 *   - A folder with that name that isn't this clone's worktree is left alone (the call says so).
 */
import { existsSync, lstatSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { git } from "./git.ts";
import { FULL_STACK_BRANCH } from "./schema.ts";

export interface FullStack {
  ok: boolean;
  /** A few sentences for the agent or the person. */
  text: string;
  folder?: string;
  sha?: string;
}

/** Fetches the full stack and checks it out into <clone>-full-stack. `cwd` is anywhere in the clone. */
export async function getFullStack(cwd: string): Promise<FullStack> {
  const root = path.resolve(await git(cwd, ["rev-parse", "--show-toplevel"]));
  const remoteBranch = `refs/remotes/${config.gitRemote}/${FULL_STACK_BRANCH}`;
  try {
    await git(root, ["fetch", "--quiet", config.gitRemote, `+refs/heads/${FULL_STACK_BRANCH}:${remoteBranch}`], { timeoutMs: 60_000 });
  } catch {
    return { ok: false, text: `There's no full stack yet: the orchestrator pushes ${FULL_STACK_BRANCH} once everyone's work passes the checks together.` };
  }
  const sha = await git(root, ["rev-parse", remoteBranch]);
  const folder = `${root}-full-stack`;
  if (existsSync(folder)) {
    if (!isOurWorktree(folder, root)) {
      return { ok: false, text: `${folder} exists but isn't this clone's full-stack worktree, so I left it alone. Move it, then try again.` };
    }
    await git(folder, ["checkout", "--quiet", "--detach", "--force", sha]);
    await git(folder, ["clean", "-fdq"]); // ignored files (node_modules) stay
  } else {
    await git(root, ["worktree", "add", "--quiet", "--detach", folder, sha]);
  }
  const modules = path.join(folder, "node_modules");
  if (!exists(modules) && existsSync(path.join(root, "node_modules"))) {
    symlinkSync(path.join(root, "node_modules"), modules, process.platform === "win32" ? "junction" : "dir");
  }
  const scripts = readScripts(folder);
  const log = await git(folder, ["log", "--format=%s", "-n", "20"]).catch(() => "");
  const merged = [...new Set([...log.matchAll(/wip ([a-z0-9_-]+) /g)].map((m) => m[1]))];
  return {
    ok: true,
    folder,
    sha,
    text:
      `The full stack ${sha.slice(0, 8)} (${FULL_STACK_BRANCH}${merged.length ? `, with work from ${merged.join(", ")}` : ""}) is in ${folder}. ` +
      `Your own working tree wasn't touched. Run the project there${scripts.length ? `: ${scripts.map((name) => `npm run ${name}`).join(", ")}` : ""}.`,
  };
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** True when `folder` is a git worktree of the repository at `root` (its .git file points there). */
function isOurWorktree(folder: string, root: string): boolean {
  try {
    const pointer = readFileSync(path.join(folder, ".git"), "utf8").trim();
    const target = pointer.replace(/^gitdir:\s*/, "").replace(/\\/g, "/").toLowerCase();
    return target.startsWith(`${root.replace(/\\/g, "/").toLowerCase()}/.git/worktrees/`);
  } catch {
    return false;
  }
}

function readScripts(folder: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
}
