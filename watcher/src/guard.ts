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
 *            (Fixture: steps b-idle, a-ms, then b-cheat.)
 *
 * HOW
 *   When a new snapshot arrives from the fixer of an open conflict (index.ts calls guardFix before
 *   the check, so a green run can't resolve the conflict first):
 *     before  = the fixer's newest snapshot from before the conflict was opened
 *     changes = git diff --name-status --no-renames <before> <fixer's newest snapshot>
 *     if testEdits(changes) isn't empty: flag_needs_human(conflictId,
 *       "The fix changed tests: <paths>. A person needs to confirm the tests are still right.")
 *   Adding a NEW test file is fine; only modified, deleted or renamed existing tests count.
 *   Comparing with the snapshot from before the conflict (not the previous one) also catches a
 *   test edit followed by more snapshots.
 *
 * PULLED, NOT EDITED
 *   A fixer that pulls a teammate's change (the pull_teammate tool) gets the teammate's test edits
 *   too; in the demo, a's src/users/user.test.ts. Those aren't the fixer's: a test file whose
 *   content equals the version in another agent's latest snapshot doesn't count, and neither does
 *   deleting a main test that another agent's snapshot deletes too.
 */
import type { AgentName, ConflictRow } from "../../shared/src/schema.ts";
import { blobId, mergeBase, nameStatus } from "./git.ts";
import { flagNeedsHuman } from "./stdb.ts";

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

export interface GuardInput {
  conflict: ConflictRow;
  /** The fixer's newest snapshot from before the conflict opened, and its newest one now. */
  before: string;
  after: string;
  main: string;
  /** Every other agent's latest snapshot. */
  teammates: { agent: AgentName; sha: string }[];
}

/** The test files the fixer itself edited or deleted between the two snapshots. */
export async function fixerTestEdits(input: GuardInput): Promise<FileChange[]> {
  const changes: FileChange[] = (await nameStatus(input.before, input.after)).map((change) => ({
    path: change.path,
    status: change.status === "A" || change.status === "D" ? change.status : "M",
  }));
  const own: FileChange[] = [];
  for (const edit of testEdits(changes)) {
    if (!(await pulledFromTeammate(edit, input))) own.push(edit);
  }
  return own;
}

/** Flags the conflict for a person if the fix edited tests. Returns the edits it found. */
export async function guardFix(input: GuardInput): Promise<FileChange[]> {
  const edits = await fixerTestEdits(input);
  if (edits.length === 0) return edits;
  const paths = edits.map((edit) => (edit.status === "D" ? `${edit.path} (deleted)` : edit.path)).join(", ");
  await flagNeedsHuman(input.conflict.id, `The fix changed tests: ${paths}. A person needs to confirm the tests are still right.`);
  return edits;
}

async function pulledFromTeammate(edit: FileChange, input: GuardInput): Promise<boolean> {
  if (edit.status === "D") {
    if ((await blobId(input.main, edit.path)) === null) return false;
    for (const teammate of input.teammates) {
      const base = await mergeBase(input.main, teammate.sha);
      if (base && (await blobId(base, edit.path)) !== null && (await blobId(teammate.sha, edit.path)) === null) return true;
    }
    return false;
  }
  const mine = await blobId(input.after, edit.path);
  if (mine === null) return false;
  for (const teammate of input.teammates) {
    if ((await blobId(teammate.sha, edit.path)) === mine) return true;
  }
  return false;
}
