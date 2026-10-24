/**
 * checks/src/git.ts
 *
 * WHAT IT'S FOR
 *   Every git operation a combined check needs: fetch the agents' wip branches, make throwaway
 *   worktrees, merge snapshots into them, read what each snapshot changed, and clean up. Written by
 *   B for the watcher; since branch feat/orchestrator each agent's check_with_team tool runs it in
 *   that agent's own clone (useRepo), and only ever touches temporary worktrees, never the clone's
 *   own working tree or index. Without useRepo it works in DEMO_REPO_PATH.
 *
 * OWNER: B.
 * DONE WHEN: mergeInto() on two snapshots that edit different files succeeds, a textual conflict
 *            comes back as { ok: false, files }, and no worktree folders remain after exit.
 *            (Fixture: the spike merges wip/a and wip/b; the merge step gives
 *            { ok: false, files: ["src/sessions/session.ts"] }; Ctrl+C leaves only the main worktree.)
 *
 * WHAT IT EXPORTS
 *   git(args, options)          one git command, no shell, 60 s timeout
 *   fetchWip()                  main and every wip branch in one fetch (pruning deleted wip branches):
 *                                 git fetch --prune <remote> +refs/heads/<main>:refs/remotes/<remote>/<main>
 *                                   +refs/heads/wip/*:refs/remotes/<remote>/wip/*
 *   mainSha(), wipHead(agent), hasCommit(sha), mergeBase(a, b), hasChanges(main, sha)
 *   withWorktree(fn)            borrows a pooled worktree (at most 3, created on first use) for one check
 *   makeWorktree(label), removeWorktree(path)
 *                               a worktree outside the pool, e.g. the diagnosis's disposable one:
 *                                 git worktree add --detach <tmp>/cowork-<pid>-<label> <remote>/<main>
 *                               then <worktree>/node_modules links to <DEMO_REPO_PATH>/node_modules
 *   resetWorktree(path, sha)    merge --abort (errors ignored), reset --hard <sha>, clean -fd
 *                               (the node_modules link is excluded from clean and re-made if missing)
 *   mergeInto(path, sha)        { ok: true } | { ok: false, files }
 *                                 git -c user.name=cowork -c user.email=cowork@localhost merge --no-ff --no-edit <sha>
 *                               on a conflict: files = git diff --name-only --diff-filter=U, then merge --abort
 *   changedLines(main, sha)     Map<file, Hunk[]> from git diff -U0 <main>...<sha>: only the agent's own
 *                               changes (from the merge-base), with the text of every added line
 *   nameStatus(from, to)        git diff --name-status --no-renames, for guard.ts
 *   blobId(sha, path), readFileAt(sha, path)
 *   removeAllWorktrees()        every worktree we made, then git worktree prune. Call it on exit and on SIGINT.
 *   removeStaleWorktrees()      worktrees left behind by a watcher that was killed. Call it on start.
 *
 * NOTES
 *   - execFile with an argument array (no shell), LC_ALL=C so git's messages stay parseable.
 *   - Merges run with --no-verify, commit signing off and rerere off, so the watcher machine's own git
 *     settings can't block or silently resolve a merge.
 *   - Worktrees live under os.tmpdir(), never inside a repo.
 *   - node_modules link: a "junction" on Windows (no admin rights needed), a "dir" symlink on Mac and
 *     Linux. Never copy node_modules (too slow). removeWorktree() unlinks it before git deletes the
 *     folder, so nothing ever follows the link into the real node_modules.
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../shared/src/config.ts";
import { wipBranch, type AgentName } from "../../shared/src/schema.ts";

const TIMEOUT_MS = 60_000;
const POOL_SIZE = 3;
const WORKTREE_PREFIX = "cowork-";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Defaults to DEMO_REPO_PATH. */
  cwd?: string;
  env?: Record<string, string>;
  /** Written to git's stdin. */
  input?: string;
  /** Return a non-zero exit instead of throwing. */
  allowFail?: boolean;
}

