/**
 * checks/src/team-check.ts
 *
 * WHAT IT'S FOR
 *   One agent's combined check: the check_with_team tool (mcp/src/server.ts). It is the watcher's
 *   check, run by the agent that needs the answer, for its own pairs only:
 *     1. main + my latest snapshot alone.
 *     2. main + mine + each teammate's latest snapshot, always.
 *   Reading the results (verdict()):
 *     - mine green, a pair red, that teammate green alone: our two changes clash, so it opens a
 *       conflict thread with that teammate (report_conflict).
 *     - mine red, but green together with a teammate: a coordinated change (in the demo, a changes
 *       the contract and b adapts sessions; neither passes alone). Fine: they land together.
 *     - mine red and red with everyone: my own change is broken; no thread, I fix it myself.
 *   Every combination it runs becomes a check_run row (report_check), so the module can tell that a
 *   later agree or complete_task rests on a current green check. Git, tsc and vitest decide red or
 *   green here, never a model.
 *
 * OWNER: A (branch feat/orchestrator), on B's checks (git.ts, check.ts, localize.ts, map-errors.ts,
 *        fixer.ts).
 * DONE WHEN: on the demo scenario, b's check is green alone and red with a, and it opens one pair
 *            conflict a x b with b suggested (the error is in b's idle.ts).
 *
 * NOTES
 *   - Runs in the agent's own clone (git.useRepo), in pooled temporary worktrees; the clone's own
 *     working tree and index are never touched. node_modules is linked from the clone.
 *   - Results are cached per main sha and set of snapshot shas for the life of the process.
 *   - "Red" means new failures only: failures main already has don't count (Checker.baseline).
 */
import { pairKey, type AgentName, type ConflictKind, type SnapshotRow } from "../../shared/src/schema.ts";
import { describeFailures, firstError, type CheckOutcome } from "./check.ts";
import { pickFixer } from "./fixer.ts";
import * as git from "./git.ts";
import { Checker, type Combination, type Snapshot } from "./localize.ts";
import { mapFailure } from "./map-errors.ts";

export interface TeamCheckDeps {
  reportCheck(runKey: string, agents: AgentName[], result: "green" | "red", log: string): Promise<void>;
  reportConflict(kind: ConflictKind, agentA: AgentName, agentB: AgentName, locA: string, locB: string,
    error: string, fixer: AgentName, runKey: string): Promise<void>;
}

export interface PairResult {
  teammate: AgentName;
  run: Combination;
  /** Set when the pair is red. */
  clash?: { kind: ConflictKind; pair: string; fixer: AgentName; locA: string; locB: string; error: string };
  /** The teammate's own snapshot fails without mine, so it's their problem, not a clash. */
  theirsFailsAlone?: boolean;
}

export interface TeamCheckResult {
  main: string;
  /** null: I have no snapshot, or it changes nothing compared with main. */
  mine: Combination | null;
  pairs: PairResult[];
  /** Teammates whose snapshot commit couldn't be fetched. */
  missing: AgentName[];
}

const checker = new Checker();

/** `latest` is the newest snapshot row per agent, from the database. */
export async function checkWithTeam(me: AgentName, latest: Map<AgentName, SnapshotRow>, deps: TeamCheckDeps): Promise<TeamCheckResult> {
  await git.fetchWip();
  const main = await git.mainSha();
  const missing: AgentName[] = [];
  const changed: Snapshot[] = [];
  for (const [agent, row] of latest) {
    const sha = (await git.hasCommit(row.sha)) ? row.sha : await git.wipHead(agent);
    if (!sha) {
      missing.push(agent);
      continue;
    }
    if (await git.hasChanges(main, sha)) changed.push({ agent, sha, createdAt: row.createdAt });
  }
  const mineSnapshot = changed.find((snapshot) => snapshot.agent === me);
  const result: TeamCheckResult = { main, mine: null, pairs: [], missing };
  if (!mineSnapshot) return result;

  const report = async (run: Combination) =>
    deps.reportCheck(run.key, run.agents, run.red ? "red" : "green", logOf(run));
  result.mine = (await checker.check(main, [mineSnapshot])).result;
  await report(result.mine);

  for (const theirs of changed.filter((snapshot) => snapshot.agent !== me)) {
    const run = (await checker.check(main, [mineSnapshot, theirs])).result;
    await report(run);
    const pair: PairResult = { teammate: theirs.agent, run };
    result.pairs.push(pair);
    // Red together while mine fails alone too: that's my own change, not a clash.
    if (!run.red || result.mine.red) continue;
    const alone = (await checker.check(main, [theirs])).result;
    await report(alone);
    if (alone.red) {
      pair.theirsFailsAlone = true;
      continue;
    }
    pair.clash = await describeClash(main, run, [mineSnapshot, theirs]);
    const [agentA, agentB] = run.agents as [AgentName, AgentName];
    const { kind, locA, locB, error, fixer } = pair.clash;
    await deps.reportConflict(kind, agentA, agentB, locA, locB, error, fixer, run.key);
  }
  return result;
}

