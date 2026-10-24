<!-- Part C integration contract for Part B; no watcher orchestration is implemented here. -->
# Diagnosis integration

`createDiagnosisRunner` accepts plain frozen-schema rows and injected operations. It does not import B's `git.ts`, `stdb.ts` or `index.ts`. Example inside B's eventual watcher wiring:

```ts
import { createDiagnosisRunner } from "./diagnose/index.ts";

const runner = createDiagnosisRunner({
  // Create/merge a dedicated worktree for these exact snapshot SHAs before returning.
  // If acquisition fails, this function must clean up its partial worktree itself.
  acquireWorktree: async (input) => ({
    path: await makeDedicatedDiagnosisWorktree(input),
    cleanup: async () => removeOnlyThatDiagnosisWorktree(),
  }),
  addDiagnosisStep: (...args) => databaseAddDiagnosisStep(...args),
  setExplanationIfCurrent: (...args) => databaseSetExplanationIfCurrent(...args),
  isCurrent: (input) => {
    const latest = findCurrentConflict(input.conflict.id);
    return latest !== undefined
      && (latest.status === "open" || latest.status === "escalated")
      && latest.error === input.conflict.error
      && latest.runKey === input.conflict.runKey
      && latest.fixer === input.conflict.fixer;
  },
});

const result = await runner.diagnose({ conflict, sides, failingOutput });
// Keep result?.fact locally, keyed to this conflict/run. Only pass it to
// resolve_conflict_if_current after storing a green check for the current snapshots.
```

The identifiers `makeDedicatedDiagnosisWorktree`, `removeOnlyThatDiagnosisWorktree`, and `database*` above are illustrative injected operations, not new exports B is required to adopt. Capture the owned path in the cleanup closure. Never use B's `removeAllWorktrees()` here. Supply each side's intent, files and diff from the snapshots belonging to this run; the runner does not choose snapshots or subscribe to intents. The injected lease provider must capture those immutable snapshot SHAs or look them up from a saved run record keyed by `conflict.runKey`; do not merge whichever snapshots happen to be latest when diagnosis starts.

The reducer callback argument order is checked against `ReducerArgs`. `setExplanationIfCurrent` is required and takes `(conflictId, expectedRunKey, expectedError, expectedFixer, explanation)`, matching `set_explanation_if_current`. Wire it to that guarded reducer; there is no legacy `set_explanation` fallback. The database atomically compares the expected run, error and fixer on an open/escalated conflict before writing, so a delayed old request cannot overwrite a newer conflict. Local `isCurrent` checks suppress work and returned facts, but cannot replace that atomic database guard. Async database callbacks should resolve after accepting the write and reject on failure. Database failures propagate after cleanup. Worktree cleanup failures also propagate. Catch the returned promise in watcher orchestration.

For resolution, B must call `resolve_conflict_if_current(conflictId, expectedRunKey, expectedError, expectedFixer, verifiedRunKey, verifiedFact)`. The expected fields identify the diagnosed conflict; `verifiedRunKey` identifies the stored green check covering its participants at their latest snapshots. Stale or terminal conflict versions do nothing. Post snapshots and their red check before `report_conflict`; obsolete runs cannot create or reopen conflicts. Existing reducer argument orders remain available, but legacy explanation writes do not provide revision protection.

Repeated calls for the same conflict/error share one active attempt. Successful results remain deduplicated. Rejected or unavailable attempts become retryable after cleanup, so a later call can recover from temporary worktree, provider or database failures without manual invalidation. Completion of an older failed attempt never invalidates a newer replacement. Changed errors serialize behind the old run, whose stale output is suppressed. Call `runner.invalidate(id)` on resolution/reset. Current-conflict checks also suppress stale queued steps, explanations and returned facts. An active or successful attempt for the same error but a different run/fixer supplies no cached fact and does not launch a parallel model call. Existing records are retained for deduplication for the runner's lifetime.

Mode defaults to `config.diagnoseWith`. Droid receives an abort signal after 90 seconds, including session startup; this is an abort threshold, not a hard total completion deadline. The adapter waits for SDK session teardown before returning, and a slow teardown can delay fallback. Cleanup is deliberately awaited so the runner does not remove a worktree still used by Droid. Unavailable/failed Droid then falls back to Claude. Claude has a 20-second request timeout and no automatic retries. Missing credentials return no diagnosis. If both providers fail, the runner writes a `diagnosis unavailable` step. Steps are serialized at five per second, capped at 500 per attempt and 2 KB of UTF-8 each. Facts remain proposals until the green check.

Droid runs with autonomy off, discovered editing/connector tools disabled, and a deny-by-default command grammar. It allows native Read/Grep/Glob/LS and restricted Execute commands. Supported checks use `./node_modules/.bin/tsc --noEmit --incremental false` and `./node_modules/.bin/vitest run [relative-test-path]`. Git read commands must include `--no-ext-diff --no-textconv` immediately after `diff`, `show` or `log`. Shell compound commands, redirection, substitution, arbitrary programs and modifying options are rejected. Project checks execute project code inside the disposable worktree; this is permission control, not an operating-system sandbox.

Runtime dependencies are already listed by root `npm run setup`: `@factory/droid-sdk`, `@anthropic-ai/sdk`, and Zod 3.25+ (for `zod/v4`). A working Factory `droid` CLI and `FACTORY_API_KEY` are needed for the Droid path; `ANTHROPIC_API_KEY` is needed for Claude. Set `DROID_MODEL_ID` and `CLAUDE_MODEL` through the existing configuration. APIs were type-checked against installed Factory 0.10.0 SDK declarations and Anthropic 1.3.0; no paid live calls were made.

Run isolated regressions after dependencies are installed:

```sh
node --test orchestrator/src/diagnose/diagnose.test.ts
```
