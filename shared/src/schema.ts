/**
 * shared/src/schema.ts
 *
 * WHAT IT'S FOR
 *   The frozen interface between every part of Agent Cowork: the row shape of each query,
 *   every reducer's name and argument order, and the string formats that cross a boundary
 *   (hook -> SpacetimeDB -> orchestrator -> UI). Everyone codes against this file, so we freeze it
 *   tonight (plan.md, "Freeze tonight") and change it only when all four of us agree.
 *   Branch feat/orchestrator added the orchestrator's tables (request, task, review, message,
 *   plan_step) and reducers; checklists/orchestrator.md has the design.
 *
 * OWNER: C keeps module/src/index.ts identical to this file. Everyone else reads it.
 * USED BY: hooks/ and scripts/ (HTTP calls), orchestrator/, mcp/, ui/.
 *
 * RULES THAT KEEP HTTP WORKING
 *   - A reducer call over HTTP sends a JSON array of arguments in exactly the order given in
 *     ReducerArgs below. The module's reducer parameters must use the same order.
 *   - SQL over HTTP returns each row as a positional array in the table's column order.
 *     Each Row interface lists its fields in column order, and `Columns` repeats that order so
 *     shared/src/stdb-http.ts can turn arrays into objects. Keep all three in sync with the module.
 *   - Times are milliseconds since the Unix epoch, stored as validated safe-integer f64 values in the module.
 *   - Lists are string arrays. If array columns give us trouble in the chosen SpacetimeDB
 *     version, switch them to comma-joined strings here AND in the module, together.
 *   - Table and column names avoid SQL keywords (no "check", "key", "read", "text", "output").
 *
 * The generated bindings in ../module_bindings are the typed WebSocket client for
 * the MCP server and the UI. If they disagree with this file, fix the module.
 */

/** Query names expose authenticated views over private backing tables. Existing row shapes and
 * reducer argument orders are unchanged. Only admin-approved signed-in identities receive access.
 * Readers can query; Editors can call existing mutators; Owner manages membership and reset_all.
 */
export type AccessRole = "reader" | "editor";

// ---- Formats ------------------------------------------------------------------------

/** COWORK_NAME on that laptop: lowercase, no spaces. Example: "a", "b", "maya". */
export type AgentName = string;

/** "<path relative to the demo-app root>:<1-based line>", e.g. "src/sessions/idle.ts:7". "" when unknown. */
export type Loc = string;

/** Milliseconds since the Unix epoch. */
export type Millis = number;

/**
 * The orchestrator's own name: the author of its plan steps and thread messages, and of the
 * verified facts the module writes to shared memory when a conflict is resolved.
 */
export const ORCHESTRATOR_NAME = "orchestrator";

/** Author of a decision two humans sent from the dashboard (message rows). */
export const HUMAN_AUTHOR = "human";

/** Every message our hooks show an agent starts with this, so the agent (and we) can spot it. */
export const MESSAGE_PREFIX = "[cowork]";

/**
 * The info note a teammate gets when someone pulls its in-progress change with pull_teammate. Code moves
 * through git, so this note is the only record of it: the dashboard draws it as an arrow between the two.
 */
export function pulledNote(puller: AgentName, files: string[]): string {
  return `${MESSAGE_PREFIX} ${puller} pulled your in-progress change into its working tree (${files.join(", ")}).`;
}

/** Who pulled, if `message` is a pulledNote; otherwise null. */
export function pullerOf(message: string): AgentName | null {
  return /^\[cowork\] ([a-z0-9][a-z0-9-]*) pulled your in-progress change/.exec(message)?.[1] ?? null;
}

/** Remote branch that holds an agent's latest snapshot. */
export function wipBranch(agent: AgentName): string {
  return `wip/${agent}`;
}

/** Key of one check run: the sorted snapshot shas joined with "+". Same shas, same key. */
export function runKey(shas: string[]): string {
  return [...shas].sort().join("+");
}

/** Key of an agent pair: both names sorted and joined with "+". A "self" conflict uses just the one name. */
export function pairKey(a: AgentName, b: AgentName | ""): string {
  return b === "" ? a : [a, b].sort().join("+");
}

// ---- Tables (fields are listed in column order) ------------------------------------------

/** Check state shown on the agent's card. Whether the agent is connected is `online`. */
export type AgentStatus = "working" | "green" | "red";

/** Authenticated view `agent`. One row per teammate. Primary key: name. */
export interface AgentRow {
  name: AgentName;
  online: boolean;
  status: AgentStatus;
  /** Latest intent summary, shown on the agent's card. */
  intent: string;
  /** Files in the agent's latest snapshot that differ from main. */
  files: string[];
  lastSnapshotAt: Millis;
}

