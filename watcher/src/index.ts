/**
 * watcher/src/index.ts
 *
 * WHAT IT'S FOR
 *   The watcher's main loop: the part that turns "four agents editing on four laptops" into
 *   "red or green, who clashes with whom, and who fixes it". One copy runs on one machine for
 *   the whole team. Use a Mac or Linux laptop if possible (see git.ts about Windows links).
 *
 * OWNER: B. WHEN: Sat 9:20-13:00 (loop + full check), Sat 14:00-19:00 (pairs, fixer, diagnosis).
 * DONE WHEN: two agents' conflicting snapshots produce ONE conflict row with the right pair, fixer
 *            and file:line within 15 s of the second push, and the next green run resolves it.
 *            (Fixture: the a x b row lands about 5 s after a's push, 2 s of it the debounce, and
 *            step b-fix resolves it.)
 * USAGE: npm run watcher (from the repo root). Needs STDB_DB and DEMO_REPO_PATH; STDB_TOKEN is
 *        optional for the watcher. To try it without demo-app: watcher/src/fixture.ts.
 *
 * LOOP
 *   1. Connect (stdb.ts) and subscribe to snapshot, conflict and intent. Remove worktrees a killed
 *      watcher left behind. Run once at startup.
 *   2. On each new snapshot row, wait CHECK_DEBOUNCE_MS: agents edit in bursts.
 *   3. git.fetchWip(). latest = the newest snapshot per agent, skipping agents whose snapshot adds
 *      nothing to main (they're reported green). If a row's commit didn't arrive, wip/<agent> is used;
 *      if that's missing too, the agent is skipped and its conflicts are left as they are.
 *   4. Guard (guard.ts): for each open conflict whose fixer has a new snapshot, a fix that edits or
 *      deletes a test goes to flag_needs_human, before any check can resolve it.
 *   5. Full check: main + every latest snapshot (localize.ts Checker: git.ts + check.ts), compared
 *      with main by itself. Call report_check with the result.
 *   6. Green: resolve every open conflict (needs_human ones wait for a person). Pass the fact from
 *      that conflict's diagnosis (kept in memory here) to resolve_conflict.
 *   7. Red: localize.ts finds the failures (self, pair, merge), map-errors.ts the two locations and
 *      whose code the error is in, fixer.ts the fixer, and report_conflict records each one. A new
 *      conflict, or a changed error text, starts diagnose/index.ts without waiting for it.
 *      Open conflicts that aren't among the failures are resolved if their own snapshots now
 *      check green together.
 *   8. Sat 20:00 and later: deps.ts sends heads-ups to agents whose files import the changed files.
 *
 * RULES
 *   - One run at a time. Snapshots that arrive during a run trigger exactly one more run after it.
 *   - Red or green comes only from git + tsc + vitest, never from Droid or Claude.
 *   - Remove every temporary worktree on exit, Ctrl+C included (git.removeAllWorktrees()).
 *   - Facts from diagnoses live in memory only. If the watcher restarts mid-conflict, that conflict
 *     resolves without a fact. That's acceptable. Same if it resolves before its diagnosis ends.
 */
import { config, missingSettings } from "../../shared/src/config.ts";
import { pairKey, runKey, type AgentName, type ConflictRow, type SnapshotRow } from "../../shared/src/schema.ts";
import { describeFailures, firstError, INSTALL_TOOLS, missingTools } from "./check.ts";
import { diagnose, invalidateDiagnosis, type DiagnoseRequest } from "./diagnosis.ts";
import { pickFixer } from "./fixer.ts";
import * as git from "./git.ts";
import { guardFix } from "./guard.ts";
import { Checker, localize, type Combination, type Failure, type Snapshot } from "./localize.ts";
import { mapFailure } from "./map-errors.ts";
import * as stdb from "./stdb.ts";

