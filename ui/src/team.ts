/**
 * WHAT IT'S FOR: everything the dashboard shows, derived from the shared tables with no React:
 * the team graph (who works with whom right now), what each agent is doing, what needs a human,
 * and the activity feed. Pure functions, so tests/team.test.ts can check every demo scene.
 */
import type {
  AgentRow,
  ConflictRow,
  RequestRow,
  ReviewRow,
  TaskRow,
} from "../../shared/src/schema.ts";
import {
  isActiveConflict,
  sortAgents,
  timelineEvents,
  type Tables,
} from "./dashboard";

export type Tone = "neutral" | "accent" | "green" | "red" | "amber";

/** What the details drawer shows. A missing id means "the most relevant one". */
export type Selection =
  | { kind: "agent"; name: string }
  | { kind: "request"; id?: number }
  | { kind: "conflict"; id?: number }
  | { kind: "checks" }
  | { kind: "memory" }
  | { kind: "activity" }
  | { kind: "connection" };

export const ORCHESTRATOR_ID = "orchestrator";
/** The people at the dashboard: they answer reviews, escalations and test changes. */
export const PEOPLE_ID = "people";
/** Resolved conflicts stay on the graph this long, so the team sees them close. */
export const RESOLVED_VISIBLE_MS = 5 * 60_000;

export const upper = (name: string): string => name.toUpperCase();

export const requestStatusLabel: Record<RequestRow["status"], string> = {
  new: "Request received",
  planning: "Droid is planning",
  waiting_review: "Waiting for review",
  assigned: "Tasks assigned",
  done: "Done",
  rejected: "Sent back",
  failed: "Planning failed",
};
export const requestTone: Record<RequestRow["status"], Tone> = {
  new: "accent",
  planning: "accent",
  waiting_review: "amber",
  assigned: "accent",
  done: "green",
  rejected: "red",
  failed: "red",
};
export const taskStatusLabel: Record<TaskRow["status"], string> = {
  waiting_review: "Waits for review",
  assigned: "Working",
  done: "Done",
  cancelled: "Cancelled",
};
export const conflictStatusLabel: Record<ConflictRow["status"], string> = {
  open: "Agents talking it out",
  escalated: "Humans decide",
  needs_human: "Test change needs review",
  resolved: "Agreed and green",
};

const byNewest = <T extends { id: number }>(
  rows: T[],
  at: (row: T) => number,
): T[] => [...rows].sort((a, b) => at(b) - at(a) || b.id - a.id);

function latestRequest(t: Tables): RequestRow | undefined {
  return byNewest(t.request, (r) => r.createdAt)[0];
}
const activeRequest = (r: RequestRow): boolean =>
  r.status === "new" ||
  r.status === "planning" ||
  r.status === "waiting_review" ||
  r.status === "assigned";

/** Requests worth drawing: the unfinished ones (newest first), then the newest so its outcome stays visible. */
function visibleRequests(t: Tables): RequestRow[] {
  const latest = latestRequest(t);
  return byNewest(
    t.request.filter((r) => activeRequest(r) || r.id === latest?.id),
    (r) => r.createdAt,
  ).sort((a, b) => Number(activeRequest(b)) - Number(activeRequest(a)));
}

// ---- What each agent is doing ----------------------------------------------------------------

export interface AgentNow {
  /** The one line that says what the agent is doing right now. */
  doing: string;
  /** Where that line came from: an orchestrator task, the agent's own posted intent, or nothing. */
  source: "task" | "review" | "intent" | "idle";
  task?: TaskRow;
  /** Check state, or Offline. */
  state: string;
  stateTone: Tone;
  /** Active conflicts this agent is part of. */
  conflicts: ConflictRow[];
  /** Short notes such as "In thread with B". */
  badges: string[];
  lastActive: number;
}

