/**
 * watcher/src/deps.ts
 *
 * WHAT IT'S FOR
 *   Early warning, before any test runs. When an agent changes a file, this finds the files that
 *   import it. If another agent is working in one of those files right now, that agent gets a
 *   heads-up: "a is changing src/users/user.ts, which your src/sessions/idle.ts imports."
 *   It also lets map-errors.ts prefer the right file for the "other side" of a conflict.
 *
 * OWNER: A or C, whoever is free first. WHEN: Sat 20:00-24:00. Not on the critical path.
 * DONE WHEN: A's snapshot touching src/users/user.ts gives B a heads-up within 2 s, as long as B's
 *            latest snapshot touches a file that imports it.
 *
 * HOW
 *   - Build the import graph with madge on the watcher's clone of main (file level only):
 *       const result = await madge("<DEMO_REPO_PATH>/src", { fileExtensions: ["ts"] }); result.obj()
 *     (check the madge README for the current API). Rebuild it when main moves, and add each
 *     snapshot's new files on the fly.
 *   - Reverse it: importedBy[file] = files that import it.
 *   - On each snapshot from agent X with changed files F: for every other agent Y whose latest
 *     snapshot touches a file in importedBy[F], call send_note(Y, "heads_up", ...).
 *     Send at most one heads-up per (X, Y, file) per 10 minutes, so nobody gets spammed.
 *
 * WHY NOT HARDCODE THE GRAPH
 *   Agents create files all the time, so a hardcoded map goes stale within the hour. madge
 *   recomputes in about a second, and it works on any TypeScript repo, which is what a judge will ask.
 */

// TODO (A or C): build the graph, reverse it, send the heads-ups.
export {};
