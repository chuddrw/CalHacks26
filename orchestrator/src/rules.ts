/**
 * orchestrator/src/rules.ts
 *
 * WHAT IT'S FOR
 *   The contract rule, applied by code after Droid plans, so a major change can't slip past review
 *   because a model forgot to mark it:
 *     - A task that changes a shared contract (cowork.owners.json "shared") or a file another agent
 *       owns is major.
 *     - For a major task, the humans whose features are affected review it first: the owner of each
 *       foreign file it touches, and the owner of every file that imports a shared contract it changes
 *       (on main, or in a teammate's in-progress snapshot).
 *     - The requester never reviews their own request, and nobody reviews their own task.
 *   Droid may add more reviews (feature-level effects code can't see); the rule only adds.
 *
 * OWNER: A (branch feat/orchestrator). Pure functions; tests in rules.test.ts.
 */
import { humanOf, isShared, ownerOf, type Owners } from "../../shared/src/owners.ts";
import type { AgentName, PlanInput } from "../../shared/src/schema.ts";

export interface DraftPlan extends PlanInput {
  summary: string;
}

export interface RuleInput {
  plan: DraftPlan;
  owners: Owners;
  /** The agent whose human asked for this. */
  requester: AgentName;
  /** Repo-relative files that import `sharedFile`, on main and in teammates' snapshots. */
  importers: (sharedFile: string) => string[];
}

export interface RuleResult {
  plan: DraftPlan;
  /** One line per decision the rule made, for the dashboard's plan steps. */
  notes: string[];
}

/**
 * The online rule, applied before the contract rule: a task whose agent is offline goes to an
 * online agent instead (the requester when it's online, otherwise the online owner with the fewest
 * tasks). It then touches another owner's files, so the contract rule makes it major and that
 * owner's human reviews it. Conflicts follow the move; one that ends up with a single agent is
 * dropped. Nobody online: nothing changes.
 */
export function applyOnlineRule(input: { plan: DraftPlan; owners: Owners; requester: AgentName; online: Set<AgentName> }): RuleResult {
  const { owners, requester, online } = input;
  const notes: string[] = [];
  const listed = owners.owners.map((owner) => owner.agent).filter((agent) => online.has(agent));
  const candidates = listed.length ? listed : [...online];
  if (candidates.length === 0) return { plan: input.plan, notes };
  const load = new Map<AgentName, number>(candidates.map((agent) => [agent, 0]));
  for (const task of input.plan.tasks) if (load.has(task.agent)) load.set(task.agent, load.get(task.agent)! + 1);
  const moved = new Map<AgentName, AgentName>();
  const pick = (from: AgentName): AgentName => {
    const already = moved.get(from);
    if (already) return already;
    const to = online.has(requester) ? requester : [...load].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]![0];
    moved.set(from, to);
    return to;
  };
  const tasks = input.plan.tasks.map((task) => {
    if (online.has(task.agent)) return task;
    const to = pick(task.agent);
    load.set(to, (load.get(to) ?? 0) + 1);
    notes.push(`Online rule: ${task.agent} is offline, so "${task.title}" goes to ${to}; ${humanOf(owners, task.agent)} reviews it.`);
    return { ...task, agent: to, major: true, details: `(Reassigned from ${task.agent}, who is offline.) ${task.details}`.trim() };
  });
  const conflicts = input.plan.conflicts
    .map((c) => ({ ...c, agentA: moved.get(c.agentA) ?? c.agentA, agentB: moved.get(c.agentB) ?? c.agentB, suggested: moved.get(c.suggested) ?? c.suggested }))
    .filter((c) => c.agentA !== c.agentB);
  return { plan: { ...input.plan, tasks, conflicts }, notes };
}

export function applyContractRule(input: RuleInput): RuleResult {
  const { owners, requester } = input;
  const known = new Set(owners.owners.map((owner) => owner.agent));
  const notes: string[] = [];
  const reviews = new Map<AgentName, string>();
  for (const review of input.plan.reviews) {
    if (review.reviewer === requester || !known.has(review.reviewer) || reviews.has(review.reviewer)) continue;
    reviews.set(review.reviewer, review.summary);
  }

  const tasks = input.plan.tasks.map((task) => {
    const shared = task.files.filter((file) => isShared(owners, file));
    const foreign = task.files.filter((file) => {
      const owner = ownerOf(owners, file);
      return owner !== undefined && owner.agent !== task.agent;
    });
    const major = task.major || shared.length > 0 || foreign.length > 0;
    if (major && !task.major) {
      notes.push(`Rule: "${task.title}" (${task.agent}) is a major change: it touches ${[...shared, ...foreign].join(", ")}.`);
    }
    if (!major) return { ...task, major };

    const affected = new Map<AgentName, string[]>();
    const add = (agent: AgentName, why: string) => {
      if (agent === task.agent || agent === requester) return;
      affected.set(agent, [...(affected.get(agent) ?? []), why]);
    };
    for (const file of foreign) add(ownerOf(owners, file)!.agent, `it edits ${file}`);
    for (const file of shared) {
      for (const importer of input.importers(file)) {
        const owner = ownerOf(owners, importer);
        if (owner) add(owner.agent, `${importer} imports ${file}`);
      }
    }
    for (const [agent, why] of affected) {
      if (reviews.has(agent)) continue;
      const feature = owners.owners.find((owner) => owner.agent === agent)?.feature || `${agent}'s feature`;
      reviews.set(agent, `"${task.title}" (${task.agent}) changes code ${feature.toLowerCase()} depends on: ${[...new Set(why)].join("; ")}.`);
      notes.push(`Rule: ${humanOf(owners, agent)} (${agent}) reviews first, because ${[...new Set(why)].join("; ")}.`);
    }
    return { ...task, major };
  });

  return {
    plan: { ...input.plan, tasks, reviews: [...reviews].map(([reviewer, summary]) => ({ reviewer, summary })) },
    notes,
  };
}