export function agentNow(t: Tables, agent: AgentRow): AgentNow {
  const mine = byNewest(
    t.task.filter((task) => task.agent === agent.name),
    (task) => task.updatedAt,
  );
  const task =
    mine.find((x) => x.status === "assigned") ??
    mine.find((x) => x.status === "waiting_review");
  const conflicts = t.conflict.filter(
    (c) =>
      isActiveConflict(c) &&
      (c.agentA === agent.name || c.agentB === agent.name),
  );
  const badges = conflicts.map((c) => {
    const other = c.agentA === agent.name ? c.agentB : c.agentA;
    if (c.status === "escalated") return `Humans decide #${c.id}`;
    if (c.status === "needs_human") return `Test review #${c.id}`;
    return other ? `In thread with ${upper(other)}` : `Own check fails #${c.id}`;
  });
  const pendingReview = t.review.find(
    (r) => r.reviewer === agent.name && r.status === "pending",
  );
  if (pendingReview) badges.push(`Reviews request #${pendingReview.requestId}`);
  const lastActive = Math.max(
    agent.lastSnapshotAt,
    ...t.message.filter((m) => m.author === agent.name).map((m) => m.createdAt),
    ...mine.map((x) => x.updatedAt),
  );
  const state = !agent.online
    ? "Offline"
    : agent.status === "working"
      ? "Checking"
      : agent.status === "red"
        ? "Red"
        : "Green";
  const stateTone: Tone = !agent.online
    ? "neutral"
    : agent.status === "working"
      ? "accent"
      : agent.status === "red"
        ? "red"
        : "green";
  if (task)
    return {
      doing:
        task.status === "assigned"
          ? task.title
          : `Waiting for review: ${task.title}`,
      source: "task",
      task,
      state,
      stateTone,
      conflicts,
      badges,
      lastActive,
    };
  return {
    doing: agent.intent || (agent.online ? "Idle" : "Offline"),
    source: agent.intent ? "intent" : "idle",
    state,
    stateTone,
    conflicts,
    badges,
    lastActive,
  };
}

// ---- The graph -------------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  kind: "orchestrator" | "agent" | "people";
  label: string;
  /** Short state ("Green", "Droid is planning"). */
  state: string;
  tone: Tone;
  /** What it is doing now. */
  doing: string;
  online: boolean;
  /** Animated: the node is busy (planning, or the agent holds a task). */
  busy: boolean;
  select: Selection;
}

export interface GraphEdge {
  id: string;
  kind: "task" | "review" | "conflict";
  from: string;
  to: string;
  tone: Tone;
  dashed: boolean;
  /** Animated flow: work is happening along this edge. */
  active: boolean;
  label: string;
  select: Selection;
}

export interface TeamGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function taskEdge(task: TaskRow, online: boolean): GraphEdge {
  const tone: Tone =
    task.status === "assigned"
      ? "accent"
      : task.status === "done"
        ? "green"
        : "neutral";
  // An assigned task only counts as being worked on while its agent is connected.
  const working = task.status === "assigned" && online;
  return {
    id: `task-${task.id}`,
    kind: "task",
    from: ORCHESTRATOR_ID,
    to: task.agent,
    tone,
    dashed: task.status === "waiting_review" || (task.status === "assigned" && !online),
    active: working,
    // Say what the agent is doing, not just that it works.
    label: `${
      working
        ? "doing"
        : task.status === "assigned"
          ? `waiting, ${upper(task.agent)} offline`
          : task.status === "done"
            ? "done"
            : "waits for review"
    }: ${task.title}`,
    select: { kind: "request", id: task.requestId },
  };
}

function reviewEdge(review: ReviewRow, request: RequestRow): GraphEdge {
  return {
    id: `review-${review.id}`,
    kind: "review",
    from: review.reviewer,
    to: request.agent,
    tone:
      review.status === "pending"
        ? "amber"
        : review.status === "rejected"
          ? "red"
          : "neutral",
    dashed: true,
    active: false,
    label:
      review.status === "pending"
        ? `${upper(review.reviewer)} reviews #${request.id}`
        : review.status === "rejected"
          ? `${upper(review.reviewer)} sent back #${request.id}`
          : `${upper(review.reviewer)} approved`,
    select: { kind: "request", id: request.id },
  };
}

