/**
 * watcher/src/git.ts
 *
 * WHAT IT'S FOR
 *   Every git operation the watcher needs: fetch the agents' wip branches, make throwaway
 *   worktrees, merge snapshots into them, and clean up. It works only in the watcher's own clone
 *   (DEMO_REPO_PATH), never in a clone someone is coding in.
 *
 * OWNER: B. WHEN: tonight (spike.ts uses it), Sat 9:20-13:00.
 * DONE WHEN: mergeInto() on two snapshots that edit different files succeeds, a textual conflict
 *            comes back as { ok: false, files }, and no worktree folders remain after exit.
 *
 * WHAT TO EXPORT
 *   fetchWip(): fetch main and every wip branch, in one call:
 *       git fetch <remote> +refs/heads/wip/*:refs/remotes/<remote>/wip/* <main>
 *   makeWorktree(label): string
 *       git worktree add --detach <tmp>/cowork-<pid>-<label> <remote>/<main>
 *       then link <worktree>/node_modules to <DEMO_REPO_PATH>/node_modules
 *   resetWorktree(path, sha)
 *       git -C <path> merge --abort (ignore errors), reset --hard <sha>, clean -fd
 *       (clean without -x, so the node_modules link survives)
 *   mergeInto(path, sha): { ok: true } | { ok: false, files: string[] }
 *       git -C <path> -c user.name=cowork -c user.email=cowork@localhost merge --no-ff --no-edit <sha>
 *       on failure: files = git diff --name-only --diff-filter=U, then merge --abort
 *   changedLines(base, sha): Map<file, Array<[start, end]>>
 *       from git diff -U0 <base> <sha>; map-errors.ts and guard.ts use it
 *   removeAllWorktrees()
 *       git worktree remove --force for each one we made, then git worktree prune.
 *       Call it on exit and on SIGINT.
 *
 * NOTES
 *   - Use execFile with an argument array (no shell), with a 60 s timeout per command.
 *   - Worktrees live under os.tmpdir(), never inside a repo.
 *   - node_modules link: fs.symlinkSync(target, link, "junction") works on Windows without admin
 *     rights; use a plain "dir" symlink on Mac and Linux. Never copy node_modules (too slow).
 *   - Keep a small pool of worktrees (full, single, pair-1, pair-2, pair-3) and reuse them with
 *     resetWorktree(). Making a new worktree per run is slow.
 */

// TODO (B): the functions listed above.
export {};
