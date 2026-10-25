/**
 * scripts/demo-reset.ts
 *
 * WHAT IT'S FOR
 *   Puts everything back to a clean start before each demo run and rehearsal: empty tables, no
 *   remote wip branches, every demo-app clone back on main with no leftover state files. A demo
 *   that starts from leftovers of the last run is a demo that breaks in front of judges.
 *
 * OWNER: C. WHEN: Sat 19:00 (before the first full rehearsal).
 * USAGE (from the repo root):
 *   npm run reset -- --agents a,b,c,d --clones <path>[,<path>...] [--reset-main] [--yes]
 *   Without --yes it only PRINTS what it would do. Run it once without --yes, read the list, then
 *   run it again with --yes.
 * DONE WHEN: after a reset, the database and timeline are empty (agents re-register on connect), and
 *            `git ls-remote <remote> 'refs/heads/wip/*'` prints nothing.
 *
 * STEPS
 *   1. Preflight EVERY clone and remote before any changes, then callReducer("reset_all", []).
 *   2. For each agent: git push <remote> --delete wip/<agent>. A "remote ref does not exist" error is fine.
 *   3. For each clone given with --clones (only the clones on THIS laptop):
 *        - delete <gitDir>/cowork-last-tree and <gitDir>/cowork-listener.pid if they exist
 *        - git -C <clone> status --porcelain: if it isn't clean, STOP and print the files. Never
 *          throw away someone's work. Resetting a clone's code is SCENARIO.md's job, done by hand.
 *   4. Verify every clone's push URL matches DEMO_REPO_PATH and differs from repo 1. Only with
 *      --reset-main: in the FIRST clone, require the demo-base tag, then run
 *      git push --force <remote> demo-base:main. Beat 4 commits to main, so every rehearsal needs this.
 *   5. Print a one-line summary of what was removed.
 *
 * SAFETY
 *   - It never deletes anything except: rows in our own database, refs named wip/*, the two
 *     cowork-* state files inside .git, and (only with --reset-main) repo 2's main moving back to
 *     demo-base. No other branches, no working files, no node_modules, nothing in repo 1.
 *   - Reset each laptop's own clone on that laptop. The script doesn't reach across machines.
 */

import { execFileSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config, missingSettings } from "../shared/src/config.ts";
import { callReducer } from "../shared/src/stdb-http.ts";
import { wipBranch } from "../shared/src/schema.ts";

export interface ResetOptions {
  agents: string[];
  clones: string[];
  resetMain: boolean;
  yes: boolean;
}

export interface ResetPlan {
  database: string;
  remote: string;
  remoteUrl: string;
  clones: Array<{ directory: string; gitDir: string }>;
  branches: string[];
  mainCommit?: string;
}

