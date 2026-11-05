/**
 * adapters/core/publication.ts
 *
 * WHAT IT'S FOR
 *   The adapter-agnostic publication state machine, generalized from adapters/codex/publication.ts.
 *   A snapshot is pushed to Git first, then reported to SpacetimeDB (post_snapshot, then post_intent).
 *   Each step is written to a durable "pending" record before it runs, so a database failure after
 *   a Git push is retried on the next call instead of being forgotten.
 *
 * PURE: every side effect comes in through PublicationDeps, so tests never touch Git or the network.
 *
 * ALSO HERE
 *   quietStep(): the publisher's "no change for N cycles => Done" rule, as a pure function.
 */
import type { Snapshot } from '../../hooks/src/lib/snapshot.ts';

export interface Publication {
  pending?: { snapshot: Snapshot; intent: string; snapshotReported?: boolean };
  lastPublished?: { snapshot: Snapshot; intent: string };
}

export interface PublicationDeps {
  snapshot(): Promise<Snapshot | null>;
  read(): Publication;
  write(state: Publication): void;
  reportSnapshot(snapshot: Snapshot): Promise<void>;
  reportIntent(summary: string, files: string[]): Promise<void>;
}

export interface SyncResult { published: boolean; sha: string | null; busy?: boolean }

const MAX_INTENT = 500;

/** "<Label> editing a, b, c, d and 3 more files" (the default intent when none is given). */
export function defaultIntent(label: string, files: string[]): string {
  const more = files.length > 4 ? ` and ${files.length - 4} more files` : '';
  return `${label} editing ${files.slice(0, 4).join(', ')}${more}`;
}

/** Complete interrupted database publication before taking another snapshot. */
export async function publishWork(deps: PublicationDeps, label: string, intent?: string, forceReport = false): Promise<SyncResult> {
  const state = deps.read();
  const flush = async () => {
    const pending = state.pending;
    if (!pending) return;
    if (!pending.snapshotReported) {
      await deps.reportSnapshot(pending.snapshot);
      pending.snapshotReported = true;
      deps.write(state);
    }
    await deps.reportIntent(pending.intent, pending.snapshot.files);
    state.lastPublished = { snapshot: pending.snapshot, intent: pending.intent };
    delete state.pending;
    deps.write(state);
  };
  let published = Boolean(state.pending);
  await flush();
  const snapshot = await deps.snapshot();
  if (snapshot) {
    const summary = intent?.trim() || defaultIntent(label, snapshot.files);
    state.pending = { snapshot, intent: summary.slice(0, MAX_INTENT) };
    deps.write(state);
    await flush();
    published = true;
  } else if (state.lastPublished && (forceReport || (intent && intent !== state.lastPublished.intent))) {
    // Same code, new intent (or a database reset): re-report without another Git push.
    state.pending = { snapshot: state.lastPublished.snapshot,
      intent: (intent || state.lastPublished.intent).slice(0, MAX_INTENT), snapshotReported: !forceReport };
    deps.write(state);
    await flush();
    published = true;
  }
  return { published, sha: state.lastPublished?.snapshot.sha ?? null };
}

export interface QuietState { observedSha?: string | null; quietCycles: number; completedSha?: string }

/**
 * One publisher cycle of the quiet-period rule. Returns the next state and, when the same published
 * snapshot has stayed unchanged for `limit` cycles, the sha to mark Done (once per sha).
 */
export function quietStep(state: QuietState, result: SyncResult, limit: number): { state: QuietState; done?: string } {
  if (result.busy) return { state };
  if (result.sha !== state.observedSha) return { state: { observedSha: result.sha, quietCycles: 0 } };
  if (result.published || !result.sha || state.completedSha === result.sha) return { state };
  const quietCycles = state.quietCycles + 1;
  if (quietCycles < limit) return { state: { ...state, quietCycles } };
  return { state: { ...state, quietCycles, completedSha: result.sha }, done: result.sha };
}
