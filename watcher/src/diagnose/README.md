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
  setExplanation: (...args) => databaseSetExplanation(...args),
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
// resolve_conflict after deterministic checks confirm that exact conflict is green.
```

The identifiers `makeDedicatedDiagnosisWorktree`, `removeOnlyThatDiagnosisWorktree`, and `database*` above are illustrative injected operations, not new exports B is required to adopt. Capture the owned path in the cleanup closure. Never use B's `removeAllWorktrees()` here. Supply each side's intent, files and diff from the snapshots belonging to this run; the runner does not choose snapshots or subscribe to intents. The injected lease provider must capture those immutable snapshot SHAs or look them up from a saved run record keyed by `conflict.runKey`; do not merge whichever snapshots happen to be latest when diagnosis starts.

The reducer callback argument order is checked against `ReducerArgs`. Async database callbacks should resolve after accepting the write and reject on failure. Database failures propagate after cleanup. Worktree cleanup failures also propagate. Catch the returned promise in watcher orchestration.

Repeated calls for the same conflict/error share one run. Changed errors serialize behind the old run, whose stale output is suppressed. Call `runner.invalidate(id)` on resolution/reset. Current-conflict checks also suppress stale queued steps, explanations and returned facts. A new run/fixer with identical error does not launch a second model call and returns no cached fact; this follows the plan's same-error deduplication rule. Existing records are retained for deduplication for the runner's lifetime.

Mode defaults to `config.diagnoseWith`. Droid gets 90 seconds, including session startup; unavailable/failed Droid falls back to Claude. Claude has a 20-second request timeout and no automatic retries. Missing credentials return no diagnosis. If both providers fail, the runner writes a `diagnosis unavailable` step. Steps are serialized at five per second, capped at 500 per attempt and 2 KB of UTF-8 each. Facts remain proposals until the green check.

Droid runs with autonomy off, discovered editing/connector tools disabled, and a deny-by-default command grammar. It allows native Read/Grep/Glob/LS and restricted Execute commands. Supported checks use `./node_modules/.bin/tsc --noEmit --incremental false` and `./node_modules/.bin/vitest run [relative-test-path]`. Git read commands must include `--no-ext-diff --no-textconv` immediately after `diff`, `show` or `log`. Shell compound commands, redirection, substitution, arbitrary programs and modifying options are rejected. Project checks execute project code inside the disposable worktree; this is permission control, not an operating-system sandbox.

Runtime dependencies are already listed by root `npm run setup`: `@factory/droid-sdk`, `@anthropic-ai/sdk`, and Zod 3.25+ (for `zod/v4`). A working Factory `droid` CLI and `FACTORY_API_KEY` are needed for the Droid path; `ANTHROPIC_API_KEY` is needed for Claude. Set `DROID_MODEL_ID` and `CLAUDE_MODEL` through the existing configuration. APIs were type-checked against installed Factory 0.10.0 SDK declarations and Anthropic 1.3.0; no paid live calls were made.

Run isolated regressions after dependencies are installed:

```sh
node --test watcher/src/diagnose/diagnose.test.ts
```
