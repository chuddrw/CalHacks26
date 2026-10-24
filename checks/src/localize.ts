/**
 * checks/src/localize.ts
 *
 * WHAT IT'S FOR
 *   When the full check (main + everyone's snapshot) is red, this finds out WHO clashes with WHOM.
 *   It tests each snapshot alone and then in pairs, and returns one failure per culprit set.
 *   This is the technical core of the project: speculative merging of uncommitted work.
 *
 * OWNER: B. WHEN: Sat 14:00-19:00.
 * DONE WHEN: on the demo scenario it returns exactly one failure, { kind: "pair", agents: [a, b] },
 *            in under 15 s, with 1-2 new check runs thanks to the cache.
 *            (Fixture: one failure, 1 new check run, about 1 s.)
 *
 * WHAT IT EXPORTS
 *   new Checker()                   the cache and the worktree work, one per watcher process
 *     .check(main, snapshots)       main + the snapshots merged in agent order, then check.ts.
 *                                   { result, fresh }: fresh is false when it came from the cache.
 *     .baseline(main)               failure signatures of main by itself, or null if main's check
 *                                   crashed (nothing can be judged then)
 *   localize(main, snapshots, full, checker, onRun): Promise<Failure[]>
 *     onRun is called with every fresh single or pair, to report its check_run row.
 *
 * ALGORITHM
 *   input: main sha, latest snapshots S = { agent: sha }, and the red full-check result
 *   1. Singles: for each agent, check main + S[agent]. Red means { kind: "self", agents: [agent] },
 *      and a single that doesn't merge onto main is "self" too (the agent needs to pull main).
 *   2. Candidates = agents that are green alone.
 *   3. Pairs: for each pair of candidates, check main + S[a] + S[b]. If mergeInto() fails, that's
 *      { kind: "merge", agents: [a, b], files }. If the check is red, that's { kind: "pair", agents: [a, b] }.
 *   4. If nothing so far explains the red full check (it takes 3 or more snapshots together):
 *      report the two most recent pushers as a pair, with the full check's error and the note
 *      "needs 3+ changes together". Rare; don't spend time on it.
 *
 * RED MEANS NEW
 *   Every result is compared with main by itself (Checker.baseline): failures main already has
 *   don't make anyone red. If main's own check crashes, the watcher skips the run and says so.
 *
 * CACHE
 *   Key every result by main's sha plus runKey(shas) from shared/src/schema.ts. A sha never changes
 *   content, so cached results never expire while the watcher runs. The full run and the singles
 *   and pairs share the cache: in the demo, b alone was the previous full run and a x b is this
 *   full run, so localizing costs one new run (a alone).
 *
 * SPEED
 *   Up to 3 checks at once, one per pooled worktree (git.ts). Each fresh single and pair is
 *   reported through onRun as it finishes, so the UI timeline moves.
 */
import { runKey, type AgentName, type ConflictKind } from "../../shared/src/schema.ts";
import { failureSignatures, runChecks, withoutKnown, type CheckOutcome } from "./check.ts";
import { mergeInto, resetWorktree, withWorktree } from "./git.ts";

export interface Snapshot {
  agent: AgentName;
  sha: string;
  createdAt: number;
}

export interface Combination {
  /** runKey(shas). */
  key: string;
  /** Sorted by name; shas in the same order. */
  agents: AgentName[];
  shas: string[];
  /** null when the snapshots didn't merge. */
  outcome: CheckOutcome | null;
  /** The files git couldn't merge, [] when the merge worked. */
  mergeFiles: string[];
  /** The agent whose snapshot didn't merge (the last one merged), "" when the merge worked. */
  mergeAgent: AgentName;
  /** Red compared with main by itself: a failed merge or at least one failure main doesn't have. */
  red: boolean;
  /** Seconds the check took. */
  seconds: number;
}

export interface Failure {
  kind: ConflictKind;
  /** Sorted by name: agentA, then agentB. */
  agents: AgentName[];
  /** The failing combination's snapshots, in merge order. */
  snapshots: Snapshot[];
  runKey: string;
  /** New failures only. null for a failed merge. */
  outcome: CheckOutcome | null;
  mergeFiles: string[];
  /** "" or "needs 3+ changes together". */
  note: string;
}

export class Checker {
  private readonly runs = new Map<string, Promise<Combination>>();
  private readonly baselines = new Map<string, Promise<Set<string> | null>>();

