/**
 * watcher/src/diagnose/prompt.ts
 *
 * WHAT IT'S FOR
 *   One prompt and one output shape for both diagnosis paths (Droid and the Claude fallback), so
 *   the UI and the hooks get the same fields no matter which one ran.
 *
 * OWNER: C. WHEN: Sat 14:00-19:00.
 * DONE WHEN: on the demo scenario, both Droid and Claude return a summary that names the unit
 *            mismatch (seconds vs milliseconds) and a fact like "User.lastLogin is milliseconds".
 *
 * OUTPUT FIELDS (Diagnosis)
 *   summary     one sentence for the big screen
 *   cause       2-4 sentences: what each change assumed, and why the two don't fit
 *   suggestion  the smallest change the FIXER should make, in the fixer's own files
 *   fact        one sentence that would have prevented this if both agents had known it,
 *               e.g. "User.lastLogin is milliseconds since the Unix epoch." Empty if there isn't one.
 *
 * Red or green and who fixes are decided by the watcher's rules, not by this prompt. The model
 * only explains.
 */
import type { AgentName, ConflictRow } from "../../../shared/src/schema.ts";

export interface Diagnosis {
  summary: string;
  cause: string;
  suggestion: string;
  fact: string;
}

export interface DiagnosisSide {
  agent: AgentName;
  /** Latest intent this agent posted, or "" if it never posted one. */
  intent: string;
  files: string[];
  /** The agent's diff against main, already cut to a few KB. */
  diff: string;
}

export interface DiagnosisContext {
  conflict: ConflictRow;
  /** One side for kind "self", two for "pair" and "merge". */
  sides: DiagnosisSide[];
  /** tsc + vitest output of the failing combination, cut to 4 KB. */
  failingOutput: string;
  /** Path of the disposable worktree with the failing combination checked out (Droid works there). */
  worktree: string;
}

const KIND_TEXT: Record<ConflictRow["kind"], string> = {
  self: "One teammate's uncommitted change fails the type check or the tests on its own.",
  merge: "Two teammates' uncommitted changes edit the same lines, so git cannot merge them.",
  pair: "Two teammates' uncommitted changes each pass on their own, but the type check or tests fail when both are merged onto main.",
};

export function buildPrompt(ctx: DiagnosisContext): string {
  const sides = ctx.sides
    .map((side) =>
      [
        `## Change by ${side.agent}`,
        `Stated intent: ${side.intent || "(none posted)"}`,
        `Files: ${side.files.join(", ") || "(none)"}`,
        "Diff against main:",
        "```diff",
        side.diff,
        "```",
      ].join("\n"),
    )
    .join("\n\n");

  return [
    "You are diagnosing a break in a team's TypeScript repo. Each teammate has an AI coding agent working on its own laptop, and a checker merges everyone's uncommitted work onto main to catch breaks early.",
    "",
    `What happened: ${KIND_TEXT[ctx.conflict.kind]}`,
    `The watcher's rule picked ${ctx.conflict.fixer} to fix it. Write your suggestion for ${ctx.conflict.fixer}, in ${ctx.conflict.fixer}'s own files.`,
    "",
    sides,
    "",
    "## Failing output",
    "```",
    ctx.failingOutput,
    "```",
    "",
    "Explain the cause in plain language for the agent who must fix it. Don't suggest editing or deleting tests unless a test is clearly wrong, and say so explicitly if you think it is.",
    "Return these fields:",
    "- summary: one sentence a person can read on a big screen.",
    "- cause: 2-4 sentences on what each change assumed and why they don't fit together.",
    "- suggestion: the smallest change the fixer should make.",
    "- fact: one sentence that would have prevented this if both agents had known it, or an empty string.",
  ].join("\n");
}
