/**
 * orchestrator/src/full-stack.ts
 *
 * WHAT IT'S FOR
 *   The team's full stack. The orchestrator keeps one branch, FULL_STACK_BRANCH (cowork/full-stack),
 *   that holds everyone's work together: main plus every agent's latest snapshot, merged in a
 *   disposable worktree and checked with tsc + vitest. It's pushed only when it's green, so it works
 *   like a main branch that always runs. When a request is finished, it's rebuilt and every agent
 *   hears that the whole project is ready to run on their laptop (get_full_stack). Droid also plans
 *   on top of it, so it sees every agent's files, not just main.
 *
 * OWNER: A (branch feat/orchestrator).
 *
 * HOW (orchestrator/src/index.ts calls these)
 *   currentInputs()       fetch main + wip/*, then main's sha and each agent's latest snapshot that
 *                         changes something. Their key decides whether a new build is needed.
 *   buildFullStack(id)    worktree at main → merge each snapshot (agents in name order) → tsc + vitest.
 *                         Green: push the merged commit to FULL_STACK_BRANCH (force: it's the
 *                         orchestrator's own branch), publish_build. Red: nothing is pushed; the red
 *                         build is recorded only when a finished request asked for it.
 *   fullStackHead()       the pushed full stack's commit, or null (planner.ts reads it).
 *
 * NOTES
 *   - Never touches main or any agent's branch. Red or green comes from git, tsc and vitest only.
 *   - Runs in the orchestrator's own clone (DEMO_REPO_PATH), like the planner's worktree.
 */
import { describeFailures, runChecks } from "../../checks/src/check.ts";
import * as git from "../../checks/src/git.ts";
import { config } from "../../shared/src/config.ts";
import { FULL_STACK_BRANCH, runKey, type AgentName, type RunResult } from "../../shared/src/schema.ts";
import { callReducer, selectRows } from "../../shared/src/stdb-http.ts";

export interface BuildInputs {
  main: string;
  snapshots: Array<{ agent: AgentName; sha: string }>;
  /** main + the snapshot shas: same key, same build. */
  key: string;
}

export interface BuildResult {
  result: RunResult;
  sha: string;
  agents: AgentName[];
  log: string;
}

const remoteBranch = `refs/remotes/${config.gitRemote}/${FULL_STACK_BRANCH}`;

export async function currentInputs(): Promise<BuildInputs> {
  await git.fetchWip();
  const main = await git.mainSha();
  const latest = new Map<AgentName, { id: number; sha: string }>();
  for (const row of await selectRows("snapshot")) {
    const previous = latest.get(row.agent);
    if (!previous || row.id > previous.id) latest.set(row.agent, row);
  }
  const snapshots: BuildInputs["snapshots"] = [];
  for (const [agent, row] of [...latest].sort(([a], [b]) => a.localeCompare(b))) {
    const sha = (await git.hasCommit(row.sha)) ? row.sha : await git.wipHead(agent);
    if (sha && (await git.hasChanges(main, sha))) snapshots.push({ agent, sha });
  }
  return { main, snapshots, key: `${main}:${runKey(snapshots.map((s) => s.sha))}` };
}

/** Builds the full stack from `inputs`; pushes and records it when green. */
export async function buildFullStack(inputs: BuildInputs, requestId: number): Promise<BuildResult> {
  const agents = inputs.snapshots.map((s) => s.agent);
  const dir = await git.makeWorktree(`full-stack-${Date.now()}`);
  let built: BuildResult;
  try {
    await git.resetWorktree(dir, inputs.main);
    let failure = "";
    for (const snapshot of inputs.snapshots) {
      const merged = await git.mergeInto(dir, snapshot.sha);
      if (!merged.ok) {
        failure = `git can't merge ${snapshot.agent}'s work with the others: ${merged.files.join(", ")}`;
        break;
      }
    }
    if (!failure) {
      const outcome = await runChecks(dir);
      if (!outcome.ok) failure = describeFailures(outcome) || outcome.crash || "the checks failed";
    }
    const sha = (await git.git(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    if (failure) {
      built = { result: "red", sha, agents, log: failure };
    } else {
      await git.git(["push", "--force", "--quiet", config.gitRemote, `HEAD:refs/heads/${FULL_STACK_BRANCH}`], { cwd: dir });
      built = { result: "green", sha, agents, log: `main ${inputs.main.slice(0, 8)} + ${agents.length ? agents.map((a) => `${a}'s work`).join(", ") : "nothing else yet"}; tsc and vitest pass` };
    }
  } finally {
    await git.removeWorktree(dir).catch(() => undefined);
  }
  if (built.result === "green" || requestId) {
    await callReducer("publish_build", [built.result === "green" ? FULL_STACK_BRANCH : "", built.sha, inputs.main, agents, built.result, built.log, requestId]);
  }
  return built;
}

/** Announces an existing green build again for a finished request (nothing changed since it was built). */
export async function announce(build: BuildResult, inputs: BuildInputs, requestId: number): Promise<void> {
  await callReducer("publish_build", [FULL_STACK_BRANCH, build.sha, inputs.main, build.agents, "green", build.log, requestId]);
}

/** The pushed full stack's commit, fetched now; null when there isn't one yet. */
export async function fullStackHead(): Promise<string | null> {
  const fetched = await git.git(["fetch", "--quiet", config.gitRemote, `+refs/heads/${FULL_STACK_BRANCH}:${remoteBranch}`], { allowFail: true });
  if (fetched.code !== 0) return null;
  const head = await git.git(["rev-parse", "--verify", "--quiet", `${remoteBranch}^{commit}`], { allowFail: true });
  return head.code === 0 ? head.stdout.trim() : null;
}