  /** Failure signatures of main by itself, or null if its check crashed. */
  baseline(main: string): Promise<Set<string> | null> {
    let known = this.baselines.get(main);
    if (!known) {
      known = withWorktree(async (dir) => {
        await resetWorktree(dir, main);
        const outcome = await runChecks(dir);
        if (outcome.crash && outcome.tscErrors.length === 0 && outcome.testFails.length === 0) {
          throw new Error(`main's own check crashed: ${outcome.crash}`);
        }
        return new Set(failureSignatures(outcome));
      }).catch((error: unknown) => {
        this.baselines.delete(main);
        console.error(`[cowork] ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      this.baselines.set(main, known);
    }
    return known;
  }

  /** main + the snapshots, checked once per main sha and set of snapshot shas. */
  async check(main: string, snapshots: Snapshot[]): Promise<{ result: Combination; fresh: boolean }> {
    const ordered = [...snapshots].sort((x, y) => x.agent.localeCompare(y.agent));
    const id = `${main}:${runKey(ordered.map((snapshot) => snapshot.sha))}`;
    const cached = this.runs.get(id);
    if (cached) return { result: await cached, fresh: false };
    const run = this.run(main, ordered);
    this.runs.set(id, run);
    try {
      return { result: await run, fresh: true };
    } catch (error) {
      this.runs.delete(id);
      throw error;
    }
  }

  private async run(main: string, ordered: Snapshot[]): Promise<Combination> {
    const known = await this.baseline(main);
    if (!known) throw new Error("main can't be checked, so nothing can be judged until it changes");
    const started = Date.now();
    const shas = ordered.map((snapshot) => snapshot.sha);
    const base = {
      key: runKey(shas),
      agents: ordered.map((snapshot) => snapshot.agent),
      shas,
    };
    return withWorktree(async (dir) => {
      await resetWorktree(dir, main);
      for (const snapshot of ordered) {
        const merged = await mergeInto(dir, snapshot.sha);
        if (!merged.ok) {
          return {
            ...base,
            outcome: null,
            mergeFiles: merged.files,
            mergeAgent: snapshot.agent,
            red: true,
            seconds: (Date.now() - started) / 1000,
          };
        }
      }
      const outcome = withoutKnown(await runChecks(dir), known);
      return { ...base, outcome, mergeFiles: [], mergeAgent: "", red: !outcome.ok, seconds: (Date.now() - started) / 1000 };
    });
  }
}

export async function localize(
  main: string,
  snapshots: Snapshot[],
  full: Combination,
  checker: Checker,
  onRun: (result: Combination) => void,
): Promise<Failure[]> {
  const check = async (group: Snapshot[]): Promise<Combination> => {
    const { result, fresh } = await checker.check(main, group);
    if (fresh) onRun(result);
    return result;
  };

  const failures: Failure[] = [];
  const ordered = [...snapshots].sort((x, y) => x.agent.localeCompare(y.agent));
  const singles = await Promise.all(ordered.map((snapshot) => check([snapshot])));
  const candidates: Snapshot[] = [];
  singles.forEach((result, index) => {
    const snapshot = ordered[index]!;
    if (result.red) failures.push(failureOf("self", [snapshot], result));
    else candidates.push(snapshot);
  });

  const pairs: Snapshot[][] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) pairs.push([candidates[i]!, candidates[j]!]);
  }
  const pairResults = await Promise.all(pairs.map((pair) => check(pair)));
  pairResults.forEach((result, index) => {
    if (result.red) failures.push(failureOf(result.outcome ? "pair" : "merge", pairs[index]!, result));
  });

  if (failures.length === 0 && full.red && ordered.length >= 2) {
    const recent = [...ordered].sort((x, y) => y.createdAt - x.createdAt).slice(0, 2);
    failures.push({ ...failureOf(full.outcome ? "pair" : "merge", recent, full), note: "needs 3+ changes together" });
  }
  return failures;
}

function failureOf(kind: ConflictKind, snapshots: Snapshot[], result: Combination): Failure {
  const ordered = [...snapshots].sort((x, y) => x.agent.localeCompare(y.agent));
  return {
    kind,
    agents: ordered.map((snapshot) => snapshot.agent),
    snapshots: ordered,
    runKey: result.key,
    outcome: result.outcome,
    mergeFiles: result.mergeFiles,
    note: "",
  };
}
