/** WHAT IT'S FOR: derive truthful dashboard status from shared tables and transport state. */
import type {
  AgentRow,
  CheckRunRow,
  ConflictRow,
  TableRows,
} from "../../shared/src/schema.ts";

export type Tables = { [K in keyof TableRows]: TableRows[K][] };
export type ConnectionPhase =
  | "unconfigured"
  | "connecting"
  | "syncing"
  | "live"
  | "reconnecting"
  | "error"
  | "demo";
export interface ConnectionState {
  phase: ConnectionPhase;
  detail: string;
  updatedAt: number;
}
export const emptyTables = (): Tables => ({
  agent: [],
  snapshot: [],
  intent: [],
  check_run: [],
  conflict: [],
  inbox: [],
  diagnosis_step: [],
  request: [],
  task: [],
  review: [],
  message: [],
  plan_step: [],
  build: [],
});
export const isActiveConflict = (c: ConflictRow): boolean =>
  c.status !== "resolved";
export function latestCheck(runs: CheckRunRow[]): CheckRunRow | undefined {
  return [...runs].sort((a, b) => b.createdAt - a.createdAt)[0];
}
/** Localization emits single/pair checks too; those must never overwrite the team's full result. */
export function latestCombinedCheck(tables: Tables): CheckRunRow | undefined {
  const latest = new Map<string, Tables["snapshot"][number]>();
  for (const snapshot of tables.snapshot) {
    const previous = latest.get(snapshot.agent);
    if (
      !previous ||
      snapshot.createdAt > previous.createdAt ||
      (snapshot.createdAt === previous.createdAt && snapshot.id > previous.id)
    )
      latest.set(snapshot.agent, snapshot);
  }
  const contributors = [...latest.values()]
    .filter((s) => s.files.length > 0)
    .map((s) => s.agent);
  return latestCheck(
    tables.check_run.filter((run) =>
      contributors.every((agent) => run.agents.includes(agent)),
    ),
  );
}
export interface Health {
  tone: "neutral" | "green" | "red" | "amber";
  title: string;
  detail: string;
}
export function teamHealth(
  tables: Tables,
  connection: ConnectionState,
): Health {
  if (connection.phase !== "live" && connection.phase !== "demo") {
    return {
      tone: "neutral",
      title:
        connection.phase === "error"
          ? "Connection needs attention"
          : connection.phase === "unconfigured"
            ? "Connect your team"
            : "Waiting for live data",
      detail: connection.detail,
    };
  }
  const active = tables.conflict.filter(isActiveConflict);
  if (active.length) {
    const needsHuman = active.some(
      (c) => c.status === "needs_human" || c.status === "escalated",
    );
    return {
      tone: "red",
      title: needsHuman
        ? "Your team needs a hand"
        : `${active.length} conflict${active.length > 1 ? "s" : ""} to resolve`,
      detail: needsHuman
        ? "A conflict requires human review. See the highlighted request below."
        : "The combined changes failed. The assigned agent owns the next fix.",
    };
  }
  const check = latestCombinedCheck(tables);
  if (!check)
    return {
      tone: tables.snapshot.length ? "amber" : "neutral",
      title: tables.snapshot.length
        ? "Waiting for a combined check"
        : "Waiting for the first check",
      detail:
        "Agent presence or passing checks of individual snapshots do not mean the combined code passes.",
    };
  if (check.result === "red")
    return {
      tone: "red",
      title: "Combined check failed",
      detail:
        "A combined check failed. Waiting for conflict details.",
    };
  if (
    tables.snapshot.some((s) => s.createdAt > check.createdAt) ||
    tables.agent.some((a) => a.status === "working")
  ) {
    return {
      tone: "amber",
      title: "Checking the latest changes",
      detail: "New work arrived after the last passing check.",
    };
  }
  if (tables.agent.some((a) => a.status === "red"))
    return {
      tone: "red",
      title: "An agent is still red",
      detail: "Waiting for a combined check to confirm the team is healthy.",
    };
  return {
    tone: "green",
    title: "All changes work together",
    detail: "The latest combined check passed. Your team can keep building.",
  };
}
export function sortAgents(agents: AgentRow[]): AgentRow[] {
  return [...agents].sort((a, b) => a.name.localeCompare(b.name));
}
export function sortConflicts(conflicts: ConflictRow[]): ConflictRow[] {
  const rank = { needs_human: 0, escalated: 1, open: 2, resolved: 3 };
  return [...conflicts].sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      b.createdAt - a.createdAt ||
      b.id - a.id,
  );
}

export interface TimelineEvent {
  id: string;
  at: number;
  kind: "snapshot" | "check" | "intent" | "fact" | "conflict" | "resolved";
  title: string;
  detail: string;
  tone: "neutral" | "green" | "red";
}
export function timelineEvents(t: Tables): TimelineEvent[] {
  const events: TimelineEvent[] = [
    ...t.snapshot.map((s) => ({
      id: `snapshot-${s.id}`,
      at: s.createdAt,
      kind: "snapshot" as const,
      title: `${s.agent.toUpperCase()} pushed a snapshot`,
      detail: `${s.files.length} file${s.files.length === 1 ? "" : "s"} · ${s.sha.slice(0, 7)}`,
      tone: "neutral" as const,
    })),
    ...t.check_run.map((r) => ({
      id: `check-${r.runKey}`,
      at: r.createdAt,
      kind: "check" as const,
      title: `Check ${r.result === "green" ? "passed" : "failed"}`,
      detail: r.agents.map((a) => a.toUpperCase()).join(" + "),
      tone: r.result,
    })),
    ...t.intent.map((i) => ({
      id: `intent-${i.id}`,
      at: i.createdAt,
      kind: i.verified ? ("fact" as const) : ("intent" as const),
      title: i.verified
        ? "Verified fact added"
        : `${i.agent.toUpperCase()} shared a plan`,
      detail: i.summary,
      tone: i.verified ? ("green" as const) : ("neutral" as const),
    })),
    ...t.conflict.map((c) => ({
      id: `conflict-${c.id}`,
      at: c.createdAt,
      kind: "conflict" as const,
      title: `Conflict #${c.id} detected`,
      detail: `${c.agentA.toUpperCase()}${c.agentB ? ` × ${c.agentB.toUpperCase()}` : ""} · fixer ${c.fixer.toUpperCase()}`,
      tone: "red" as const,
    })),
    ...t.conflict
      .filter((c) => c.status === "resolved" && c.resolvedAt > 0)
      .map((c) => ({
        id: `resolved-${c.id}`,
        at: c.resolvedAt,
        kind: "resolved" as const,
        title: `Conflict #${c.id} resolved`,
        detail: `${c.fixer.toUpperCase()}'s fix passed the combined check`,
        tone: "green" as const,
      })),
  ];
  return events
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, 60);
}
