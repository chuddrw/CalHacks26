/**
 * watcher/src/spike.ts
 *
 * WHAT IT'S FOR
 *   Tonight's proof for B, with no database involved: given two branch names, merge both onto main
 *   in a throwaway worktree, run tsc, print the errors, and clean up. If this works tonight,
 *   tomorrow is wiring it to SpacetimeDB, not fighting git.
 *
 * OWNER: B. WHEN: tonight, 0:20-1:20.
 * USAGE (from the repo root): npm run spike:watcher -- <branch-a> <branch-b>
 *   Example: push two test branches to the demo-app repo, one changing lastLogin to milliseconds
 *   and one adding code that assumes seconds, then run the spike on them.
 * DONE WHEN: it prints "merge ok" for both branches plus a tsc result (a vitest result if there's
 *            time), and `git worktree list` in DEMO_REPO_PATH shows nothing extra afterwards.
 *
 * STEPS
 *   1. git -C <DEMO_REPO_PATH> fetch <remote>
 *   2. git worktree add --detach <tmp>/cowork-spike <remote>/<main>
 *   3. link node_modules (see git.ts)
 *   4. merge <remote>/<branch-a>, then <remote>/<branch-b>, with --no-ff --no-edit; print the result of each
 *   5. node <DEMO_REPO_PATH>/node_modules/typescript/bin/tsc --noEmit -p <worktree>; print the errors
 *   6. In a finally block: git worktree remove --force <worktree>
 *
 * Move the pieces into git.ts and check.ts once they work.
 */

// TODO (B): steps 1-6 above.
export {};
