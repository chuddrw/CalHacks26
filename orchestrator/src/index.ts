/**
 * orchestrator/src/index.ts
 *
 * WHAT IT'S FOR
 *   The orchestrator, which replaced the watcher on branch feat/orchestrator. One copy runs on one
 *   laptop for the whole team. A human tells their own agent what they want; the agent forwards it
 *   (ask_orchestrator); this loop has Droid turn it into a plan, applies the contract rule, and
 *   publishes the plan in one transaction: tasks for the agents that own each feature, reviews for
 *   the humans whose features a major change affects, and the conflicts Droid expects. It never
 *   writes code and never settles a conflict: the two agents do that between themselves, and
 *   escalate to both humans when they can't.
 *
 * OWNER: A. Design and checklist: checklists/orchestrator.md.
 * USAGE: npm run orchestrator. Needs STDB_DB, DEMO_REPO_PATH (the orchestrator's own clone of the
 *        app that nobody codes in) and FACTORY_API_KEY, and this laptop's `spacetime login` with
 *        editor access. COWORK_PLAN_FILE=<plan.json> publishes that plan instead of asking Droid
 *        (tests and model-free rehearsals; the dashboard shows it as a scripted plan).
 *
 * LOOP (one request at a time)
 *   1. Every 1.5 s: the oldest request with status "new" (at start, also any left in "planning" by
 *      an orchestrator that was stopped).
 *   2. start_request. Fetch main, make a disposable worktree of it, read cowork.owners.json there.
 *   3. Droid plans (planner.ts); each step goes to add_plan_step, so the dashboard shows it live.
 *   4. The contract rule (rules.ts), with every importer of a shared contract on main and in the
 *      teammates' snapshots (imports.ts). Its decisions are plan steps too.
 *   5. publish_plan(request, summary, plan JSON). The module writes it all in one transaction.
 *   6. Remove the worktree. Anything that fails on the way: fail_request(reason), and the
 *      requester's agent is told why.
 */
import { readFileSync } from "node:fs";
import { config, missingSettings } from "../../shared/src/config.ts";
import { humanOf, readOwners } from "../../shared/src/owners.ts";
import type { DiagnosisStepKind, RequestRow } from "../../shared/src/schema.ts";
import { callReducer, selectRows } from "../../shared/src/stdb-http.ts";
import * as git from "../../checks/src/git.ts";
import { importIndex } from "./imports.ts";
import { createDroidPlanner, type Planner } from "./planner.ts";
import { applyContractRule, type DraftPlan } from "./rules.ts";
import { describeTeam, latestSnapshots, readTeam } from "./team.ts";

const POLL_MS = 1500;
const MAX_STEPS = 300;