/** Authenticated view `snapshot`. One row per pushed wip commit. Primary key: id (auto-increment). */
export interface SnapshotRow {
  id: number;
  agent: AgentName;
  /** The wip commit now on wip/<agent>. */
  sha: string;
  /** merge-base of the agent's HEAD and origin/main when the snapshot was taken. */
  baseSha: string;
  files: string[];
  /** Unified diff against baseSha, cut to 50 KB. Display only; git is the source of truth. */
  diff: string;
  createdAt: Millis;
}

/** Authenticated view `intent`. Shared memory: what agents plan to do, plus verified facts. Primary key: id. */
export interface IntentRow {
  id: number;
  /** Who posted it. Verified facts use ORCHESTRATOR_NAME. */
  agent: AgentName;
  summary: string;
  files: string[];
  /** Exported names the change touches, e.g. ["User.lastLogin", "recordLogin"]. */
  symbols: string[];
  /** true = a fact both agents agreed on, confirmed by a green check. */
  verified: boolean;
  createdAt: Millis;
}

export type RunResult = "green" | "red";

/** Authenticated view `check_run`. One row per combination of snapshots an agent's check_with_team ran. Primary key: runKey. */
export interface CheckRunRow {
  runKey: string;
  agents: AgentName[];
  result: RunResult;
  /** tsc + vitest output, cut to 20 KB. */
  log: string;
  createdAt: Millis;
}

/**
 * self = fails on its own; merge = git textual conflict; pair = fails only when combined;
 * potential = the orchestrator expects two agents' work to clash, before any check fails.
 */
export type ConflictKind = "self" | "merge" | "pair" | "potential";
/**
 * open = the two agents are talking it out; escalated = they couldn't, both humans decide on the
 * dashboard; needs_human = a fix changed existing tests; resolved = both agreed and a check is green.
 */
export type ConflictStatus = "open" | "resolved" | "escalated" | "needs_human";

/**
 * Authenticated view `conflict`. A conflict is a thread between two agents (messages are in the
 * `message` view). At most one active conflict per pair. Primary key: id (auto-increment).
 */
export interface ConflictRow {
  id: number;
  /** pairKey(agentA, agentB). Lets reducers find the open conflict for a pair. */
  pair: string;
  kind: ConflictKind;
  agentA: AgentName;
  /** "" when kind is "self". */
  agentB: AgentName | "";
  /** Where each side's change is. "" for a potential conflict. */
  locA: Loc;
  locB: Loc;
  /** The first error, cut to 4 KB. For a potential conflict: the orchestrator's topic and reason. */
  error: string;
  /** Legacy diagnosis text (no longer written at run time). "" by default. */
  explanation: string;
  /**
   * The agent suggested to adapt: for a check, the agent whose change contains the error; for a
   * potential conflict, the orchestrator's suggestion. A suggestion only: the two agents agree on
   * who changes what in the thread.
   */
  fixer: AgentName;
  status: ConflictStatus;
  /** runKey of the run that found it. "" for a potential conflict. */
  runKey: string;
  createdAt: Millis;
  /** 0 until resolved. */
  resolvedAt: Millis;
}

/**
 * conflict = a conflict thread with you opened (the listener wakes you)
 * task     = the orchestrator assigned you a task (wakes you)
 * message  = a teammate's message in your conflict thread, or your humans' decision (wakes you)
 * info     = a status note: a request planned or sent back, a review, someone else's progress
 * heads_up = a teammate's intent that touches your files
 * fact     = a verified fact, sent to everyone
 */
export type InboxKind = "conflict" | "task" | "message" | "info" | "heads_up" | "fact";
/** Kinds the listener wakes an agent for. The rest wait for the next tool call or prompt. */
export const WAKE_KINDS: readonly InboxKind[] = ["conflict", "task", "message"];
/** One-off notes (send_note) can't create wakeups: those need a real task or conflict. */
export type NoteKind = "info" | "heads_up" | "fact";

/** Authenticated view `inbox`. One row per message per recipient. Primary key: id (auto-increment). */
export interface InboxRow {
  id: number;
  /** Recipient. */
  agent: AgentName;
  kind: InboxKind;
  /** 0 when the message isn't about a conflict. */
  conflictId: number;
  message: string;
  /** true once a hook has shown it to the agent. */
  delivered: boolean;
  createdAt: Millis;
}

export type DiagnosisSource = "droid" | "claude";
export type DiagnosisStepKind = "status" | "tool_call" | "tool_result" | "thought" | "final" | "error";

