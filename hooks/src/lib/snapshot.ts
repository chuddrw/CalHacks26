/**
 * hooks/src/lib/snapshot.ts
 *
 * WHAT IT'S FOR
 *   Takes a snapshot of the agent's working tree as a git commit and force-pushes it to
 *   wip/<name>, WITHOUT touching the agent's branch, index or stash. This is how the watcher
 *   sees uncommitted work, new files included.
 *
 * OWNER: A. WHEN: tonight (prove the commands by hand), Sat 9:20 (wire into snapshot-and-wait.ts).
 * DONE WHEN: an edit in a demo-app clone shows up on GitHub as wip/<name> within 2 seconds, and
 *            the agent's own `git status` and `git log` look exactly the same as before.
 *
 * THE COMMANDS (run in the demo-app clone, which is the hook input's cwd)
 *   gitDir   = git rev-parse --absolute-git-dir
 *   tmpIndex = <gitDir>/cowork-index-<pid>          one per process, so parallel hooks don't collide
 *   copy <gitDir>/index to tmpIndex                  start from the real index, so only changed files get hashed
 *   GIT_INDEX_FILE=<tmpIndex> git add -A             new, changed and deleted files; respects .gitignore
 *   tree     = GIT_INDEX_FILE=<tmpIndex> git write-tree
 *   delete tmpIndex                                  always, even on errors (no leftover files)
 *   if tree == contents of <gitDir>/cowork-last-tree:  nothing changed, return null (no push)
 *   commit   = git commit-tree <tree> -p HEAD -m "wip <name> <ISO time>"
 *   git push --force --quiet <remote> <commit>:refs/heads/wip/<name>
 *   write tree to <gitDir>/cowork-last-tree
 *   baseSha  = git merge-base HEAD <remote>/<main>
 *   files    = git diff --name-only <baseSha> <commit>
 *   diff     = git diff <baseSha> <commit>, cut to 50 KB
 *
 * TESTED (Oct 24, real git on Windows, bare remote + two clones): these exact commands pushed
 *   wip/a and wip/b, the agent's `git log` and unstaged changes stayed exactly as they were, and no
 *   cowork-index file was left in .git. The watcher merged both wip branches cleanly.
 *
 * NOTES
 *   - Use execFile (no shell) with env { ...process.env, GIT_INDEX_FILE }. Same on Windows and Mac.
 *   - For commit-tree, also set GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL and GIT_COMMITTER_NAME/
 *     GIT_COMMITTER_EMAIL to "cowork-<name>" / "cowork@localhost". It then works even on a laptop
 *     with no git identity configured, and wip commits are easy to recognize.
 *   - On Windows, git prints "LF will be replaced by CRLF" warnings on stderr. Ignore them.
 *   - commit-tree runs no git hooks. The push can run a pre-push hook if the repo has one.
 *   - <remote>/<main> may be a few minutes stale on the laptop. That's fine: the watcher merges onto
 *     the real main itself. Don't `git fetch` here; it would slow down every edit.
 *   - The only state left behind is <gitDir>/cowork-last-tree. scripts/demo-reset.ts deletes it.
 */

export interface Snapshot {
  sha: string;
  baseSha: string;
  files: string[];
  diff: string;
}

/** Snapshots and pushes. Returns null when the working tree hasn't changed since the last snapshot. */
export async function takeSnapshot(cwd: string, agent: string): Promise<Snapshot | null> {
  // TODO (A): implement the commands listed above.
  throw new Error(`takeSnapshot(${cwd}, ${agent}): not implemented yet`);
}

/** Absolute path of the clone's .git directory (works in worktrees too). */
export async function gitDirOf(cwd: string): Promise<string> {
  // TODO (A): git rev-parse --absolute-git-dir
  throw new Error(`gitDirOf(${cwd}): not implemented yet`);
}