/** One line about where the two agents' conversation stands. */
export function threadState(t: Tables, c: ConflictRow): string {
  const messages = t.message
    .filter((m) => m.conflictId === c.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  // Agreement counts only after the latest escalation or human decision.
  let restart = -1;
  messages.forEach((m, i) => {
    if (m.kind === "escalate" || m.kind === "decision") restart = i;
  });
  const agreed = new Set(
    messages
      .slice(restart + 1)
      .filter((m) => m.kind === "agree")
      .map((m) => m.author),
  );
  const pair = [c.agentA, c.agentB].filter(Boolean);
  const yes = pair.filter((a) => agreed.has(a));
  if (c.status === "resolved") return "agreed";
  if (c.status === "escalated") return "humans decide";
  if (c.status === "needs_human") return "test change review";
  if (yes.length === 1) {
    const waiting = pair.find((a) => !agreed.has(a)) ?? "";
    return `${upper(yes[0] ?? "")} agreed · waiting on ${upper(waiting)}`;
  }
  if (yes.length === 2) return "both agreed · checking";
  if (c.kind === "potential" && messages.length === 0) return "expected clash";
  return messages.length
    ? `talking · ${messages.length} message${messages.length === 1 ? "" : "s"}`
    : "talking";
}

function conflictEdge(t: Tables, c: ConflictRow): GraphEdge {
  const tone: Tone =
    c.status === "resolved"
      ? "green"
      : c.status === "needs_human" || (c.kind === "potential" && c.status === "open")
        ? "amber"
        : "red";
  return {
    id: `conflict-${c.id}`,
    kind: "conflict",
    from: c.agentA,
    to: c.agentB,
    tone,
    dashed: c.kind === "potential" && c.status === "open",
    active: c.status === "open",
    label: `#${c.id} ${threadState(t, c)}`,
    select: { kind: "conflict", id: c.id },
  };
}

export function teamGraph(t: Tables, now: number): TeamGraph {
  const latest = latestRequest(t);
  const orchestrator: GraphNode = {
    id: ORCHESTRATOR_ID,
    kind: "orchestrator",
    label: "Orchestrator",
    state: latest ? requestStatusLabel[latest.status] : "Idle",
    tone: latest ? requestTone[latest.status] : "neutral",
    doing: latest
      ? `#${latest.id} from ${upper(latest.agent)}: ${latest.body}`
      : "Waiting for a request",
    online: true,
    busy: latest?.status === "planning" || latest?.status === "new",
    select: { kind: "request", id: latest?.id },
  };
  const actions = needsYou(t);
  const people: GraphNode = {
    id: PEOPLE_ID,
    kind: "people",
    label: "People",
    state: actions.length ? `${actions.length} need${actions.length === 1 ? "s" : ""} you` : "Nothing to do",
    tone: actions.length ? "amber" : "neutral",
    doing: "Reviews, decisions and test changes, on this dashboard",
    online: true,
    busy: false,
    select: actions[0]?.select ?? { kind: "activity" },
  };
  const agents = sortAgents(t.agent);
  const names = new Set(agents.map((a) => a.name));
  const online = new Set(agents.filter((a) => a.online).map((a) => a.name));
  const nodes: GraphNode[] = [
    orchestrator,
    people,
    ...agents.map((agent): GraphNode => {
      const doing = agentNow(t, agent);
      const selfConflict = doing.conflicts.find((c) => !c.agentB);
      return {
        id: agent.name,
        kind: "agent",
        label: `Agent ${upper(agent.name)}`,
        state: selfConflict ? `Own check fails #${selfConflict.id}` : doing.state,
        tone: selfConflict ? "red" : doing.stateTone,
        doing: doing.doing,
        online: agent.online,
        busy: agent.online && doing.task?.status === "assigned",
        select: { kind: "agent", name: agent.name },
      };
    }),
  ];

  const edges: GraphEdge[] = [];
  // One task line per agent: its newest task, from an unfinished request if it has one.
  const seen = new Set<string>();
  for (const request of visibleRequests(t)) {
    const tasks = byNewest(
      t.task.filter(
        (x) => x.requestId === request.id && x.status !== "cancelled",
      ),
      (x) => x.updatedAt,
    );
    for (const task of tasks) {
      if (seen.has(task.agent) || !names.has(task.agent)) continue;
      seen.add(task.agent);
      edges.push(taskEdge(task, online.has(task.agent)));
    }
    // Reviews matter while the request waits on them (or was just sent back).
    if (request.status === "waiting_review" || request.status === "rejected") {
      for (const review of t.review.filter(
        (r) => r.requestId === request.id && r.status !== "cancelled",
      )) {
        if (
          review.reviewer !== request.agent &&
          names.has(review.reviewer) &&
          names.has(request.agent)
        )
          edges.push(reviewEdge(review, request));
      }
    }
  }
  for (const c of t.conflict) {
    if (!c.agentB || !names.has(c.agentA) || !names.has(c.agentB)) continue;
    if (c.status === "resolved" && now - c.resolvedAt > RESOLVED_VISIBLE_MS)
      continue;
    edges.push(conflictEdge(t, c));
  }
  return { nodes, edges };
}

// ---- What needs a human ----------------------------------------------------------------------

export interface HumanAction {
  id: string;
  /** Who must act, e.g. "B's human". */
  who: string;
  text: string;
  tone: Tone;
  select: Selection;
}

export function needsYou(t: Tables): HumanAction[] {
  const actions: HumanAction[] = [];
  for (const review of t.review.filter((r) => r.status === "pending")) {
    const request = t.request.find((r) => r.id === review.requestId);
    actions.push({
      id: `review-${review.id}`,
      who: `${upper(review.reviewer)}'s human`,
      text: request
        ? `Approve or send back request #${request.id} from ${upper(request.agent)}: "${request.body}"`
        : `Approve or send back request #${review.requestId}`,
      tone: "amber",
      select: { kind: "request", id: review.requestId },
    });
  }
  for (const c of t.conflict) {
    if (c.status === "escalated")
      actions.push({
        id: `escalated-${c.id}`,
        who: c.agentB
          ? `${upper(c.agentA)}'s and ${upper(c.agentB)}'s humans`
          : `${upper(c.agentA)}'s human`,
        text: `The agents couldn't agree on conflict #${c.id}. Decide and send it to both.`,
        tone: "red",
        select: { kind: "conflict", id: c.id },
      });
    if (c.status === "needs_human")
      actions.push({
        id: `test-${c.id}`,
        who: "A person",
        text: `${upper(c.fixer)}'s fix for conflict #${c.id} changed existing tests. Accept or send back.`,
        tone: "amber",
        select: { kind: "conflict", id: c.id },
      });
  }
  return actions;
}

// ---- Activity --------------------------------------------------------------------------------

export interface ActivityEvent {
  id: string;
  at: number;
  who: string;
  text: string;
  tone: Tone;
  select?: Selection;
}

const who = (author: string): string =>
  author === "orchestrator"
    ? "Orchestrator"
    : author === "human"
      ? "Humans"
      : upper(author);

export function activity(t: Tables, limit = 60): ActivityEvent[] {
  const events: ActivityEvent[] = timelineEvents(t)
    // Agents' own plans already show as their current line; keep verified facts.
    .filter((e) => e.kind !== "intent")
    .map((e) => ({
      id: e.id,
      at: e.at,
      who: "",
      text: `${e.title} · ${e.detail}`,
      tone: e.tone,
      select:
        e.kind === "conflict" || e.kind === "resolved"
          ? { kind: "conflict", id: Number(e.id.split("-")[1]) }
          : e.kind === "check"
            ? { kind: "checks" }
            : e.kind === "fact"
              ? { kind: "memory" }
              : undefined,
    }));
  for (const r of t.request)
    events.push({
      id: `request-${r.id}`,
      at: r.createdAt,
      who: `${upper(r.agent)}'s human`,
      text: `asked the orchestrator: "${r.body}"`,
      tone: "accent",
      select: { kind: "request", id: r.id },
    });
  for (const task of t.task) {
    events.push({
      id: `task-${task.id}`,
      at: task.createdAt,
      who: "Orchestrator",
      text: `gave ${upper(task.agent)} task #${task.id}: ${task.title}`,
      tone: "neutral",
      select: { kind: "request", id: task.requestId },
    });
    if (task.status === "done")
      events.push({
        id: `task-done-${task.id}`,
        at: task.updatedAt,
        who: upper(task.agent),
        text: `finished task #${task.id}${task.note ? `: ${task.note}` : ""}`,
        tone: "green",
        select: { kind: "request", id: task.requestId },
      });
  }
  for (const review of t.review)
    if (review.decidedAt > 0 && review.status !== "pending" && review.status !== "cancelled")
      events.push({
        id: `review-${review.id}`,
        at: review.decidedAt,
        who: `${upper(review.reviewer)}'s human`,
        text: `${review.status === "approved" ? "approved" : "sent back"} request #${review.requestId}${review.answer ? `: ${review.answer}` : ""}`,
        tone: review.status === "approved" ? "green" : "red",
        select: { kind: "request", id: review.requestId },
      });
  for (const m of t.message)
    events.push({
      id: `message-${m.id}`,
      at: m.createdAt,
      who: who(m.author),
      text:
        m.kind === "agree"
          ? `agreed on #${m.conflictId}: ${m.body}`
          : m.kind === "escalate"
            ? `asked the humans on #${m.conflictId}: ${m.body}`
            : m.kind === "decision"
              ? `decided #${m.conflictId}: ${m.body}`
              : `in #${m.conflictId}: ${m.body}`,
      tone: m.kind === "agree" ? "green" : m.kind === "escalate" ? "red" : "neutral",
      select: { kind: "conflict", id: m.conflictId },
    });
  return events
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, limit);
}

