/**
 * watcher/src/map-errors.ts
 *
 * WHAT IT'S FOR
 *   Turns "the check failed at src/sessions/idle.ts:7" into "that line belongs to b's change, and
 *   the other side of the clash is src/users/user.ts:14 in a's change". This gives the conflict its
 *   two locations (locA, locB) and tells fixer.ts whose code the error sits in.
 *
 * OWNER: B. WHEN: Sat 14:00-19:00.
 * DONE WHEN: on the demo scenario, locB points into src/sessions/idle.ts, locA points at the line
 *            in src/users/user.ts where A changed the unit, and the error owner is b.
 *
 * WHAT TO EXPORT
 *   mapFailure(failure, changedLinesByAgent): { locA, locB, errorOwner: AgentName | "" | "both" }
 *     changedLinesByAgent comes from git.changedLines(mainSha, snapshotSha) for each agent.
 *
 * RULES
 *   - Error location = the first tsc error, or else the first failing test's first stack frame in src/.
 *   - errorOwner = the agent whose changed lines contain that location. If only one agent changed
 *     the file, it's that agent even when the exact line is off. Both, or neither: "both" or "".
 *   - The other side: the other agent's first changed line, preferring files that the error's file
 *     imports (deps.ts, once it exists), then the file with the most changed lines.
 *   - Line numbers in the merged tree can drift when both agents edited the same file. Prefer the
 *     file match; treat the line as a hint.
 */

// TODO (B): mapFailure() as described above.
export {};