/** Authenticated view `diagnosis_step`. What Droid (or Claude) did, streamed to the UI's Droid panel. Primary key: id. */
export interface DiagnosisStepRow {
  id: number;
  conflictId: number;
  source: DiagnosisSource;
  kind: DiagnosisStepKind;
  /** One step, cut to 2 KB. */
  detail: string;
  createdAt: Millis;
}

/**
 * new = a human just asked; planning = the orchestrator's Droid is working on it;
 * waiting_review = planned, its tasks wait for every review; assigned = its tasks are out;
 * done = every task is finished; rejected = a reviewer sent it back; failed = no plan came out.
 */
export type RequestStatus = "new" | "planning" | "waiting_review" | "assigned" | "done" | "rejected" | "failed";

/** Authenticated view `request`. What a human asked the orchestrator for. Primary key: id (auto-increment). */
export interface RequestRow {
  id: number;
  /** The agent whose human asked; it forwarded the request with the ask_orchestrator tool. */
  agent: AgentName;
  /** The request, in the human's words. Cut to 4 KB. */
  body: string;
  status: RequestStatus;
  /** The orchestrator's plan in a few sentences, or why planning failed. "" until then. */
  summary: string;
  /** The published plan (PlanInput as JSON). Its conflicts open once every review is approved. */
  plan: string;
  createdAt: Millis;
  updatedAt: Millis;
}

/** waiting_review = held until every review of its request is approved. */
export type TaskStatus = "waiting_review" | "assigned" | "done" | "cancelled";

/** Authenticated view `task`. One piece of a plan, for the agent that owns that feature. Primary key: id. */
export interface TaskRow {
  id: number;
  requestId: number;
  /** The assignee: the agent responsible for this feature (cowork.owners.json). */
  agent: AgentName;
  title: string;
  details: string;
  /** Files the task is expected to change. */
  files: string[];
  /** true = changes a shared contract or another owner's feature, so a human reviewed it first. */
  major: boolean;
  status: TaskStatus;
  /** The agent's summary when done, or why it was cancelled. */
  note: string;
  createdAt: Millis;
  updatedAt: Millis;
}

export type ReviewStatus = "pending" | "approved" | "rejected" | "cancelled";

/** Authenticated view `review`. A major change waiting for the human whose feature it affects. Primary key: id. */
export interface ReviewRow {
  id: number;
  requestId: number;
  /** The agent whose human must review: the owner of the affected feature. */
  reviewer: AgentName;
  /** What changes and how it affects the reviewer's feature. */
  summary: string;
  status: ReviewStatus;
  /** The reviewer's note from the dashboard. */
  answer: string;
  createdAt: Millis;
  /** 0 until decided. */
  decidedAt: Millis;
}

/**
 * message = one agent talking to the other; agree = "I agree, my side is done" (both agree plus a
 * green check resolves the conflict); escalate = hand it to both humans; decision = the humans' answer.
 */
export type MessageKind = "message" | "agree" | "escalate" | "decision";
/** What an agent may post with post_message. Decisions come from the dashboard (decide_conflict). */
export type AgentMessageKind = Exclude<MessageKind, "decision">;

/** Authenticated view `message`. The conversation inside a conflict thread. Primary key: id. */
export interface MessageRow {
  id: number;
  conflictId: number;
  /** An agent name, ORCHESTRATOR_NAME, or HUMAN_AUTHOR. */
  author: string;
  kind: MessageKind;
  /** Cut to 4 KB. */
  body: string;
  createdAt: Millis;
}

/** Authenticated view `plan_step`. What the orchestrator's Droid did for a request, streamed to the UI. */
export interface PlanStepRow {
  id: number;
  requestId: number;
  kind: DiagnosisStepKind;
  /** One step, cut to 2 KB. */
  detail: string;
  createdAt: Millis;
}

/**
 * The branch where the orchestrator keeps the team's full stack: main plus every agent's latest
 * work, merged and checked. It works like the team's main: only green builds are pushed to it, and
 * every laptop can run it (get_full_stack). The real main is never written.
 */
export const FULL_STACK_BRANCH = "cowork/full-stack";

/**
 * Authenticated view `build`. One row per full-stack build the orchestrator recorded: a green one was
 * pushed to `branch`; a red one (only recorded when a finished request triggered it) says why not.
 * Primary key: id (auto-increment).
 */