// ---- The hive (the two hubs in the middle of the graph) --------------------------------------

export interface HiveStats {
  online: number;
  agents: number;
  /** Rows per shared table, only the ones that have rows. */
  rows: Array<{ table: string; count: number }>;
  facts: number;
  latestFact: string;
  /** Agents whose in-progress work sits on a wip/<agent> branch. */
  wip: string[];
  /** The newest green full stack, if any. */
  fullStack?: { branch: string; sha: string };
}

export function hiveStats(t: Tables): HiveStats {
  const facts = t.intent
    .filter((i) => i.verified)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const rows = (
    [
      ["requests", t.request.length],
      ["tasks", t.task.length],
      ["reviews", t.review.length],
      ["messages", t.message.length],
      ["plans", t.intent.length - facts.length],
      ["snapshots", t.snapshot.length],
      ["checks", t.check_run.length],
      ["conflicts", t.conflict.length],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([table, count]) => ({ table, count }));
  const green = byNewest(
    t.build.filter((b) => b.result === "green"),
    (b) => b.createdAt,
  )[0];
  return {
    online: t.agent.filter((a) => a.online).length,
    agents: t.agent.length,
    rows,
    facts: facts.length,
    latestFact: facts[0]?.summary ?? "",
    wip: [...new Set(t.snapshot.map((s) => s.agent))].sort(),
    fullStack: green ? { branch: green.branch, sha: green.sha.slice(0, 8) } : undefined,
  };
}
