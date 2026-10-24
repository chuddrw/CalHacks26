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
 * NOTES
 *   - One diagnosis at a time per conflict. If the same conflict is updated (still red after a fix
 *     attempt), don't start a second one unless the error text changed.
 *   - onStep writes add_diagnosis_step rows. Send at most 5 per second so the database and the UI
 *     stay smooth.
 */

// TODO (C): steps 1-6 above.
export {};