export interface BuildRow {
  id: number;
  /** FULL_STACK_BRANCH for a green build; "" for a red one (nothing was pushed). */
  branch: string;
  /** The merged commit: main plus every agent's latest snapshot. */
  sha: string;
  /** The main commit it was built on. */
  mainSha: string;
  /** Agents whose work is in it. */
  agents: AgentName[];
  result: RunResult;
  /** What it contains, or why it's red. Cut to 4 KB. */
  log: string;
  /** The request whose completion triggered it; 0 for a build after ordinary progress. */
  requestId: number;
  createdAt: Millis;
}

/**
 * The plan the orchestrator publishes for one request (publish_plan's `plan` argument, as JSON).
 * The module validates it and writes it in one transaction.
 */
export interface PlanInput {
  tasks: Array<{ agent: AgentName; title: string; details: string; files: string[]; major: boolean }>;
  /** One per human whose feature a major task affects. Any review holds every task of the request. */
  reviews: Array<{ reviewer: AgentName; summary: string }>;
  /** Overlaps Droid expects between two agents' work. They open as "potential" conflicts. */
  conflicts: Array<{ agentA: AgentName; agentB: AgentName; topic: string; details: string; suggested: AgentName }>;
}

// The module also has a private schedule table `escalation_timer` (scheduled id, scheduled time,
// conflict id) that calls the `escalate` reducer a few minutes after a conflict opens.
// Clients never use it.

/** Column order per table, used to turn SQL-over-HTTP rows (arrays) into objects. */
export const Columns = {
  agent: ["name", "online", "status", "intent", "files", "lastSnapshotAt"],
  snapshot: ["id", "agent", "sha", "baseSha", "files", "diff", "createdAt"],
  intent: ["id", "agent", "summary", "files", "symbols", "verified", "createdAt"],
  check_run: ["runKey", "agents", "result", "log", "createdAt"],
  conflict: [
    "id", "pair", "kind", "agentA", "agentB", "locA", "locB", "error",
    "explanation", "fixer", "status", "runKey", "createdAt", "resolvedAt",
  ],
  inbox: ["id", "agent", "kind", "conflictId", "message", "delivered", "createdAt"],
  diagnosis_step: ["id", "conflictId", "source", "kind", "detail", "createdAt"],
  request: ["id", "agent", "body", "status", "summary", "plan", "createdAt", "updatedAt"],
  task: ["id", "requestId", "agent", "title", "details", "files", "major", "status", "note", "createdAt", "updatedAt"],
  review: ["id", "requestId", "reviewer", "summary", "status", "answer", "createdAt", "decidedAt"],
  message: ["id", "conflictId", "author", "kind", "body", "createdAt"],
  plan_step: ["id", "requestId", "kind", "detail", "createdAt"],
  build: ["id", "branch", "sha", "mainSha", "agents", "result", "log", "requestId", "createdAt"],
} as const;

export interface TableRows {
  agent: AgentRow;
  snapshot: SnapshotRow;
  intent: IntentRow;
  check_run: CheckRunRow;
  conflict: ConflictRow;
  inbox: InboxRow;
  diagnosis_step: DiagnosisStepRow;
  request: RequestRow;
  task: TaskRow;
  review: ReviewRow;
  message: MessageRow;
  plan_step: PlanStepRow;
  build: BuildRow;
}
export type TableName = keyof TableRows;

// ---- Reducers -----------------------------------------------------------------------------

