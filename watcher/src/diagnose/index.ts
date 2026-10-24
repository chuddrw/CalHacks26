/** Part C diagnosis runner. B injects database calls, current-conflict checks and an owned worktree lease.
 * No watcher orchestration, subscriptions or shared worktrees are mutated here. Proposed facts are
 * returned to the caller; only B's later green check may publish them as verified memory.
 */
import { config } from "../../../shared/src/config.ts";
import type { DiagnosisSource, ReducerArgs } from "../../../shared/src/schema.ts";
import type { Diagnosis, DiagnosisContext } from "./prompt.ts";
import { truncateUtf8 } from "./text.ts";
import type { OnStep } from "./droid.ts";

export type DiagnosisInput = Omit<DiagnosisContext, "worktree">;
export interface WorktreeLease {
  path: string;
  /** Removes this diagnosis worktree only. Must also handle a failed merge. */
  cleanup(): Promise<void>;
}
export interface DiagnosisDependencies {
  acquireWorktree(context: DiagnosisInput): Promise<WorktreeLease>;
  addDiagnosisStep(...args: ReducerArgs["add_diagnosis_step"]): Promise<void>;
  setExplanation(...args: ReducerArgs["set_explanation"]): Promise<void>;
  /** Return false after resolution or if the database's error/run no longer matches this input. */
  isCurrent(context: DiagnosisInput): boolean;
  mode?: DiagnosisSource;
  droid?: (context: DiagnosisContext, onStep: OnStep) => Promise<Diagnosis | null>;
  claude?: (context: DiagnosisContext) => Promise<Diagnosis | null>;
}

/** Per-conflict serialization prevents overlapping sessions. Changed errors supersede old results. */
export function createDiagnosisRunner(deps: DiagnosisDependencies) {
  const entries = new Map<number, { error: string; runKey: string; fixer: string; valid: boolean; token: object; result: Promise<Diagnosis | null> }>();

  function diagnose(input: DiagnosisInput): Promise<Diagnosis | null> {
    const context = structuredClone(input);
    const id = context.conflict.id;
    const previous = entries.get(id);
    if (previous?.valid && previous.error === context.conflict.error) {
      // Keep the plan's same-error deduplication without returning a fact from a different run/fixer.
      if (previous.runKey !== context.conflict.runKey || previous.fixer !== context.conflict.fixer || !deps.isCurrent(context)) return Promise.resolve(null);
      return previous.result;
    }
    const token = {};
    const current = () => entries.get(id)?.token === token && entries.get(id)?.valid === true && deps.isCurrent(context);
    const result = (async () => {
      // The microtask also lets the map entry be installed before current() is first called.
      await Promise.resolve();
      if (previous) await previous.result.catch(() => null);
      if (!current()) return null;
      let lease: WorktreeLease | undefined;
      let source: DiagnosisSource = deps.mode ?? config.diagnoseWith;
      let queue = Promise.resolve();
      let lastStep = 0;
      let count = 0;
      const step = (kind: ReducerArgs["add_diagnosis_step"][2], detail: string) => {
        if (!current() || count++ >= 500) return;
        const stepSource = source;
        queue = queue.then(async () => {
          const wait = Math.max(0, lastStep + 200 - Date.now());
          if (wait) await new Promise(resolve => setTimeout(resolve, wait));
          if (!current()) return;
          await deps.addDiagnosisStep(id, stepSource, kind, truncateUtf8(detail, 2048));
          lastStep = Date.now();
        });
        // Attach immediately: a slow model must not leave a failed DB call unhandled.
        void queue.catch(() => {});
      };
      try {
        lease = await deps.acquireWorktree(context);
        if (!current()) return null;
        const full = { ...context, worktree: lease.path };
        let diagnosis: Diagnosis | null = null;
        if (source === "droid") {
          step("status", "Droid diagnosis started");
          try {
            const droid = deps.droid ?? (await import("./droid.ts")).diagnoseWithDroid;
            diagnosis = await droid(full, step);
          } catch {
            step("error", "Droid unavailable");
          }
        }
        if (!diagnosis && current()) {
          source = "claude";
          step("status", "Asking Claude for diagnosis");
          try {
            const claude = deps.claude ?? (await import("./claude.ts")).diagnoseWithClaude;
            diagnosis = await claude(full);
          } catch {
            step("error", "Claude unavailable");
          }
        }
        if (!current()) return null;
        step(diagnosis ? "final" : "error", diagnosis ? diagnosis.summary : "diagnosis unavailable");
        await queue;
        if (!current() || !diagnosis) return null;
        await deps.setExplanation(id, [diagnosis.summary, diagnosis.cause, diagnosis.suggestion].filter(Boolean).join("\n\n"));
        return current() ? diagnosis : null;
      } finally {
        // Drain pending writes before releasing the lease, including exceptional paths.
        try { await queue; } finally { await lease?.cleanup(); }
      }
    })();
    entries.set(id, { error: context.conflict.error, runKey: context.conflict.runKey, fixer: context.conflict.fixer, valid: true, token, result });
    return result;
  }

  return {
    diagnose,
    /** Invalidate on resolution/reset; active sessions finish and clean up without publishing. */
    invalidate(conflictId: number) { const entry = entries.get(conflictId); if (entry) entry.valid = false; },
  };
}