/** Runs one git command without a shell. Throws on a non-zero exit unless allowFail is set. */
export function git(args: string[], options: GitOptions = {}): Promise<GitResult> {
  const cwd = options.cwd ?? repo();
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...options.env },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        if (code !== 0 && !options.allowFail) {
          reject(new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${(stderr || stdout || String(error)).trim()}`));
          return;
        }
        resolve({ code, stdout, stderr });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

let repoOverride: string | null = null;

/** Run every git command and check in this clone instead of DEMO_REPO_PATH (an agent's own clone). */
export function useRepo(dir: string): void {
  repoOverride = dir;
}

/** The clone this module works in. */
export function repoPath(): string {
  if (repoOverride) return repoOverride;
  if (!config.demoRepoPath) throw new Error("DEMO_REPO_PATH is not set (see .env.example)");
  return config.demoRepoPath;
}

function repo(): string {
  return repoPath();
}

function remoteRef(branch: string): string {
  return `refs/remotes/${config.gitRemote}/${branch}`;
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

// ---- Refs ---------------------------------------------------------------------------------

export async function fetchWip(): Promise<void> {
  await git([
    "fetch",
    "--prune",
    "--quiet",
    config.gitRemote,
    `+refs/heads/${config.mainBranch}:${remoteRef(config.mainBranch)}`,
    `+refs/heads/${wipBranch("*")}:${remoteRef(wipBranch("*"))}`,
  ]);
}

/** The commit main points at, as of the last fetchWip(). */
export async function mainSha(): Promise<string> {
  const { stdout } = await git(["rev-parse", "--verify", `${remoteRef(config.mainBranch)}^{commit}`]);
  return stdout.trim();
}

/** The commit on wip/<agent> as of the last fetchWip(), or null if the branch doesn't exist. */
export async function wipHead(agent: AgentName): Promise<string | null> {
  const { code, stdout } = await git(["rev-parse", "--verify", "--quiet", `${remoteRef(wipBranch(agent))}^{commit}`], {
    allowFail: true,
  });
  return code === 0 ? stdout.trim() : null;
}

export async function hasCommit(sha: string): Promise<boolean> {
  const { code } = await git(["cat-file", "-e", `${sha}^{commit}`], { allowFail: true });
  return code === 0;
}

/** The best common ancestor of two commits, or null if they share none. */
export async function mergeBase(a: string, b: string): Promise<string | null> {
  const { code, stdout } = await git(["merge-base", a, b], { allowFail: true });
  return code === 0 ? stdout.trim() : null;
}

/** True when the snapshot changes anything compared with its merge-base with main. */
export async function hasChanges(main: string, sha: string): Promise<boolean> {
  const { code } = await git(["diff", "--quiet", `${main}...${sha}`], { allowFail: true });
  if (code > 1) throw new Error(`git diff --quiet ${main}...${sha} failed`);
  return code === 1;
}

// ---- Worktrees ----------------------------------------------------------------------------

const made = new Set<string>();
const pool: string[] = [];
const idle: string[] = [];
const waiting: Array<(dir: string) => void> = [];

function linkNodeModules(dir: string): void {
  const link = path.join(dir, "node_modules");
  try {
    lstatSync(link);
    return;
  } catch {
    // missing: make it
  }
  symlinkSync(path.join(repo(), "node_modules"), link, process.platform === "win32" ? "junction" : "dir");
}

function unlinkNodeModules(dir: string): void {
  const link = path.join(dir, "node_modules");
  try {
    if (!lstatSync(link).isSymbolicLink()) return;
  } catch {
    return;
  }
  try {
    unlinkSync(link);
  } catch {
    rmdirSync(link); // a Windows junction
  }
}

export async function makeWorktree(label: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `${WORKTREE_PREFIX}${process.pid}-${label}`);
  if (existsSync(dir)) await removeWorktree(dir);
  await git(["worktree", "add", "--detach", "--quiet", dir, remoteRef(config.mainBranch)]);
  made.add(dir);
  linkNodeModules(dir);
  return dir;
}

export async function removeWorktree(dir: string): Promise<void> {
  unlinkNodeModules(dir);
  await git(["worktree", "remove", "--force", dir], { allowFail: true });
  made.delete(dir);
}

export async function resetWorktree(dir: string, sha: string): Promise<void> {
  await git(["merge", "--abort"], { cwd: dir, allowFail: true });
  await git(["reset", "--hard", "--quiet", sha], { cwd: dir });
  await git(["clean", "-fdq", "-e", "node_modules"], { cwd: dir });
  linkNodeModules(dir);
}

/** Lends a pooled worktree to fn. At most POOL_SIZE run at once; the rest wait their turn. */
export async function withWorktree<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await acquire();
  try {
    return await fn(dir);
  } finally {
    const next = waiting.shift();
    if (next) next(dir);
    else idle.push(dir);
  }
}

async function acquire(): Promise<string> {
  const free = idle.pop();
  if (free) return free;
  if (pool.length < POOL_SIZE) {
    const label = `pool-${pool.length + 1}`;
    pool.push(label);
    try {
      return await makeWorktree(label);
    } catch (error) {
      pool.splice(pool.indexOf(label), 1);
      throw error;
    }
  }
  return new Promise((resolve) => waiting.push(resolve));
}

export async function removeAllWorktrees(): Promise<void> {
  for (const dir of [...made]) await removeWorktree(dir);
  pool.length = 0;
  idle.length = 0;
  await git(["worktree", "prune"], { allowFail: true });
}

/** Removes cowork worktrees whose process is gone (killed before it could clean up). */
export async function removeStaleWorktrees(): Promise<void> {
  await git(["worktree", "prune"], { allowFail: true });
  const { stdout } = await git(["worktree", "list", "--porcelain"]);
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const dir = line.slice("worktree ".length).trim();
    const match = new RegExp(`^${WORKTREE_PREFIX}(\\d+)-`).exec(path.basename(dir));
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processAlive(pid)) continue;
    await removeWorktree(dir);
  }
  await git(["worktree", "prune"], { allowFail: true });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- Merging ------------------------------------------------------------------------------

export type MergeResult = { ok: true } | { ok: false; files: string[] };

export async function mergeInto(dir: string, sha: string): Promise<MergeResult> {
  const result = await git(
    [
      "-c", "user.name=cowork",
      "-c", "user.email=cowork@localhost",
      "-c", "commit.gpgsign=false",
      "-c", "rerere.enabled=false",
      "merge", "--no-ff", "--no-edit", "--no-verify", "--quiet", sha,
    ],
    { cwd: dir, allowFail: true },
  );
  if (result.code === 0) return { ok: true };
  const conflicted = await git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir, allowFail: true });
  await git(["merge", "--abort"], { cwd: dir, allowFail: true });
  const files = lines(conflicted.stdout);
  if (files.length === 0) throw new Error(`git merge ${sha} failed: ${(result.stderr || result.stdout).trim()}`);
  return { ok: false, files };
}

// ---- What a snapshot changed ----------------------------------------------------------------

/**
 * Lines `start` .. `start + count - 1` of the new file were added or changed; `added` holds their
 * text. A pure deletion has count 0 and marks the spot after line `start`.
 */
export interface Hunk {
  start: number;
  count: number;
  added: string[];
}

export type ChangedLines = Map<string, Hunk[]>;

export function hunkContains(hunk: Hunk, line: number): boolean {
  if (hunk.count === 0) return line === hunk.start || line === hunk.start + 1;
  return line >= hunk.start && line < hunk.start + hunk.count;
}

/** The agent's own changes in `sha`: git diff -U0 <main>...<sha>, i.e. from their merge-base. */
export async function changedLines(main: string, sha: string): Promise<ChangedLines> {
  const { stdout } = await git(["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", `${main}...${sha}`]);
  return parseUnifiedDiff(stdout);
}

export function parseUnifiedDiff(diff: string): ChangedLines {
  const files: ChangedLines = new Map();
  let inHeader = false;
  let oldPath = "";
  let hunks: Hunk[] | null = null;
  let hunk: Hunk | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      hunks = null;
      hunk = null;
      continue;
    }
    if (inHeader && line.startsWith("--- ")) {
      oldPath = stripPrefix(line.slice(4), "a/");
      continue;
    }
    if (inHeader && line.startsWith("+++ ")) {
      const newPath = line.slice(4) === "/dev/null" ? oldPath : stripPrefix(line.slice(4), "b/");
      hunks = files.get(newPath) ?? [];
      files.set(newPath, hunks);
      continue;
    }
    if (inHeader && line.startsWith("Binary files ")) {
      const match = / and (?:b\/)?(.+) differ$/.exec(line);
      if (match?.[1] && !files.has(match[1])) files.set(match[1], []);
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && hunks) {
      inHeader = false;
      hunk = { start: Number(header[1]), count: header[2] === undefined ? 1 : Number(header[2]), added: [] };
      hunks.push(hunk);
      continue;
    }
    if (hunk && !inHeader && line.startsWith("+")) hunk.added.push(line.slice(1));
  }
  return files;
}

function stripPrefix(raw: string, prefix: string): string {
  const name = raw.replace(/\t$/, "");
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export interface NameStatus {
  path: string;
  /** git's status letter; with --no-renames: A added, M modified, D deleted, T type changed. */
  status: string;
}

export async function nameStatus(from: string, to: string): Promise<NameStatus[]> {
  const { stdout } = await git(["diff", "--name-status", "--no-renames", "-z", from, to]);
  const parts = stdout.split("\0").filter((part) => part !== "");
  const changes: NameStatus[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    changes.push({ status: parts[i]!.charAt(0), path: parts[i + 1]! });
  }
  return changes;
}

/** The blob id of `path` in commit `sha`, or null if the file doesn't exist there. */
export async function blobId(sha: string, filePath: string): Promise<string | null> {
  const { code, stdout } = await git(["rev-parse", "--verify", "--quiet", `${sha}:${filePath}`], { allowFail: true });
  return code === 0 ? stdout.trim() : null;
}

/** The content of `path` in commit `sha`, or null if the file doesn't exist there. */
export async function readFileAt(sha: string, filePath: string): Promise<string | null> {
  const { code, stdout } = await git(["show", `${sha}:${filePath}`], { allowFail: true });
  return code === 0 ? stdout : null;
}
