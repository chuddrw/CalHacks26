/**
 * shared/src/schema.ts
 *
 * WHAT IT'S FOR
 *   The frozen interface between every part of Agent Cowork: the row shape of each query,
 *   every reducer's name and argument order, and the string formats that cross a boundary
 *   (hook -> SpacetimeDB -> watcher -> UI). Everyone codes against this file, so we freeze it
 *   tonight (plan.md, "Freeze tonight") and change it only when all four of us agree.
 *
 * OWNER: C keeps module/src/index.ts identical to this file. Everyone else reads it.
 * USED BY: hooks/ and scripts/ (HTTP calls), watcher/, mcp/, ui/.
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
 * The generated bindings in ../module_bindings are the typed WebSocket client for the watcher,
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

/** Name the watcher uses when it posts a verified fact to shared memory. */
export const WATCHER_NAME = "watcher";

/** Every message our hooks show an agent starts with this, so the agent (and we) can spot it. */
export const MESSAGE_PREFIX = "[cowork]";

/** Remote branch that holds an agent's latest snapshot. */
export function wipBranch(agent: AgentName): string {
  return `wip/${agent}`;
}

/** Key of one watcher run: the sorted snapshot shas joined with "+". Same shas, same key. */
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

/** Authenticated view `intent`. Shared memory: what agents plan to do, plus facts the watcher verified. Primary key: id. */
export interface IntentRow {
  id: number;
  /** Who posted it. Verified facts use WATCHER_NAME. */
  agent: AgentName;
  summary: string;
  files: string[];
  /** Exported names the change touches, e.g. ["User.lastLogin", "recordLogin"]. */
  symbols: string[];
  /** true = a fact the watcher confirmed with a green check. */
  verified: boolean;
  createdAt: Millis;
}

export type RunResult = "green" | "red";

/** Authenticated view `check_run`. One row per combination of snapshots the watcher checked. Primary key: runKey. */
export interface CheckRunRow {
  runKey: string;
  agents: AgentName[];
  result: RunResult;
  /** tsc + vitest output, cut to 20 KB. */
  log: string;
  createdAt: Millis;
}

/** self = fails on its own; merge = git textual conflict; pair = fails only when combined. */
export type ConflictKind = "self" | "merge" | "pair";
export type ConflictStatus = "open" | "resolved" | "escalated" | "needs_human";

/** Authenticated view `conflict`. At most one open conflict per pair. Primary key: id (auto-increment). */
export interface ConflictRow {
  id: number;
  /** pairKey(agentA, agentB). Lets reducers find the open conflict for a pair. */
  pair: string;
  kind: ConflictKind;
  agentA: AgentName;
  /** "" when kind is "self". */
  agentB: AgentName | "";
  locA: Loc;
  locB: Loc;
  /** The first error, cut to 4 KB. */
  error: string;
  /** Written by Droid or Claude after the conflict is created. "" until then. */
  explanation: string;
  fixer: AgentName;
  status: ConflictStatus;
  /** runKey of the run that found it. */
  runKey: string;
  createdAt: Millis;
  /** 0 until resolved. */
  resolvedAt: Millis;
}

/**
 * conflict = you are the fixer (the listener delivers it and wakes you)
 * info     = a conflict you're part of, but someone else fixes it
 * heads_up = a teammate's intent, or a dependency warning, that touches your files
 * fact     = a verified fact, sent to everyone
 */
export type InboxKind = "conflict" | "info" | "heads_up" | "fact";
/** One-off notes cannot create actionable conflict wakeups without a real conflict ID. */
export type NoteKind = Exclude<InboxKind, "conflict">;

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
} as const;

export interface TableRows {
  agent: AgentRow;
  snapshot: SnapshotRow;
  intent: IntentRow;
  check_run: CheckRunRow;
  conflict: ConflictRow;
  inbox: InboxRow;
  diagnosis_step: DiagnosisStepRow;
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
  /** Historical runs are stored; only current snapshot combinations can change live green status. */
  report_check: [runKey: string, agents: AgentName[], result: RunResult, log: string];
  /**
   * Watcher, when a run is red. One transaction: upsert the open conflict for this pair, set both
   * agents red, write a "conflict" inbox row for the fixer and an "info" row for the other agent,
   * and schedule escalation. Requires a previously reported, current red check covering the pair.
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
  /** Watcher's diagnosis, once per step. */
  add_diagnosis_step: [conflictId: number, source: DiagnosisSource, kind: DiagnosisStepKind, detail: string];
  /**
   * Watcher's diagnosis, final explanation. Hooks render the fixer's message from the conflict row
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
  /** Watcher's guard: the fix edited or deleted a test. */
  flag_needs_human: [conflictId: number, reason: string];
  /** Watcher's dependency heads-up (watcher/src/deps.ts), or any one-off note to one agent. */
  send_note: [agent: AgentName, kind: NoteKind, message: string];
  /** Hooks, right after showing messages to the agent. */
  mark_delivered: [inboxIds: number[]];
  /** Owner-only scripts/demo-reset.ts call. Clears team state while preserving access membership. */
  reset_all: [];
}
export type ReducerName = keyof ReducerArgs;
