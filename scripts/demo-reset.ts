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
 * DONE WHEN: after a reset, the UI shows four green, idle cards and an empty timeline, and
 *            `git ls-remote <remote> 'refs/heads/wip/*'` prints nothing.
 *
 * STEPS
 *   1. callReducer("reset_all", []) from shared/src/stdb-http.ts.
 *   2. For each agent: git push <remote> --delete wip/<agent>. A "remote ref does not exist" error is fine.
 *   3. For each clone given with --clones (only the clones on THIS laptop):
 *        - delete <gitDir>/cowork-last-tree and <gitDir>/cowork-listener.pid if they exist
 *        - git -C <clone> status --porcelain: if it isn't clean, STOP and print the files. Never
 *          throw away someone's work. Resetting a clone's code is SCENARIO.md's job, done by hand.
 *   4. Only with --reset-main: in the FIRST clone given, check that the remote is repo 2 (its URL
 *      ends in the demo app's repo name) and that the tag demo-base exists, then run
 *      git push --force <remote> demo-base:main. Beat 4 commits to main, so every rehearsal needs this.
 *   5. Print a one-line summary of what was removed.
 *
 * SAFETY
 *   - It never deletes anything except: rows in our own database, refs named wip/*, the two
 *     cowork-* state files inside .git, and (only with --reset-main) repo 2's main moving back to
 *     demo-base. No other branches, no working files, no node_modules, nothing in repo 1.
 *   - Reset each laptop's own clone on that laptop. The script doesn't reach across machines.
 */

// TODO (C): steps 1-5 above, with --yes required before changing anything.
export {};
