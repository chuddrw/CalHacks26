/**
 * orchestrator/src/kickoff-run.ts
 *
 * WHAT IT'S FOR
 *   Runs one kickoff (the goal-only case) from the database: reads the kickoff row, has Droid propose
 *   who owns what (kickoff.ts / planner.ts), and stores the result back on the row for the humans:
 *   either one round of questions, or a proposal plus the cowork.owners.json text a human commits.
 *   It never writes to main or to any repo: approval happens on the dashboard and a human commits.
 *
 * SCRIPTED (tests, model-free rehearsals): COWORK_KICKOFF_FILE=<file.json> replaces Droid. The file is
 *   { "questions": ["..."], "proposal": { owners, contracts, firstTasks, architecture, summary? } }.
 *   With "questions" and no answers yet it asks them (once); otherwise it proposes "proposal".
 */
import { readFileSync } from "node:fs";
import type { KickoffRow } from "../../shared/src/schema.ts";
import { callReducer } from "../../shared/src/stdb-http.ts";
import * as git from "../../checks/src/git.ts";
import { fullStackHead } from "./full-stack.ts";
import { parseProposal, proposalToOwnersFile, type KickoffInput, type KickoffMember, type KickoffResult } from "./kickoff.ts";
import type { OnStep } from "./planner.ts";

export type Kickoff = (input: KickoffInput, onStep: OnStep) => Promise<KickoffResult>;

export interface KickoffDeps {
  kickoff: Kickoff;
  call?: (reducer: string, args: unknown[]) => Promise<unknown>;
  /** A disposable read-only copy of the repo for Droid, and how to remove it. */
  workspace?: (kickoffId: number) => Promise<{ dir: string; cleanup: () => Promise<void> }>;
  log?: (message: string) => void;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The kickoff's members as the planner wants them (handle -> agent, display name -> human). */
export function membersOf(row: KickoffRow): KickoffMember[] {
  const parsed = JSON.parse(row.members || "[]") as Array<{ handle: string; displayName: string; strengths?: string }>;
  return parsed.map((m) => ({ agent: m.handle, human: m.displayName, ...(m.strengths ? { strengths: m.strengths } : {}) }));
}

async function gitWorkspace(kickoffId: number) {
  await git.fetchWip();
  const dir = await git.makeWorktree(`kickoff-${kickoffId}`);
  const stack = await fullStackHead().catch(() => null);
  if (stack) await git.resetWorktree(dir, stack);
  return { dir, cleanup: () => git.removeWorktree(dir).catch(() => undefined) };
}

export async function runKickoff(row: KickoffRow, deps: KickoffDeps): Promise<void> {
  const call = deps.call ?? callReducer;
  const log = deps.log ?? (() => undefined);
  const started = Date.now();
  log(`kickoff #${row.id} from ${row.requester}: ${row.goal.split("\n")[0]}`);
  await call("start_kickoff", [row.id]);
  let workspace: Awaited<ReturnType<NonNullable<KickoffDeps["workspace"]>>> | undefined;
  try {
    const members = membersOf(row);
    workspace = await (deps.workspace ?? gitWorkspace)(row.id);
    const result = await deps.kickoff(
      { goal: row.goal, constraints: row.constraints, members, answers: row.answers || undefined, worktree: workspace.dir },
      (_kind, detail) => log(`kickoff #${row.id}: ${detail.split("\n")[0]}`),
    );
    if (result.kind === "questions") {
      await call("ask_kickoff_questions", [row.id, result.questions]);
      log(`kickoff #${row.id}: ${result.questions.length} question(s) for the humans`);
      return;
    }
    // Validated again here (the scripted path skips the Droid tools), against the people on this kickoff.
    const proposal = parseProposal(result.proposal, members.map((m) => m.agent));
    const owners = proposalToOwnersFile({ ...proposal, summary: result.proposal.summary }).text;
    await call("publish_proposal", [row.id, JSON.stringify({ ...proposal, ...(result.proposal.summary ? { summary: result.proposal.summary } : {}) }), owners]);
    log(`kickoff #${row.id} proposed in ${((Date.now() - started) / 1000).toFixed(1)} s: ${proposal.owners.map((o) => o.agent).join(", ")}`);
  } catch (error) {
    const reason = errorMessage(error);
    log(`kickoff #${row.id} failed: ${reason}`);
    await call("fail_kickoff", [row.id, reason]).catch((failure: unknown) => log(`fail_kickoff failed: ${errorMessage(failure)}`));
  } finally {
    await workspace?.cleanup();
  }
}

/** A kickoff that reads a fixed answer from a file: no model involved. See the header for the shape. */
export function scriptedKickoff(file: string): Kickoff {
  return async (input, onStep) => {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { questions?: string[]; proposal?: unknown };
    onStep("status", `Scripted kickoff from ${file} (no model)`);
    if (raw.questions?.length && !input.answers) return { kind: "questions", questions: raw.questions };
    if (!raw.proposal) throw new Error(`${file} has no "proposal"`);
    const proposal = parseProposal(raw.proposal, input.members.map((m) => m.agent));
    return { kind: "proposal", proposal: { ...proposal, summary: (raw.proposal as { summary?: string }).summary } };
  };
}