const checker = new Checker();
/** Conflict id -> the verified fact from its diagnosis. */
const facts = new Map<number, string>();
/** Conflict id -> the error text it was last diagnosed for. */
const diagnosedFor = new Map<number, string>();
/** Conflict id -> the running diagnosis, and the newest request waiting behind it. */
const diagnosing = new Map<number, Promise<void>>();
const waitingDiagnosis = new Map<number, DiagnoseRequest>();
/** Conflict id -> the fixer snapshot the guard last looked at. */
const guarded = new Map<number, string>();
/** Agents whose snapshot commit couldn't be found, so the warning is printed once per sha. */
const missingWarned = new Set<string>();

let debounce: NodeJS.Timeout | null = null;
let running = false;
let again = false;
let exiting = false;

function log(message: string): void {
  console.log(`[watcher] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

// ---- Scheduling ---------------------------------------------------------------------------

function trigger(): void {
  if (exiting) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void runLoop();
  }, config.checkDebounceMs);
}

async function runLoop(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      try {
        await runOnce();
      } catch (error) {
        console.error(`[watcher] run failed: ${errorMessage(error)}`);
      }
    } while (again && !exiting);
  } finally {
    running = false;
  }
}

// ---- One run ------------------------------------------------------------------------------

async function runOnce(): Promise<void> {
  const started = Date.now();
  await git.fetchWip();
  const main = await git.mainSha();
  const rows = stdb.latestSnapshots();
  const shaOf = new Map<AgentName, string>();
  const latest: Snapshot[] = [];
  const unchanged: Snapshot[] = [];
  const unseen = new Set<AgentName>();
  for (const [agent, row] of rows) {
    const sha = await usableSha(agent, row);
    if (!sha) {
      unseen.add(agent);
      continue;
    }
    shaOf.set(agent, sha);
    const snapshot = { agent, sha, createdAt: row.createdAt };
    if (await git.hasChanges(main, sha)) latest.push(snapshot);
    else unchanged.push(snapshot);
  }
  const names = (list: Snapshot[]) => list.map((snapshot) => `${snapshot.agent} ${short(snapshot.sha)}`).join(", ");
  log(`run on main ${short(main)}: ${latest.length ? names(latest) : "no changes"}${unchanged.length ? ` (same as main: ${unchanged.map((s) => s.agent).join(", ")})` : ""}`);

  await guardFixes(main, shaOf);

  if (latest.length === 0) {
    const key = unchanged.length > 0 ? runKey(unchanged.map((s) => s.sha)) : "";
    if (key) await stdb.reportCheck(key, unchanged.map((s) => s.agent), "green", "No changes compared with main.");
    await resolveAll("nothing left to check", unseen, key);
    return;
  }

  // Part C only treats a check as current when its runKey is exactly the latest snapshot shas of
  // the agents it lists. So the full run is reported for the changed agents, and, when some agents
  // match main, once more for everyone: their snapshots change nothing, so the result is the same.
  const { result: full } = await checker.check(main, latest);
  await stdb.reportCheck(full.key, full.agents, full.red ? "red" : "green", logOf(full));
  const everyone = [...latest, ...unchanged];
  const everyoneKey = runKey(everyone.map((s) => s.sha));
  if (unchanged.length > 0) {
    await stdb.reportCheck(everyoneKey, everyone.map((s) => s.agent).sort(), full.red ? "red" : "green", logOf(full));
  }
  if (!full.red) {
    log(`green: ${full.agents.join(", ")} (${seconds(started)})`);
    await resolveAll("everything checks green together", unseen, everyoneKey);
    return;
  }

  log(`red: ${summary(full)}. Finding who clashes with whom...`);
  // report_conflict needs its red check already in the database, so wait for every report.
  const reports: Array<Promise<void>> = [];
  const failures = await localize(main, latest, full, checker, (run) => {
    log(`  ${run.agents.join(" + ")}: ${run.red ? `red, ${summary(run)}` : "green"} (${run.seconds.toFixed(1)} s)`);
    reports.push(
      stdb.reportCheck(run.key, run.agents, run.red ? "red" : "green", logOf(run)).catch((error) => {
        console.error(`[watcher] report_check failed: ${errorMessage(error)}`);
      }),
    );
  });
  await Promise.all(reports);
  for (const failure of failures) {
    try {
      await recordFailure(main, failure);
    } catch (error) {
      console.error(`[watcher] couldn't record the ${failure.agents.join(" x ")} conflict: ${errorMessage(error)}`);
    }
  }
  await resolveStale(main, latest, failures, unseen);
  log(`run done in ${seconds(started)}`);
}