export type Verdict =
  /** No changes of mine compared with main. */
  | "nothing"
  /** Mine is green alone and with every teammate. */
  | "green"
  /** Mine fails alone but passes together with `with` (a coordinated change). */
  | "together"
  /** Mine fails alone and with everyone: my own change is broken. */
  | "mine_broken"
  /** Mine is green alone but clashes with at least one teammate. */
  | "clash";

export function verdict(result: TeamCheckResult): { verdict: Verdict; with: AgentName[] } {
  if (!result.mine) return { verdict: "nothing", with: [] };
  if (result.mine.red) {
    const together = result.pairs.filter((pair) => !pair.run.red).map((pair) => pair.teammate);
    return together.length ? { verdict: "together", with: together } : { verdict: "mine_broken", with: [] };
  }
  const clashes = result.pairs.filter((pair) => pair.clash).map((pair) => pair.teammate);
  return clashes.length ? { verdict: "clash", with: clashes } : { verdict: "green", with: [] };
}

/** Where each side's change is, whose code the error is in (the suggested agent), and the error text. */
async function describeClash(main: string, run: Combination, snapshots: Snapshot[]): Promise<NonNullable<PairResult["clash"]>> {
  const kind: ConflictKind = run.outcome ? "pair" : "merge";
  const shaOf = new Map(snapshots.map((snapshot) => [snapshot.agent, snapshot.sha]));
  const changedLines = new Map<AgentName, git.ChangedLines>();
  for (const snapshot of snapshots) changedLines.set(snapshot.agent, await git.changedLines(main, snapshot.sha));
  const mapped = await mapFailure({
    kind,
    agents: run.agents,
    outcome: run.outcome,
    mergeFiles: run.mergeFiles,
    changed: changedLines,
    readFile: (agent, file) => git.readFileAt(shaOf.get(agent) ?? main, file),
  });
  const lastPusher = [...snapshots].sort((x, y) => y.createdAt - x.createdAt)[0]!.agent;
  const fixer = pickFixer({ kind, agents: run.agents, errorOwner: mapped.errorOwner, lastPusher });
  const [agentA, agentB] = run.agents;
  const error = run.outcome
    ? (firstError(run.outcome)?.text ?? "The check failed without an error message.")
    : `git can't merge ${agentA}'s and ${agentB}'s changes: both edit the same lines in ${run.mergeFiles.join(", ")}.`;
  return { kind, pair: pairKey(agentA!, agentB!), fixer, locA: mapped.locA, locB: mapped.locB, error };
}

function logOf(run: Combination): string {
  if (!run.outcome) return `git merge failed (${run.mergeAgent}'s snapshot) with conflicts in: ${run.mergeFiles.join(", ")}`;
  return run.outcome.log;
}

/** Every failure of a red run as plain text (for the agent's tool result). */
export function failuresOf(outcome: CheckOutcome | null): string {
  return outcome ? describeFailures(outcome) : "";
}

/** Removes this process's worktrees. Call when the MCP server exits. */
export async function cleanup(): Promise<void> {
  await git.removeAllWorktrees();
}

/** Removes worktrees left behind by an earlier, killed process. Call once on start. */
export async function cleanupStale(): Promise<void> {
  await git.removeStaleWorktrees();
}
