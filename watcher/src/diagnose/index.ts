/**
 * watcher/src/diagnose/index.ts
 *
 * WHAT IT'S FOR
 *   Runs the diagnosis for one new conflict, and makes sure exactly one explanation reaches the
 *   database. Droid goes first (DIAGNOSE_WITH=droid, Factory prize); if it is off, fails, or takes
 *   longer than 90 s, the Claude fallback runs. If both fail, the conflict keeps its raw error.
 *
 * OWNER: C. WHEN: Sat 14:00-19:00.
 * DONE WHEN: every new conflict gets a set_explanation call within about 60 s, or a clear
 *            "diagnosis unavailable" step in the Droid panel, and leaves no worktree behind.
 *
 * STEPS (index.ts in the watcher starts this without awaiting it)
 *   1. Build the DiagnosisContext (prompt.ts): the conflict row, each side's latest intent, files and
 *      diff (cut to a few KB), and the failing output.
 *   2. Make a disposable worktree with the failing combination merged (git.ts), for Droid to explore.
 *   3. add_diagnosis_step(id, source, "status", "started")
 *   4. diagnosis = await diagnoseWithDroid(ctx, onStep) when DIAGNOSE_WITH is "droid" and
 *      FACTORY_API_KEY is set. If that's null: add a "status" step "Droid unavailable, asking
 *      Claude", then diagnosis = await diagnoseWithClaude(ctx).
 *   5. If there's a diagnosis: set_explanation(id, `${summary} ${suggestion}`), and keep `fact` in the
 *      watcher's memory for resolve_conflict. If not: add an "error" step "diagnosis unavailable".
 *   6. finally: remove the worktree.
 *
 * HOW THE WATCHER CALLS IT (signature agreed between B and C; the body is C's)
 *   diagnose(request): Promise<Diagnosis | null>
 *     index.ts calls it for every new conflict, and again only when the conflict's error text
 *     changes. It never runs two at once for the same conflict: a newer request waits for the
 *     running one. A returned fact is kept in memory and passed to resolve_conflict later.
 *     request.shas are the failing combination's snapshots: merge them in that order onto
 *     request.mainSha to rebuild the failing tree (git.makeWorktree, then git.mergeInto per sha).
 *
 * NOTES
 *   - onStep writes add_diagnosis_step rows. Send at most 5 per second so the database and the UI
 *     stay smooth.
 *   - Resolve with null instead of throwing; the watcher logs a rejection and moves on.
 */
import type { ConflictRow } from "../../../shared/src/schema.ts";
import type { Diagnosis } from "./prompt.ts";

export interface DiagnoseRequest {
  /** The conflict row as report_conflict left it (id, pair, kind, fixer, locations, error). */
  conflict: ConflictRow;
  /** main's commit when the conflict was found. */
  mainSha: string;
  /** The failing combination's snapshot shas, in merge order. */
  shas: string[];
  /** check.describeFailures() of the failing run (cut to 4 KB), or the merge conflict's message. */
  failingOutput: string;
}

export async function diagnose(request: DiagnoseRequest): Promise<Diagnosis | null> {
  // TODO (C): steps 1-6 above.
  void request;
  return null;
}
