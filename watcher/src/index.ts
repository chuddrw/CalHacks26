/**
 * watcher/src/index.ts
 *
 * WHAT IT'S FOR
 *   The watcher's main loop: the part that turns "four agents editing on four laptops" into
 *   "red or green, who clashes with whom, and who fixes it". One copy runs on one machine for
 *   the whole team. Use a Mac or Linux laptop if possible (see git.ts about Windows links).
 *
 * OWNER: B. WHEN: Sat 9:20-13:00 (loop + full check), Sat 14:00-19:00 (pairs, fixer, diagnosis).
 * DONE WHEN: two agents' conflicting snapshots produce ONE conflict row with the right pair, fixer
 *            and file:line within 15 s of the second push, and the next green run resolves it.
 *
 * LOOP
 *   1. Connect (stdb.ts) and subscribe to snapshot and conflict.
 *   2. On each new snapshot row, wait CHECK_DEBOUNCE_MS: agents edit in bursts.
 *   3. latest = the newest snapshot per agent, skipping agents whose snapshot equals main.
 *   4. git.fetchWip(), then run the full check: main + every latest snapshot (git.ts + check.ts).
 *      Call report_check with the result.
 *   5. Green: resolve every open conflict whose agents were all in this run. Pass the fact from
 *      that conflict's diagnosis (kept in memory here) to resolve_conflict.
 *   6. Red: localize.ts finds the failures (self, pair, merge), fixer.ts picks each fixer, and
 *      report_conflict records each one. For every NEW conflict, start diagnose/index.ts without
 *      waiting for it.
 *   7. When a snapshot comes from the fixer of an open conflict, guard.ts checks it first. A fix
 *      that edits or deletes a test goes to flag_needs_human.
 *   8. Sat 20:00 and later: deps.ts sends heads-ups to agents whose files import the changed files.
 *
 * RULES
 *   - One run at a time. Snapshots that arrive during a run trigger exactly one more run after it.
 *   - Red or green comes only from git + tsc + vitest, never from Droid or Claude.
 *   - Remove every temporary worktree on exit, Ctrl+C included (git.removeAllWorktrees()).
 *   - Facts from diagnoses live in memory only. If the watcher restarts mid-conflict, that conflict
 *     resolves without a fact. That's acceptable.
 */

// TODO (B): the loop above.
export {};
