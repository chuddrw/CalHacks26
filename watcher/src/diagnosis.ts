/**
 * watcher/src/diagnosis.ts
 *
 * WHAT IT'S FOR
 *   The bridge between B's watcher loop and C's diagnosis runner. B's index.ts calls
 *   diagnose(request), the signature B and C agreed on. C's runner (diagnose/index.ts) deliberately
 *   imports nothing from B, and asks instead for its dependencies. This file supplies them from B's
 *   own git.ts and stdb.ts:
 *     acquireWorktree           a dedicated worktree: main + the failing snapshots merged in order
 *     addDiagnosisStep          one step for the UI's Droid panel
 *     setExplanationIfCurrent   C's guarded write (stale results are ignored by the module)
 *     isCurrent                 the conflict is still open with the same run, error and fixer
 *   It also builds each side's intent, files and diff, which C's prompt needs and B's request
 *   doesn't carry.
 *
 * OWNER: B (wiring), with C's runner. Written during the A+B+C integration on Oct 24.
 *
 * NOTES
 *   - Facts come back to index.ts, which only publishes one through resolve_conflict_if_current
 *     after a green check (C: "only B's later green check may publish them as verified memory").
 *   - invalidateDiagnosis() on resolution makes a still-running diagnosis finish without writing.
 *   - The worktree is made per diagnosis (not from B's check pool), so a slow model never blocks
 *     the checks; the runner always calls cleanup, which removes it.
 */
import type { ConflictRow } from "../../shared/src/schema.ts";
import { createDiagnosisRunner, type DiagnosisInput } from "./diagnose/index.ts";
import type { Diagnosis, DiagnosisSide } from "./diagnose/prompt.ts";
import * as git from "./git.ts";
import * as stdb from "./stdb.ts";

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

const DIFF_LIMIT = 8 * 1024;
/** Conflict id -> the request whose worktree the runner will ask for. */
const requests = new Map<number, DiagnoseRequest>();

const runner = createDiagnosisRunner({
  acquireWorktree: async (input) => {
    const request = requests.get(input.conflict.id);
    if (!request) throw new Error(`no diagnosis request for conflict #${input.conflict.id}`);
    const dir = await git.makeWorktree(`diag-${input.conflict.id}-${Date.now()}`);
    try {
      await git.resetWorktree(dir, request.mainSha);
      for (const sha of request.shas) {
        // A "merge" conflict stops here: Droid then sees the tree up to the clash.
        if (!(await git.mergeInto(dir, sha)).ok) break;
      }
    } catch (error) {
      await git.removeWorktree(dir);
      throw error;
    }
    return { path: dir, cleanup: () => git.removeWorktree(dir) };
  },
  addDiagnosisStep: (...args) => stdb.addDiagnosisStep(...args),
  setExplanationIfCurrent: (...args) => stdb.setExplanationIfCurrent(...args),
  isCurrent: (input) => {
    const latest = stdb.conflictById(input.conflict.id);
    return latest !== undefined
      && (latest.status === "open" || latest.status === "escalated")
      && latest.error === input.conflict.error
      && latest.runKey === input.conflict.runKey
      && latest.fixer === input.conflict.fixer;
  },
});

function sideOf(agent: string): DiagnosisSide {
  const snapshot = stdb.latestSnapshots().get(agent);
  return {
    agent,
    intent: stdb.latestIntent(agent)?.summary ?? "",
    files: snapshot?.files ?? [],
    diff: (snapshot?.diff ?? "").slice(0, DIFF_LIMIT),
  };
}

/** Diagnoses one conflict. Resolves to null when unavailable or superseded; never throws on purpose. */
export async function diagnose(request: DiagnoseRequest): Promise<Diagnosis | null> {
  const { conflict } = request;
  requests.set(conflict.id, request);
  const agents = [conflict.agentA, conflict.agentB].filter((agent) => agent !== "");
  const input: DiagnosisInput = { conflict, sides: agents.map(sideOf), failingOutput: request.failingOutput };
  try {
    return await runner.diagnose(input);
  } finally {
    if (requests.get(conflict.id) === request) requests.delete(conflict.id);
  }
}

/** Call when a conflict resolves or the database resets: a running diagnosis then writes nothing. */
export function invalidateDiagnosis(conflictId: number): void {
  runner.invalidate(conflictId);
}