/** The row's commit, or the fetched wip/<agent> if the row's commit didn't arrive. */
async function usableSha(agent: AgentName, row: SnapshotRow): Promise<string | null> {
  if (await git.hasCommit(row.sha)) return row.sha;
  const head = await git.wipHead(agent);
  if (!missingWarned.has(row.sha)) {
    missingWarned.add(row.sha);
    log(`${agent}'s snapshot ${short(row.sha)} isn't on ${config.gitRemote} yet; ${head ? `using wip/${agent} ${short(head)}` : "skipping it"}`);
  }
  return head;
}

// ---- Guard ----------------------------------------------------------------------------------

async function guardFixes(main: string, shaOf: Map<AgentName, string>): Promise<void> {
  for (const conflict of stdb.openConflicts()) {
    const after = shaOf.get(conflict.fixer);
    if (!after || guarded.get(conflict.id) === after) continue;
    const before = stdb
      .snapshotsOf(conflict.fixer)
      .filter((row) => row.createdAt <= conflict.createdAt)
      .at(-1);
    guarded.set(conflict.id, after);
    if (!before || before.sha === after) continue;
    if (!(await git.hasCommit(before.sha))) {
      log(`guard: can't find ${conflict.fixer}'s snapshot from before conflict #${conflict.id}; skipping the test check`);
      continue;
    }
    const teammates = [...shaOf].filter(([agent]) => agent !== conflict.fixer).map(([agent, sha]) => ({ agent, sha }));
    try {
      const edits = await guardFix({ conflict, before: before.sha, after, main, teammates });
      if (edits.length > 0) {
        log(`conflict #${conflict.id}: ${conflict.fixer}'s fix changed tests (${edits.map((e) => e.path).join(", ")}). Waiting for a person.`);
      }
    } catch (error) {
      guarded.delete(conflict.id);
      console.error(`[watcher] guard failed for conflict #${conflict.id}: ${errorMessage(error)}`);
    }
  }
}

// ---- Red: record each failure ---------------------------------------------------------------

async function recordFailure(main: string, failure: Failure): Promise<void> {
  const [agentA, agentB = ""] = failure.agents;
  if (!agentA) return;
  const shaOf = new Map(failure.snapshots.map((snapshot) => [snapshot.agent, snapshot.sha]));
  const changed = new Map<AgentName, git.ChangedLines>();
  for (const snapshot of failure.snapshots) changed.set(snapshot.agent, await git.changedLines(main, snapshot.sha));
  const mapped = await mapFailure({
    kind: failure.kind,
    agents: failure.agents,
    outcome: failure.outcome,
    mergeFiles: failure.mergeFiles,
    changed,
    readFile: (agent, file) => git.readFileAt(shaOf.get(agent) ?? main, file),
  });
  const lastPusher = [...failure.snapshots].sort((x, y) => y.createdAt - x.createdAt)[0]!.agent;
  const fixer = pickFixer({ kind: failure.kind, agents: failure.agents, errorOwner: mapped.errorOwner, lastPusher });
  const error = errorText(failure);
  const conflict = await stdb.reportConflict(failure.kind, agentA, agentB, mapped.locA, mapped.locB, error, fixer, failure.runKey);
  log(
    `conflict #${conflict.id} ${failure.kind} ${failure.agents.join(" x ")}, fixer ${fixer}` +
      ` (${mapped.locA || "?"}${agentB ? ` vs ${mapped.locB || "?"}` : ""})${failure.note ? ` [${failure.note}]` : ""}`,
  );
  requestDiagnosis({
    conflict,
    mainSha: main,
    shas: failure.snapshots.map((snapshot) => snapshot.sha),
    failingOutput: failure.outcome ? describeFailures(failure.outcome) : error,
  });
}