function log(message: string): void {
  console.log(`[orchestrator] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A planner that publishes a fixed plan from a file: no model involved. */
function scriptedPlanner(file: string): Planner {
  return async (_input, onStep) => {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DraftPlan>;
    onStep("status", `Scripted plan from ${file} (no model)`);
    return { summary: raw.summary ?? "Scripted plan", tasks: raw.tasks ?? [], reviews: raw.reviews ?? [], conflicts: raw.conflicts ?? [] };
  };
}

/** Plan steps in order, at most five a second, never more than MAX_STEPS per request. */
function stepWriter(requestId: number) {
  let queue = Promise.resolve();
  let count = 0;
  let last = 0;
  const write = (kind: DiagnosisStepKind, detail: string) => {
    if (count++ >= MAX_STEPS) return;
    queue = queue.then(async () => {
      const wait = Math.max(0, last + 200 - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      await callReducer("add_plan_step", [requestId, kind, detail]).catch((error: unknown) => log(`plan step failed: ${errorMessage(error)}`));
      last = Date.now();
    });
  };
  return { write, drain: () => queue };
}

export async function planRequest(request: RequestRow, planner: Planner): Promise<void> {
  const started = Date.now();
  log(`request #${request.id} from ${request.agent}: ${request.body.split("\n")[0]}`);
  await callReducer("start_request", [request.id]);
  const steps = stepWriter(request.id);
  let worktree = "";
  try {
    await git.fetchWip();
    worktree = await git.makeWorktree(`plan-${request.id}`);
    const owners = readOwners(worktree);
    const draft = await planner(
      {
        request,
        requesterHuman: humanOf(owners, request.agent),
        owners,
        worktree,
        teamStatus: async () => describeTeam(await readTeam(), owners),
      },
      steps.write,
    );
    const team = await readTeam();
    const diffs = [...latestSnapshots(team.snapshots).values()].map((row) => row.diff);
    const { plan, notes } = applyContractRule({ plan: draft, owners, requester: request.agent, importers: importIndex(worktree, diffs) });
    for (const note of notes) steps.write("status", note);
    const summary = plan.tasks.length ? plan.summary : plan.summary || "Nothing to do.";
    steps.write("final", `${plan.tasks.length} task(s), ${plan.reviews.length} review(s), ${plan.conflicts.length} flagged conflict(s). ${summary}`);
    await steps.drain();
    await callReducer("publish_plan", [request.id, summary, JSON.stringify({ tasks: plan.tasks, reviews: plan.reviews, conflicts: plan.conflicts })]);
    log(
      `request #${request.id} planned in ${((Date.now() - started) / 1000).toFixed(1)} s: ` +
        `${plan.tasks.map((task) => `${task.agent}${task.major ? " (major)" : ""}`).join(", ") || "no tasks"}` +
        `${plan.reviews.length ? `; review by ${plan.reviews.map((review) => review.reviewer).join(", ")}` : ""}` +
        `${plan.conflicts.length ? `; flagged ${plan.conflicts.map((c) => `${c.agentA} x ${c.agentB}`).join(", ")}` : ""}`,
    );
  } catch (error) {
    const reason = errorMessage(error);
    steps.write("error", reason);
    await steps.drain();
    log(`request #${request.id} failed: ${reason}`);
    await callReducer("fail_request", [request.id, reason]).catch((failure: unknown) => log(`fail_request failed: ${errorMessage(failure)}`));
  } finally {
    if (worktree) await git.removeWorktree(worktree).catch(() => undefined);
  }
}

let exiting = false;

async function shutdown(reason: string, code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  log(`${reason}: removing temporary worktrees`);
  await git.removeAllWorktrees().catch((error: unknown) => console.error(`[orchestrator] cleanup failed: ${errorMessage(error)}`));
  process.exit(code);
}

async function main(): Promise<void> {
  const missing = missingSettings(["stdbDb", "demoRepoPath"]);
  if (missing.length > 0) {
    console.error(`[orchestrator] Set ${missing.join(" and ")} in .env first (see .env.example).`);
    process.exit(1);
  }
  const planFile = process.env.COWORK_PLAN_FILE ?? "";
  const planner = planFile ? scriptedPlanner(planFile) : createDroidPlanner();
  if (!planFile && !config.factoryApiKey) log("FACTORY_API_KEY is empty: every request will fail until it's set.");
  process.on("SIGINT", () => void shutdown("Ctrl+C", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("uncaughtException", (error) => {
    console.error(`[orchestrator] crashed: ${error.stack ?? error.message}`);
    void shutdown("crash", 1);
  });
  await git.removeStaleWorktrees();
  log(`planning for ${config.stdbDb} with ${planFile ? `the scripted plan ${planFile}` : "Droid"}; clone ${config.demoRepoPath}`);

  let resume = true;
  while (!exiting) {
    try {
      const requests = await selectRows("request");
      const next = requests
        .filter((row) => row.status === "new" || (resume && row.status === "planning"))
        .sort((a, b) => a.id - b.id)[0];
      resume = false;
      if (next) {
        await planRequest(next, planner);
        continue;
      }
    } catch (error) {
      console.error(`[orchestrator] poll failed: ${errorMessage(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

if (process.argv[1] && import.meta.filename && process.argv[1].endsWith("index.ts")) await main();
