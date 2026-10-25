/**
 * WHAT IT'S FOR: every piece of data that moves between the orchestrator, the agents and the people
 * at the dashboard, as one-to-one transfers the graph flashes as arrows for a few seconds. Each row
 * that means "X sent Y something" becomes a Transfer with a stable key; a key that wasn't there on
 * the previous update is new and gets its arrow. Pure, so tests/transfers.test.ts checks every scene.
 *
 * Code itself moves through git (wip/<agent> branches); everything else goes through SpacetimeDB.
 * The arrows skip both middlemen and show who it's from and who it's for, tagged "via git" / "via DB".
 */
import { pullerOf } from "../../shared/src/schema.ts";
import type { Tables } from "./dashboard";
import { ORCHESTRATOR_ID, PEOPLE_ID, upper, type Tone } from "./team";

export interface Transfer {
  key: string;
  at: number;
  from: string;
  to: string[];
  text: string;
  via: "DB" | "git";
  tone: Tone;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function transfers(t: Tables): Transfer[] {
  const agents = t.agent.map((a) => a.name);
  const others = (name: string) => agents.filter((a) => a !== name);
  const out: Transfer[] = [];
  const add = (x: Transfer) => {
    if (x.to.length) out.push(x);
  };

  for (const r of t.request)
    add({ key: `request-${r.id}`, at: r.createdAt, from: r.agent, to: [ORCHESTRATOR_ID], text: `asks: ${r.body}`, via: "DB", tone: "accent" });
  for (const task of t.task) {
    add({ key: `task-${task.id}`, at: task.createdAt, from: ORCHESTRATOR_ID, to: [task.agent], text: `task #${task.id}: ${task.title}`, via: "DB", tone: "accent" });
    if (task.status === "done")
      add({ key: `task-done-${task.id}`, at: task.updatedAt, from: task.agent, to: [ORCHESTRATOR_ID], text: `done #${task.id}: ${task.note || task.title}`, via: "DB", tone: "green" });
  }
  for (const review of t.review) {
    add({ key: `review-ask-${review.id}`, at: review.createdAt, from: ORCHESTRATOR_ID, to: [PEOPLE_ID], text: `${upper(review.reviewer)}'s human, review #${review.requestId}: ${review.summary}`, via: "DB", tone: "amber" });
    if (review.decidedAt > 0 && (review.status === "approved" || review.status === "rejected"))
      add({
        key: `review-${review.id}`,
        at: review.decidedAt,
        from: PEOPLE_ID,
        to: [ORCHESTRATOR_ID],
        text: `${upper(review.reviewer)}'s human ${review.status === "approved" ? "approved" : "sent back"} #${review.requestId}${review.answer ? `: ${review.answer}` : ""}`,
        via: "DB",
        tone: review.status === "approved" ? "green" : "red",
      });
  }
  for (const m of t.message) {
    const c = t.conflict.find((x) => x.id === m.conflictId);
    if (!c) continue;
    const pair = [c.agentA, c.agentB].filter(Boolean);
    const base = { key: `message-${m.id}`, at: m.createdAt, via: "DB" as const };
    if (m.kind === "decision") add({ ...base, from: PEOPLE_ID, to: pair, text: `decision: ${m.body}`, tone: "accent" });
    else if (m.kind === "escalate") add({ ...base, from: m.author, to: [PEOPLE_ID], text: `asks the humans: ${m.body}`, tone: "red" });
    else
      add({
        ...base,
        from: m.author,
        to: pair.filter((a) => a !== m.author),
        text: m.kind === "agree" ? `agrees: ${m.body}` : m.body,
        tone: m.kind === "agree" ? "green" : "neutral",
      });
  }
  for (const i of t.intent)
    add(
      i.verified
        ? { key: `intent-${i.id}`, at: i.createdAt, from: ORCHESTRATOR_ID, to: agents, text: `fact: ${i.summary}`, via: "DB", tone: "green" }
        : { key: `intent-${i.id}`, at: i.createdAt, from: i.agent, to: others(i.agent), text: `plans: ${i.summary}`, via: "DB", tone: "neutral" },
    );
  for (const s of t.snapshot)
    add({ key: `snapshot-${s.id}-${s.sha}`, at: s.createdAt, from: s.agent, to: others(s.agent), text: `pushed ${plural(s.files.length, "file")} to wip/${s.agent}`, via: "git", tone: "neutral" });
  for (const n of t.inbox) {
    const puller = n.kind === "info" ? pullerOf(n.message) : null;
    if (puller)
      add({ key: `pull-${n.id}`, at: n.createdAt, from: puller, to: [n.agent], text: `pulled ${upper(n.agent)}'s in-progress code`, via: "git", tone: "accent" });
  }
  for (const c of t.conflict) {
    if (!c.agentB) continue;
    add({ key: `conflict-${c.id}`, at: c.createdAt, from: c.agentA, to: [c.agentB], text: `clash #${c.id}: ${c.locA || c.agentA} × ${c.locB || c.agentB}`, via: "DB", tone: c.kind === "potential" ? "amber" : "red" });
    if (c.status === "resolved" && c.resolvedAt > 0)
      add({ key: `resolved-${c.id}`, at: c.resolvedAt, from: c.agentA, to: [c.agentB], text: `#${c.id} agreed, and the combined check is green`, via: "DB", tone: "green" });
  }
  for (const b of t.build)
    add({ key: `build-${b.id}`, at: b.createdAt, from: ORCHESTRATOR_ID, to: agents, text: `full stack ${b.sha.slice(0, 8)}: ${b.result === "green" ? "checks pass" : "checks fail"}`, via: "git", tone: b.result === "green" ? "green" : "red" });
  return out;
}

/** Transfers whose key isn't in `seen`, oldest first. */
export function newTransfers(seen: ReadonlySet<string>, all: Transfer[]): Transfer[] {
  return all.filter((x) => !seen.has(x.key)).sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