function errorText(failure: Failure): string {
  const [agentA, agentB] = failure.agents;
  const files = failure.mergeFiles.join(", ");
  let text: string;
  if (!failure.outcome && failure.kind === "self") {
    text = `${agentA}'s changes don't merge with the latest main (conflicts in ${files}). Pull main and resolve them.`;
  } else if (!failure.outcome) {
    text = `git can't merge ${agentA}'s and ${agentB}'s changes: both edit the same lines in ${files}.`;
  } else {
    text = firstError(failure.outcome)?.text ?? "The check failed without an error message.";
  }
  return failure.note ? `Only fails with 3 or more changes together.\n${text}` : text;
}

/** Starts a diagnosis for a new conflict or a changed error, never two at once per conflict. */
function requestDiagnosis(request: DiagnoseRequest): void {
  const id = request.conflict.id;
  if (diagnosedFor.get(id) === request.conflict.error) return;
  diagnosedFor.set(id, request.conflict.error);
  if (diagnosing.has(id)) {
    waitingDiagnosis.set(id, request);
    return;
  }
  const run = (next: DiagnoseRequest): Promise<void> =>
    diagnose(next)
      .then((diagnosis) => {
        if (diagnosis?.fact.trim()) facts.set(id, diagnosis.fact.trim());
      })
      .catch((error) => console.error(`[watcher] diagnosis of conflict #${id} failed: ${errorMessage(error)}`))
      .finally(() => {
        const waiting = waitingDiagnosis.get(id);
        waitingDiagnosis.delete(id);
        if (waiting && stdb.openConflicts().some((conflict) => conflict.id === id)) diagnosing.set(id, run(waiting));
        else diagnosing.delete(id);
      });
  diagnosing.set(id, run(request));
}

// ---- Resolving --------------------------------------------------------------------------------

/**
 * Resolves through Part C's guarded reducer: it only takes effect for this exact version of the
 * conflict (run, error, fixer) and a current green check covering both agents (verifiedRunKey).
 */
async function resolve(conflict: ConflictRow, why: string, verifiedRunKey: string): Promise<void> {
  const fact = facts.get(conflict.id) ?? "";
  if (!verifiedRunKey) {
    log(`conflict #${conflict.id} (${conflict.pair}) stays open: no green check covers it (${why})`);
    return;
  }
  await stdb.resolveConflictIfCurrent(conflict.id, conflict.runKey, conflict.error, conflict.fixer, verifiedRunKey, fact);
  if (stdb.conflictById(conflict.id)?.status !== "resolved") {
    log(`conflict #${conflict.id} (${conflict.pair}) stays open: the database didn't accept check ${verifiedRunKey.slice(0, 17)} as current, covering evidence`);
    return;
  }
  invalidateDiagnosis(conflict.id);
  log(`conflict #${conflict.id} (${conflict.pair}) resolved: ${why}${fact ? `. Fact: ${fact}` : ""}`);
  facts.delete(conflict.id);
  diagnosedFor.delete(conflict.id);
  waitingDiagnosis.delete(conflict.id);
  guarded.delete(conflict.id);
}

/** An agent whose snapshot commit couldn't be found can't be judged, so its conflicts stay as they are. */
function involves(conflict: ConflictRow, agents: Set<AgentName>): boolean {
  return agents.has(conflict.agentA) || (conflict.agentB !== "" && agents.has(conflict.agentB));
}

