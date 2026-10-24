/**
 * hooks/src/lib/snapshot.ts
 *
 * WHAT IT'S FOR
 *   Takes a snapshot of the agent's working tree as a git commit and force-pushes it to
 *   wip/<name>, WITHOUT touching the agent's branch, index or stash. This is how the watcher
 *   sees uncommitted work, new files included.
 *
 * OWNER: A.
 * DONE WHEN: an edit in a demo-app clone shows up as wip/<name> within 2 seconds, and the agent's
 *            own `git status` and `git log` look exactly the same as before (hooks/test/e2e.ts checks both).
 *
 * THE COMMANDS (run in the demo-app clone, which is the hook input's cwd)
 *   gitDir   = git rev-parse --absolute-git-dir
 *   lock     = <gitDir>/cowork-snapshot.lock         one snapshot at a time per clone (see NOTES)
 *   tmpIndex = <gitDir>/cowork-index-<pid>          copied from the real index, so only changed files get hashed
 *   GIT_INDEX_FILE=<tmpIndex> git add -A             new, changed and deleted files; respects .gitignore
 *   tree     = GIT_INDEX_FILE=<tmpIndex> git write-tree
 *   delete tmpIndex                                  always, even on errors (no leftover files)
 *   if tree == contents of <gitDir>/cowork-last-tree:  nothing changed, return null (no push)
 *   commit   = git commit-tree <tree> -p HEAD -m "wip <name> <ISO time>"   (author "cowork-<name>")
 *   git push --force --quiet <remote> <commit>:refs/heads/wip/<name>
 *   write tree to <gitDir>/cowork-last-tree
 *   baseSha  = git merge-base HEAD <remote>/<main>
 *   files    = git diff --name-only <baseSha> <commit>
 *   diff     = git diff <baseSha> <commit>, cut to 50 KB
 *
 * NOTES
 *   - The lock matters when an agent edits quickly: two hooks run at once, and without it an older
 *     tree could be pushed after a newer one. With it, the second hook re-reads the working tree
 *     after the first finishes, sees nothing new, and skips the push.
 *   - The author and committer are set to "cowork-<name>" through the environment, so commit-tree
 *     works even on a laptop with no git identity, and wip commits are easy to spot.
 *   - <remote>/<main> may be a few minutes stale on the laptop. That's fine: the watcher merges onto
 *     the real main itself. We don't `git fetch` here; it would slow down every edit.
 *   - State left inside .git: cowork-last-tree only. scripts/demo-reset.ts deletes it.
 */
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../../../shared/src/config.ts";
import { git } from "../../../shared/src/git.ts";
import { wipBranch } from "../../../shared/src/schema.ts";

const MAX_DIFF_CHARS = 50_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

export interface Snapshot {
  sha: string;
  baseSha: string;
  files: string[];
  diff: string;
}

/** Absolute path of the clone's .git directory (works in worktrees too). */
export function gitDirOf(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--absolute-git-dir"]);
}

/** Snapshots and pushes. Returns null when the working tree hasn't changed since the last snapshot. */
export async function takeSnapshot(cwd: string, agent: string): Promise<Snapshot | null> {
  const gitDir = await gitDirOf(cwd);
  return withLock(gitDir, async () => {
    const tree = await currentTree(cwd, gitDir);
    const lastFile = path.join(gitDir, "cowork-last-tree");
    const last = existsSync(lastFile) ? readFileSync(lastFile, "utf8").trim() : "";
    if (tree === last) return null;

    const who = `cowork-${agent}`;
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: who,
      GIT_AUTHOR_EMAIL: "cowork@localhost",
      GIT_COMMITTER_NAME: who,
      GIT_COMMITTER_EMAIL: "cowork@localhost",
    };
    const sha = await git(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", `wip ${agent} ${new Date().toISOString()}`], { env });
    await git(cwd, ["push", "--force", "--quiet", config.gitRemote, `${sha}:refs/heads/${wipBranch(agent)}`], { timeoutMs: 20_000 });
    writeFileSync(lastFile, tree);

    const remoteMain = `${config.gitRemote}/${config.mainBranch}`;
    const baseSha = await git(cwd, ["merge-base", "HEAD", remoteMain]).catch(() => git(cwd, ["rev-parse", "HEAD"]));
    const files = (await git(cwd, ["diff", "--name-only", baseSha, sha])).split("\n").filter(Boolean);
    const fullDiff = await git(cwd, ["diff", baseSha, sha], { raw: true });
    const diff = fullDiff.length > MAX_DIFF_CHARS ? `${fullDiff.slice(0, MAX_DIFF_CHARS)}\n(diff cut at 50 KB)` : fullDiff;
    return { sha, baseSha, files, diff };
  });
}

/** The tree of the working directory as it is right now, built in a temporary index. */
async function currentTree(cwd: string, gitDir: string): Promise<string> {
  const tmpIndex = path.join(gitDir, `cowork-index-${process.pid}`);
  try {
    const realIndex = path.join(gitDir, "index");
    if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    await git(cwd, ["add", "-A"], { env });
    return await git(cwd, ["write-tree"], { env });
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

/** Runs `work` while holding <gitDir>/cowork-snapshot.lock. A lock older than 30 s counts as stale. */
async function withLock<T>(gitDir: string, work: () => Promise<T>): Promise<T> {
  const lock = path.join(gitDir, "cowork-snapshot.lock");
  const started = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        // the lock disappeared between the two calls; just try again
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error("snapshot lock is busy");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { force: true });
  }
}