/** Arguments of each reducer, in call order. Over HTTP the request body is this tuple as a JSON array. */
export interface ReducerArgs {
  /** Database owner only. Identity is a public 64-hex string, never an auth token. */
  grant_access: [identity: string, role: AccessRole];
  /** Database owner only. Revocation removes access and retires that identity's presence. */
  revoke_access: [identity: string];
  /** MCP server, on connect. Marks the agent online and remembers its connection for client_disconnected. */
  register_agent: [agent: AgentName];
  /** Snapshot hook, after a successful push. Sets the agent to "working" and updates its files. */
  post_snapshot: [agent: AgentName, sha: string, baseSha: string, files: string[], diff: string];
  /** MCP tool post_intent. Also writes a heads_up inbox row for every other agent. */
  post_intent: [agent: AgentName, summary: string, files: string[], symbols: string[]];
  /**
   * An agent's check_with_team, once per combination it checked. Historical runs are stored; only
   * current snapshot combinations can change live green status.
   */
  report_check: [runKey: string, agents: AgentName[], result: RunResult, log: string];
  /**
   * An agent's check_with_team, when it and a teammate are red together. One transaction: upsert the
   * open conflict for this pair, set both agents red, write a "conflict" inbox row for the suggested
   * agent (`fixer`) and an "info" row for the other, and schedule escalation. Requires a previously
   * reported, current red check covering the pair. The suggested agent's first message wakes the other.
   */
  report_conflict: [
    kind: ConflictKind,
    agentA: AgentName,
    agentB: AgentName | "",
    locA: Loc,
    locB: Loc,
    error: string,
    fixer: AgentName,
    runKey: string,
  ];
  /** Legacy diagnosis (the watcher's Droid explanation), once per step. Not called at run time any more. */
  add_diagnosis_step: [conflictId: number, source: DiagnosisSource, kind: DiagnosisStepKind, detail: string];
  /**
   * Legacy diagnosis, final explanation. Hooks render the fixer's message from the conflict row
   * at delivery time, so an undelivered message picks it up by itself. If the fixer already got the
   * message, the module also sends the explanation as an "info" note.
   */
  /** @deprecated Concurrent diagnosis must use set_explanation_if_current to reject stale writes atomically. */
  set_explanation: [conflictId: number, explanation: string];
  /** Atomic diagnosis publication; a changed run, error, fixer, or nonactive status is ignored. */
  set_explanation_if_current: [conflictId: number, expectedRunKey: string, expectedError: string, expectedFixer: AgentName, explanation: string];
  /** Legacy resolution requires a current covering green check. Prefer the explicit version-checked call below. */
  resolve_conflict: [conflictId: number, verifiedFact: string];
  /** Resolve only this conflict version using an explicitly named, current covering green check. */
  resolve_conflict_if_current: [conflictId: number, expectedRunKey: string, expectedError: string, expectedFixer: AgentName, verifiedRunKey: string, verifiedFact: string];
  /** The test guard (an agent's agree tool): the fix edited or deleted a test. */
  flag_needs_human: [conflictId: number, reason: string];
  /**
   * A person's answer to a needs_human conflict (dashboard buttons or scripts/review.ts).
   * approve: resolves it; needs a current green check. reject: reopens it and wakes the fixer to
   * put the tests back; no check resolves it until the fixer posts a newer snapshot.
   */
  review_test_change: [conflictId: number, approve: boolean, comment: string];
  /** Any one-off note to one agent. */
  send_note: [agent: AgentName, kind: NoteKind, message: string];
  /** Hooks, right after showing messages to the agent. */
  mark_delivered: [inboxIds: number[]];
  /** Owner-only scripts/demo-reset.ts call. Clears team state while preserving access membership. */
  reset_all: [];

  // ---- Orchestrator (branch feat/orchestrator) ----
  /** MCP tool ask_orchestrator: a human's request, forwarded by their own agent. Creates a "new" request. */
  submit_request: [agent: AgentName, body: string];
  /** Orchestrator: it picked the request up (new -> planning). */
  start_request: [requestId: number];
  /** Orchestrator: one step of its Droid session, for the dashboard. */
  add_plan_step: [requestId: number, kind: DiagnosisStepKind, detail: string];
  /**
   * Orchestrator: the whole plan (PlanInput as JSON) in one transaction. With reviews, the tasks wait
   * (waiting_review) and each reviewer's agent gets an info note; without, every assignee gets a
   * "task" wakeup and the flagged conflicts open, waking both agents of each.
   */
  publish_plan: [requestId: number, summary: string, plan: string];
  /** Orchestrator: planning failed or produced nothing usable. The requester's agent is told why. */
  fail_request: [requestId: number, reason: string];
  /**
   * Dashboard: a person's answer to a review. Approve: once no review of the request is pending, its
   * tasks go out and its conflicts open. Send back: the request's held tasks are cancelled and the
   * requester's agent is told why.
   */
  decide_review: [reviewId: number, approve: boolean, answer: string];
  /** MCP tool complete_task. Only the assignee; needs a current green check that includes it. */
  complete_task: [taskId: number, agent: AgentName, summary: string];
  /**
   * MCP tools message_teammate, agree and escalate: one message in a conflict thread, which wakes the
   * other agent. When both agents' latest messages are "agree" and a current green check covers
   * them, the conflict resolves and the last agreement becomes a verified fact. "escalate", or 12
   * messages without that, hands the conflict to both humans.
   */
  post_message: [conflictId: number, agent: AgentName, kind: AgentMessageKind, body: string];
  /** Dashboard: both humans' decision on a conflict. Reopens it and wakes both agents with the decision. */
  decide_conflict: [conflictId: number, decision: string];
  /**
   * Orchestrator: a full-stack build. A green one built for a finished request (requestId > 0)
   * sends every agent an info note: the full stack is ready, call get_full_stack.
   */
  publish_build: [branch: string, sha: string, mainSha: string, agents: AgentName[], result: RunResult, log: string, requestId: number];
}
export type ReducerName = keyof ReducerArgs;