/** Green full check: every open conflict is over. needs_human ones wait for a person. */
async function resolveAll(why: string, unseen: Set<AgentName>, verifiedRunKey: string): Promise<void> {
  for (const conflict of stdb.openConflicts()) {
    if (!involves(conflict, unseen)) await resolve(conflict, why, verifiedRunKey);
  }
  for (const conflict of stdb.unresolvedConflicts()) {
    if (conflict.status === "needs_human") log(`conflict #${conflict.id} (${conflict.pair}) still needs a person`);
  }
}

/** Red full check: open conflicts that aren't among the failures resolve if their snapshots check green together. */
async function resolveStale(main: string, latest: Snapshot[], failures: Failure[], unseen: Set<AgentName>): Promise<void> {
  const failing = new Set(failures.map((failure) => pairKey(failure.agents[0]!, failure.agents[1] ?? "")));
  const byAgent = new Map(latest.map((snapshot) => [snapshot.agent, snapshot]));
  for (const conflict of stdb.openConflicts()) {
    if (failing.has(conflict.pair) || involves(conflict, unseen)) continue;
    const snapshots = [conflict.agentA, conflict.agentB]
      .filter((agent) => agent !== "")
      .map((agent) => byAgent.get(agent))
      .filter((snapshot): snapshot is Snapshot => snapshot !== undefined);
    if (snapshots.length === 0) {
      await resolve(conflict, "no changes left", "");
      continue;
    }
    const { result, fresh } = await checker.check(main, snapshots);
    if (fresh) await stdb.reportCheck(result.key, result.agents, result.red ? "red" : "green", logOf(result));
    if (result.red) continue;
    await resolve(conflict, "its snapshots check green together", result.key);
  }
}

// ---- Formatting ------------------------------------------------------------------------------

function summary(run: Combination): string {
  if (!run.outcome) return `merge conflict in ${run.mergeFiles.join(", ")}`;
  const first = firstError(run.outcome);
  const count = run.outcome.tscErrors.length + run.outcome.testFails.length;
  return `${count || 1} problem(s), first at ${first?.loc || "?"}`;
}

function logOf(run: Combination): string {
  if (!run.outcome) return `git merge failed (${run.mergeAgent}'s snapshot) with conflicts in: ${run.mergeFiles.join(", ")}`;
  return run.outcome.log;
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)} s`;
}

// ---- Start and stop ----------------------------------------------------------------------------

async function shutdown(reason: string, code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  if (debounce) clearTimeout(debounce);
  log(`${reason}: removing temporary worktrees`);
  try {
    await git.removeAllWorktrees();
  } catch (error) {
    console.error(`[watcher] cleanup failed: ${errorMessage(error)}`);
  }
  stdb.disconnect();
  process.exit(code);
}

async function main(): Promise<void> {
  const missing = missingSettings(["stdbDb", "demoRepoPath"]);
  if (missing.length > 0) {
    console.error(`[watcher] Set ${missing.join(" and ")} in .env first (see .env.example).`);
    process.exit(1);
  }
  const tools = missingTools();
  if (tools.length > 0) {
    console.error(`[watcher] ${config.demoRepoPath} has no ${tools.join(" or ")}, so nothing could turn red. Run this in that folder first:\n  ${INSTALL_TOOLS}`);
    process.exit(1);
  }
  process.on("SIGINT", () => void shutdown("Ctrl+C", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("uncaughtException", (error) => {
    console.error(`[watcher] crashed: ${error.stack ?? error.message}`);
    void shutdown("crash", 1);
  });

  await git.removeStaleWorktrees();
  log(`watching ${config.demoRepoPath} (${config.gitRemote}/${config.mainBranch} + wip/*)`);
  await stdb.connect();
  stdb.onSnapshot((row) => {
    log(`snapshot from ${row.agent}: ${short(row.sha)} (${row.files.join(", ") || "no files"})`);
    trigger();
  });
  stdb.onResync(() => {
    log("caught up after a reconnect");
    trigger();
  });
  trigger();
}

await main();
