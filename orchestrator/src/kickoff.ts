/**
 * orchestrator/src/kickoff.ts
 *
 * WHAT IT'S FOR
 *   The goal-only case: a team with a goal but no responsibilities yet. Droid reads the repo and
 *   proposes who owns what, the shared contracts, and a first task per person. This file holds the
 *   proposal's types, its validation, and the pure step from proposal to cowork.owners.json text.
 *
 * HOW IT'S USED
 *   The dashboard's submit_kickoff stores a kickoff row; the orchestrator's loop (index.ts) hands it to
 *   runKickoff (kickoff-run.ts), which calls createDroidKickoff (planner.ts) and stores the result on
 *   the row: one round of questions (needs_answers), or the proposal plus proposalToOwnersFile(...).text
 *   (proposed). Humans approve on the dashboard; a human commits the text. Nothing here writes to main.
 */
import { z } from "zod";
import { type Owner, writeOwnersProposal } from "../../shared/src/owners.ts";

export interface KickoffMember {
  agent: string;
  human: string;
  strengths?: string;
}

export interface KickoffInput {
  goal: string;
  /** Stack, deadline, demo, anything the team is bound by. */
  constraints?: string;
  members: KickoffMember[];
  /** The humans' answers to a first round of questions; with them, Droid may not ask again. */
  answers?: string;
  /** The disposable worktree of main Droid reads. */
  worktree: string;
}

const agentName = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "an agent name like a or ana");
const relPath = z.string().min(1).transform((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));

export const proposalSchema = z.object({
  architecture: z.string().default(""),
  owners: z.array(z.object({ agent: agentName, human: z.string().min(1), feature: z.string().min(1), paths: z.array(relPath).default([]) })).min(1),
  contracts: z.array(z.object({ path: relPath, description: z.string().default("") })).default([]),
  firstTasks: z.array(z.object({ agent: agentName, title: z.string().min(1), details: z.string().default(""), files: z.array(relPath).default([]) })).default([]),
});

export type OwnersProposal = z.infer<typeof proposalSchema> & { summary?: string };

/** A draft the kickoff tools fill in. */
export interface DraftProposal {
  summary: string;
  architecture: string;
  owners: Owner[];
  contracts: { path: string; description: string }[];
  firstTasks: { agent: string; title: string; details: string; files: string[] }[];
  questions: string[];
}

export type KickoffResult = { kind: "proposal"; proposal: OwnersProposal } | { kind: "questions"; questions: string[] };

function covers(prefix: string, file: string): boolean {
  return prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix;
}

/** Validates a proposal: shape, one owner per agent, first tasks only on files the agent owns (or a shared contract). Throws a readable error. */
export function parseProposal(value: unknown, allowedAgents?: string[]): OwnersProposal {
  const result = proposalSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid kickoff proposal: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const proposal = result.data;
  const agents = new Set<string>();
  for (const owner of proposal.owners) {
    if (agents.has(owner.agent)) throw new Error(`Invalid kickoff proposal: ${owner.agent} appears twice in owners.`);
    agents.add(owner.agent);
    if (allowedAgents && !allowedAgents.includes(owner.agent)) throw new Error(`Invalid kickoff proposal: ${owner.agent} isn't on the team (${allowedAgents.join(", ")}).`);
  }
  const shared = proposal.contracts.map((c) => c.path);
  for (const task of proposal.firstTasks) {
    if (!agents.has(task.agent)) throw new Error(`Invalid kickoff proposal: first task "${task.title}" is for ${task.agent}, who owns nothing.`);
    const mine = proposal.owners.find((o) => o.agent === task.agent)!.paths;
    for (const file of task.files) {
      if (![...mine, ...shared].some((prefix) => covers(prefix, file))) {
        throw new Error(`Invalid kickoff proposal: ${task.agent}'s task "${task.title}" touches ${file}, which they don't own.`);
      }
    }
  }
  return proposal;
}

/** The file a human would commit for this proposal, with a diff against main's current owners file (or null). */
export function proposalToOwnersFile(proposal: OwnersProposal, current: string | null = null) {
  return writeOwnersProposal({ owners: proposal.owners, shared: proposal.contracts.map((c) => c.path), about: proposal.architecture.slice(0, 500) }, current);
}
