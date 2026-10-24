/**
 * watcher/src/guard.ts
 *
 * WHAT IT'S FOR
 *   Catches the failure mode we tell judges about: an agent "fixing" a conflict by weakening or
 *   deleting a test until the check turns green. A fix that edits or deletes an existing test file
 *   is sent to a human (flag_needs_human) instead of counting as resolved.
 *
 * OWNER: B. WHEN: Sat 20:00-24:00.
 * DONE WHEN: in a rehearsal where we tell the fixer to "just delete the failing test", the conflict
 *            goes to needs_human, the UI shows it, and the run is NOT reported as resolved.
 *
 * HOW
 *   When a new snapshot arrives from the fixer of an open conflict:
 *     changes = git diff --name-status <fixer's previous snapshot sha> <new sha>
 *     if testEdits(changes) isn't empty: flag_needs_human(conflictId,
 *       "The fix changed tests: <paths>. A person needs to confirm the tests are still right.")
 *   Adding a NEW test file is fine; only modified, deleted or renamed existing tests count.
 */

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export interface FileChange {
  path: string;
  /** First letter of git's --name-status: A added, M modified, D deleted, R renamed. */
  status: "A" | "M" | "D" | "R";
}

/** The changes that touch an existing test file. */
export function testEdits(changes: FileChange[]): FileChange[] {
  return changes.filter((change) => TEST_FILE.test(change.path) && change.status !== "A");
}

// TODO (B): read the changes with git (git.ts) and call flag_needs_human (stdb.ts) as described above.
