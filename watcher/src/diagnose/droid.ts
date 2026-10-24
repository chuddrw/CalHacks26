/**
 * watcher/src/diagnose/droid.ts
 *
 * WHAT IT'S FOR
 *   The Factory prize path. When the watcher reports a conflict, a Droid session investigates it
 *   in a disposable worktree that holds the failing combination: it can read files and run tsc,
 *   the tests, grep and git diff, but it can't edit anything. Every step it takes is streamed into
 *   SpacetimeDB (add_diagnosis_step), so the UI's Droid panel shows the work live. Its final answer
 *   is a Diagnosis (prompt.ts).
 *
 * OWNER: C. WHEN: Sat 14:00-19:00.
 * DONE WHEN: on the demo conflict, the Droid panel shows at least one tool call (e.g. running the
 *            failing test) and a final explanation within about 60 s, and the worktree is gone after.
 *
 * FACTORY'S JUDGING (external/factory-droid.txt), AND HOW WE MEET IT
 *   - Droid does work inside a running product: the watcher starts it with no human involved.
 *   - Our own trigger: a red check.
 *   - Permission control: edit tools disabled, risky commands rejected, disposable worktree.
 *   - Visible plan, steps and results: the Droid panel in the UI.
 *   - The README says where Droid is used.
 *
 * SDK (from docs.factory.com/sdk/typescript; check names against the installed version)
 *   import from "@factory/droid-sdk/node"; auth with FACTORY_API_KEY.
 *   createSession({ cwd, apiKey, modelId, disabledToolIds, permissionHandler, ... }) for a session,
 *   session.stream() to read messages (assistant text, tool calls and results, final result),
 *   session.close() in a finally block. listTools() shows the tool ids to disable; listModels()
 *   shows which models our account can pick (put the choice in DROID_MODEL_ID).
 *
 * STEPS
 *   1. createSession in ctx.worktree, with every edit/create/patch/write tool in disabledToolIds.
 *   2. permissionHandler: allow read-only commands (tsc, vitest, grep, cat, ls, git diff/show/log).
 *      Cancel everything else, git push / git commit / rm / npm install included.
 *   3. Send buildPrompt(ctx) plus "End with ONLY a JSON object with the fields summary, cause,
 *      suggestion, fact."
 *   4. For each streamed message, call onStep(kind, detail): assistant text is "thought", a tool
 *      call is "tool_call" (name plus short args), a tool result is "tool_result" (first 300
 *      characters), and the final result is "final". Cut each detail to 2 KB.
 *   5. Parse the JSON at the end of the final text. If it doesn't parse, use the whole text as the
 *      summary and leave the other fields empty.
 *   6. Stop after 90 s: close the session and return null, and index.ts falls back to Claude.
 */
import type { DiagnosisStepKind } from "../../../shared/src/schema.ts";
import type { Diagnosis, DiagnosisContext } from "./prompt.ts";

export type OnStep = (kind: DiagnosisStepKind, detail: string) => void;

/** Returns null on timeout, SDK error, or a missing FACTORY_API_KEY. */
export async function diagnoseWithDroid(ctx: DiagnosisContext, onStep: OnStep): Promise<Diagnosis | null> {
  // TODO (C): steps 1-6 above.
  void ctx;
  void onStep;
  return null;
}