/** Strict parsing prevents misspelled safety flags and ref-name injection. */
export function parseOptions(args: string[]): ResetOptions {
  const result: ResetOptions = { agents: [], clones: [], resetMain: false, yes: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === "--yes") result.yes = true;
    else if (flag === "--reset-main") result.resetMain = true;
    else if (flag === "--agents" || flag === "--clones") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a comma-separated value.`);
      const values = value.split(",").map((item) => item.trim());
      if (values.some((item) => !item)) throw new Error(`${flag} contains an empty value.`);
      if (flag === "--agents") result.agents = [...new Set(values)];
      else result.clones = [...new Set(values)];
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!result.agents.length || !result.clones.length) {
    throw new Error("Usage: npm run reset -- --agents a,b,c,d --clones <path>[,<path>...] [--reset-main] [--yes]");
  }
  if (result.agents.some((agent) => !/^[a-z0-9][a-z0-9_-]*$/.test(agent))) {
    throw new Error("Agent names must be lowercase letters, digits, underscores or hyphens, starting with a letter or digit.");
  }
  return result;
}

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function pushUrls(directory: string, remote: string): string[] {
  // Push URLs may differ from fetch URLs; root protection must inspect every destination.
  const urls = git(directory, ["remote", "get-url", "--push", "--all", remote]).split("\n");
  if (!urls.length || urls.some(url => !url)) throw new Error(`Cannot identify push URLs for ${remote} in ${directory}.`);
  return urls.map(url => url.replace(/\/+$/, "").replace(/\.git$/, ""));
}

function remoteUrl(directory: string, remote: string): string {
  // Multiple demo push URLs would widen a destructive reset beyond its reviewed destination.
  const urls = pushUrls(directory, remote);
  if (urls.length !== 1) throw new Error(`Expected one push URL for ${remote} in ${directory}.`);
  return urls[0]!;
}

/** Read-only preflight. Every clone must be clean and match the configured demo repository. */
export function buildPlan(options: ResetOptions, settings = config): ResetPlan {
  if (!settings.demoRepoPath) throw new Error("Set DEMO_REPO_PATH to a separate demo-app clone before resetting.");
  if (!settings.gitRemote || settings.gitRemote.startsWith("-")) throw new Error("Invalid GIT_REMOTE.");
  const root = realpathSync(settings.repoRoot);
  const demo = realpathSync(settings.demoRepoPath);
  const demoRoot = realpathSync(git(demo, ["rev-parse", "--show-toplevel"]));
  if (demoRoot === root) throw new Error("DEMO_REPO_PATH points to repo 1; use the separate demo-app repository.");
  const expectedRemote = remoteUrl(demo, settings.gitRemote);
  // Remote names are local aliases. Inspect every repo 1 destination and fail closed on errors.
  const rootRemotes = git(root, ["remote"]).split("\n").filter(Boolean);
  const rootPushUrls = rootRemotes.flatMap(remote => pushUrls(root, remote));
  if (rootPushUrls.includes(expectedRemote)) throw new Error("Demo remote matches repo 1; refusing reset.");
  const clones = options.clones.map((clone) => {
    const directory = realpathSync(clone);
    const topLevel = realpathSync(git(directory, ["rev-parse", "--show-toplevel"]));
    if (directory !== topLevel || topLevel === root) throw new Error(`Use the demo clone root, not repo 1 or a subdirectory: ${clone}`);
    const dirty = git(directory, ["status", "--porcelain", "--untracked-files=all"]);
    if (dirty) throw new Error(`Clone has uncommitted work; reset stopped: ${directory}\n${dirty}`);
    if (remoteUrl(directory, settings.gitRemote) !== expectedRemote) throw new Error(`Clone remote does not match DEMO_REPO_PATH: ${directory}`);
    return { directory, gitDir: git(directory, ["rev-parse", "--absolute-git-dir"]) };
  });
  const plan: ResetPlan = {
    database: settings.stdbDb, remote: settings.gitRemote, remoteUrl: expectedRemote, clones,
    branches: options.agents.map(wipBranch),
  };
  if (options.resetMain) plan.mainCommit = git(clones[0]!.directory, ["rev-parse", "--verify", "refs/tags/demo-base^{commit}"]);
  return plan;
}

export interface ResetActions {
  resetDatabase(): Promise<void>;
  deleteBranch(directory: string, remote: string, branch: string): void;
  removeState(file: string): void;
  resetMain(directory: string, remote: string, commit: string): void;
}

const actions: ResetActions = {
  // reset_all deletes every row in one transaction: on maincloud that can take more than a hook's 3 s.
  resetDatabase: () => callReducer("reset_all", [], 30_000),
  deleteBranch(directory, remote, branch) {
    try { git(directory, ["push", remote, "--delete", branch]); }
    catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (!stderr.includes("remote ref does not exist")) throw error;
    }
  },
  removeState: (file) => rmSync(file, { force: true }),
  resetMain: (directory, remote, commit) => { git(directory, ["push", "--force", remote, `${commit}:refs/heads/main`]); },
};

/** Executes only the reviewed reset targets; never resets local branches or working files. */
export async function executePlan(plan: ResetPlan, adapter: ResetActions = actions): Promise<void> {
  await adapter.resetDatabase();
  const firstClone = plan.clones[0]!.directory;
  for (const branch of plan.branches) adapter.deleteBranch(firstClone, plan.remote, branch);
  for (const clone of plan.clones) {
    for (const file of ["cowork-last-tree", "cowork-listener.pid"]) adapter.removeState(path.join(clone.gitDir, file));
  }
  if (plan.mainCommit) adapter.resetMain(firstClone, plan.remote, plan.mainCommit);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(args);
  const plan = buildPlan(options);
  console.log(`${options.yes ? "Reset" : "Dry run"}: database ${plan.database || "(STDB_DB missing)"}; ${plan.branches.join(", ")} on ${plan.remote} (${plan.remoteUrl}) from ${plan.clones[0]!.directory}.`);
  for (const clone of plan.clones) console.log(`Remove only ${clone.gitDir}/{cowork-last-tree,cowork-listener.pid}`);
  if (plan.mainCommit) console.log(`Force main to demo-base (${plan.mainCommit}).`);
  if (!options.yes) {
    console.log("No changes made. Re-run with --yes to execute this reset.");
    return;
  }
  // The token is this laptop's `spacetime login` session (callReducer reads it), never .env.
  const missing = missingSettings(["stdbDb"]);
  if (missing.length) throw new Error(`Fill in ${missing.join(", ")} before resetting.`);
  // Repeat preflight immediately before the first mutation, including cleanliness and tag lookup.
  const current = buildPlan(options);
  if (JSON.stringify(current) !== JSON.stringify(plan)) throw new Error("Reset targets changed during preflight; run again.");
  await executePlan(current);
  console.log(`Reset complete: database cleared, ${plan.branches.length} wip refs removed or absent, state files cleared in ${plan.clones.length} clones${plan.mainCommit ? ", main reset to demo-base" : ""}.`);
}

function invokedDirectly(): boolean {
  // argv can be '-' or an eval argument when this module is imported as a library.
  try { return Boolean(process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href); }
  catch { return false; }
}

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
