/**
 * orchestrator/src/team.ts
 *
 * WHAT IT'S FOR
 *   The team's live state as the orchestrator sees it, read from SpacetimeDB over HTTP: agents,
 *   tasks in flight, every agent's newest uncommitted snapshot, recent intents, open conflicts.
 *   describeTeam() turns it into the text Droid's team_status tool returns, so Droid can see what
 *   each agent is doing before it assigns new work, and spot overlaps worth flagging.
 *
 * OWNER: A (branch feat/orchestrator).
 */
import type { Owners } from "../../shared/src/owners.ts";
import type { AgentName, AgentRow, ConflictRow, IntentRow, SnapshotRow, TaskRow } from "../../shared/src/schema.ts";
import { ORCHESTRATOR_NAME } from "../../shared/src/schema.ts";
import { selectRows } from "../../shared/src/stdb-http.ts";

export interface TeamState {
  agents: AgentRow[];
  tasks: TaskRow[];
  snapshots: SnapshotRow[];
  intents: IntentRow[];
  conflicts: ConflictRow[];
}

const DIFF_CHARS = 2500;

export async function readTeam(): Promise<TeamState> {
  const [agents, tasks, snapshots, intents, conflicts] = await Promise.all([
    selectRows("agent"),
    selectRows("task"),
    selectRows("snapshot"),
    selectRows("intent"),
    selectRows("conflict"),
  ]);
  return { agents, tasks, snapshots, intents, conflicts };
}

/** The newest snapshot row per agent (ids give the posting order). */
export function latestSnapshots(rows: SnapshotRow[]): Map<AgentName, SnapshotRow> {
  const latest = new Map<AgentName, SnapshotRow>();
  for (const row of rows) {
    const previous = latest.get(row.agent);
    if (!previous || row.id > previous.id) latest.set(row.agent, row);
  }
  return latest;
}

export function describeTeam(state: TeamState, owners: Owners): string {
  const human = (agent: string) => owners.owners.find((owner) => owner.agent === agent)?.human ?? agent;
  const lines: string[] = ["## Who owns what (cowork.owners.json)"];
  for (const owner of owners.owners) {
    lines.push(`- ${owner.agent} works for ${owner.human}: ${owner.feature || "(no feature named)"}. Owns: ${owner.paths.join(", ") || "(nothing)"}`);
  }
  lines.push(`Shared contracts (every owner may depend on them): ${owners.shared.join(", ") || "(none)"}`);

  lines.push("", "## Agents right now");
  if (state.agents.length === 0) lines.push("(no agent has connected yet)");
  for (const agent of state.agents) {
    lines.push(`- ${agent.name} (${human(agent.name)}): ${agent.online ? "online" : "offline"}, ${agent.status}${agent.intent ? `. Latest intent: ${agent.intent}` : ""}`);
  }

  const inFlight = state.tasks.filter((task) => task.status === "assigned" || task.status === "waiting_review");
  lines.push("", "## Tasks in flight");
  if (inFlight.length === 0) lines.push("(none)");
  for (const task of inFlight) {
    lines.push(`- task #${task.id} for ${task.agent} (${task.status}${task.major ? ", major" : ""}): ${task.title}. Files: ${task.files.join(", ") || "(not listed)"}`);
  }

  lines.push("", "## Uncommitted work in progress (each agent's newest snapshot, diff against main)");
  const latest = [...latestSnapshots(state.snapshots).values()].filter((row) => row.files.length > 0);
  if (latest.length === 0) lines.push("(nobody has uncommitted changes)");
  for (const row of latest) {
    const diff = row.diff.length > DIFF_CHARS ? `${row.diff.slice(0, DIFF_CHARS)}\n(diff cut)` : row.diff;
    lines.push(`### ${row.agent}: ${row.files.join(", ")}`, "```diff", diff, "```");
  }

  const open = state.conflicts.filter((conflict) => conflict.status !== "resolved");
  lines.push("", "## Open conflicts");
  if (open.length === 0) lines.push("(none)");
  for (const conflict of open) {
    lines.push(`- #${conflict.id} ${conflict.agentA} x ${conflict.agentB || "(alone)"} (${conflict.kind}, ${conflict.status}): ${conflict.error.split("\n")[0]}`);
  }

  const facts = state.intents.filter((intent) => intent.verified || intent.agent === ORCHESTRATOR_NAME);
  const plans = state.intents.filter((intent) => !intent.verified && intent.agent !== ORCHESTRATOR_NAME).slice(-10);
  lines.push("", "## Verified facts (both agents agreed and a check passed)");
  if (facts.length === 0) lines.push("(none)");
  for (const fact of facts) lines.push(`- ${fact.summary}`);
  lines.push("", "## Recent intents agents posted");
  if (plans.length === 0) lines.push("(none)");
  for (const plan of plans) lines.push(`- ${plan.agent}: ${plan.summary}${plan.files.length ? ` (files: ${plan.files.join(", ")})` : ""}`);
  return lines.join("\n");
}
