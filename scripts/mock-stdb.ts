/**
 * scripts/mock-stdb.ts
 *
 * WHAT IT'S FOR
 *   A stand-in for our SpacetimeDB database for work without a server: the same two HTTP endpoints
 *   the hooks and scripts use, every table from shared/src/schema.ts in memory, and every reducer
 *   behaving the way Part C's module (module/src/index.ts) does: the same validation, the same
 *   "current, covering check" rules, the same inbox wording, and the orchestrator's requests, plans,
 *   reviews, tasks and conflict threads (branch feat/orchestrator). A's end-to-end test runs against
 *   it, and B and D can point at it too (npm run seed works).
 *
 * OWNER: A. Kept in step with module/src/index.ts by hand: when a reducer changes there, change it
 *        here too. Updated during the A+B+C integration (Oct 24) to Part C's guarded reducers.
 * USAGE: npm run mock-db        (listens on http://127.0.0.1:3077; set MOCK_STDB_PORT to change it)
 *   then run the hooks/scripts with STDB_HOST=http://127.0.0.1:3077 STDB_DB=mock STDB_TOKEN=anything
 *   in the process environment. hooks/test/e2e.ts starts its own copy with startMockStdb().
 *
 * ENDPOINTS
 *   POST /v1/database/mock/call/<reducer>   JSON array of arguments, same order as ReducerArgs
 *   POST /v1/database/mock/sql              only `SELECT * FROM <table> [WHERE col = value AND ...]`
 *   GET  /v1/database/mock/dump             mock only: every table as JSON, for debugging
 *   Calls without "Authorization: Bearer <anything>" get 401. A reducer error is a 400 with its message.
 *
 * WHERE IT DIFFERS FROM THE REAL MODULE
 *   - No identities or roles: any bearer token is an Editor and the Owner. grant_access and
 *     revoke_access are accepted and do nothing.
 *   - No connections: register_agent marks the agent online over HTTP (the real module rejects it
 *     without a live WebSocket), and nothing ever marks an agent offline.
 *   - No WebSocket subscriptions, so the watcher and the UI need a real server (local or cloud).
 *   - No persistence: restarting it empties every table. Escalation uses a timer in memory.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Columns,
  HUMAN_AUTHOR,
  ORCHESTRATOR_NAME,
  type ConflictRow,
  type PlanInput,
  type ReducerArgs,
  type ReducerName,
  type RequestRow,
  type TableName,
  type TableRows,
} from "../shared/src/schema.ts";

export const MOCK_DB_NAME = "mock";
const DEFAULT_PORT = 3077;
const ESCALATE_MS = 5 * 60_000;

type Tables = { [K in TableName]: TableRows[K][] };

export interface MockStdb {
  url: string;
  port: number;
  /** The live tables, for tests to inspect. */
  db: Tables;
  /** Every reducer call that succeeded, in order. */
  calls: Array<{ reducer: string; args: unknown[] }>;
  close(): Promise<void>;
}

/** A reducer error: the real module's SenderError. */
class SenderError extends Error {}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ARITY: Record<ReducerName, number> = {
  grant_access: 2,
  revoke_access: 1,
  register_agent: 1,
  post_snapshot: 5,
  post_intent: 4,
  report_check: 4,
  report_conflict: 8,
  add_diagnosis_step: 4,
  set_explanation: 2,
  set_explanation_if_current: 5,
  resolve_conflict: 2,
  resolve_conflict_if_current: 6,
  flag_needs_human: 2,
  review_test_change: 3,
  send_note: 3,
  mark_delivered: 1,
  reset_all: 0,
  submit_request: 2,
  start_request: 1,
  add_plan_step: 3,
  publish_plan: 3,
  fail_request: 2,
  decide_review: 3,
  complete_task: 3,
  post_message: 4,
  decide_conflict: 2,
};

/** Messages in one thread, since the last human decision, before it goes to both humans. */
const MAX_MESSAGES = 12;

function emptyTables(): Tables {
  return {
    agent: [], snapshot: [], intent: [], check_run: [], conflict: [], inbox: [], diagnosis_step: [],
    request: [], task: [], review: [], message: [], plan_step: [],
  };
}

// ---- Validation helpers, as in module/src/index.ts ---------------------------------------------

function name(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) throw new SenderError("Invalid agent name");
}
function oneOf(value: string, values: readonly string[]): void {
  if (!values.includes(value)) throw new SenderError(`Invalid value: ${value}`);
}
/** Cuts to a UTF-8 byte limit without splitting characters. */
function cut(value: string, limit: number): string {
  let bytes = 0;
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > limit) break;
    result += char;
  }
  return result;
}

export async function startMockStdb(options: { port?: number; escalateMs?: number } = {}): Promise<MockStdb> {
  const db = emptyTables();
  const calls: MockStdb["calls"] = [];
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Part C's test_review table: conflict id -> the fixer's latest snapshot id when a person sent the fix back. */
  const reviews = new Map<number, number>();
  const escalateMs = options.escalateMs ?? ESCALATE_MS;
  let nextId = 1;
  const now = () => Date.now();

  const ensureAgent = (value: string) => {
    name(value);
    let row = db.agent.find((a) => a.name === value);
    if (!row) {
      row = { name: value, online: false, status: "green", intent: "", files: [], lastSnapshotAt: 0 };
      db.agent.push(row);
    }
    return row;
  };
  const active = (status: string) => status !== "resolved";
  const refresh = (value: string) => {
    if (!value) return;
    const row = ensureAgent(value);
    // A potential conflict is a prediction, not a failed check: it never turns an agent red.
    const blocked = db.conflict.some((c) => active(c.status) && c.kind !== "potential" && (c.agentA === value || c.agentB === value));
    row.status = blocked ? "red" : "green";
  };
  const note = (recipient: string, kind: TableRows["inbox"]["kind"], conflictId: number, message: string) => {
    ensureAgent(recipient);
    db.inbox.push({ id: nextId++, agent: recipient, kind, conflictId, message, delivered: false, createdAt: now() });
  };
  const getConflict = (id: number): ConflictRow => {
    const row = db.conflict.find((c) => c.id === id);
    if (!row) throw new SenderError(`Unknown conflict #${id}`);
    return row;
  };
  /** Snapshot ids define posting order. */
  const currentRun = (run: { runKey: string; agents: string[] }): boolean => {
    const agents = new Set(run.agents);
    if (!agents.size || agents.size !== run.agents.length) return false;
    const latest = new Map<string, { id: number; sha: string }>();
    for (const snapshot of db.snapshot) {
      if (!agents.has(snapshot.agent)) continue;
      const previous = latest.get(snapshot.agent);
      if (!previous || snapshot.id > previous.id) latest.set(snapshot.agent, snapshot);
    }
    return latest.size === agents.size && [...latest.values()].map((row) => row.sha).sort().join("+") === run.runKey;
  };
  const covers = (run: { agents: string[] }, conflict: { agentA: string; agentB: string }) =>
    run.agents.includes(conflict.agentA) && (!conflict.agentB || run.agents.includes(conflict.agentB));
  const mutableConflict = (row: ConflictRow) => row.status === "open" || row.status === "escalated";
  const matchesVersion = (row: ConflictRow, expected: { expectedRunKey: string; expectedError: string; expectedFixer: string }) =>
    mutableConflict(row) && row.runKey === expected.expectedRunKey && row.error === expected.expectedError && row.fixer === expected.expectedFixer;
  const greenEvidence = (conflict: ConflictRow, runKey?: string) => {
    const runs = runKey === undefined ? db.check_run : db.check_run.filter((r) => r.runKey === runKey);
    return runs.some((run) => run.result === "green" && covers(run, conflict) && currentRun(run));
  };
  const latestSnapshotId = (agent: string) => db.snapshot.reduce((id, row) => (row.agent === agent && row.id > id ? row.id : id), 0);
  const sentBack = (row: ConflictRow) => reviews.has(row.id) && latestSnapshotId(row.fixer) <= reviews.get(row.id)!;
  const scheduleEscalation = (id: number) => {
    const timer = setTimeout(() => {
      const row = db.conflict.find((c) => c.id === id);
      if (row?.status === "open") escalateToHumans(row, ORCHESTRATOR_NAME, "Still open after 5 minutes.");
    }, escalateMs);
    timer.unref();
    timers.set(id, timer);
  };
  const retireWakeups = (id: number) => {
    for (const message of db.inbox) if (message.conflictId === id && message.kind === "conflict") message.delivered = true;
  };
  const stopTimer = (id: number) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
  };
  const writeExplanation = (row: ConflictRow, explanation: string) => {
    if (row.explanation === explanation) return;
    row.explanation = explanation;
    const latestWakeup = db.inbox
      .filter((m) => m.conflictId === row.id && m.agent === row.fixer && m.kind === "conflict")
      .sort((a, b) => b.id - a.id)[0];
    if (latestWakeup?.delivered) note(row.fixer, "info", row.id, `[cowork] Diagnosis for conflict #${row.id}: ${explanation}`);
  };
  const finishResolution = (row: ConflictRow, verifiedFact: string) => {
    row.status = "resolved";
    row.resolvedAt = now();
    retireWakeups(row.id);
    stopTimer(row.id);
    reviews.delete(row.id);
    refresh(row.agentA);
    if (row.agentB) refresh(row.agentB);
    if (verifiedFact.trim()) {
      const files = [...new Set([
        ...(db.agent.find((a) => a.name === row.agentA)?.files ?? []),
        ...(db.agent.find((a) => a.name === row.agentB)?.files ?? []),
      ])];
      db.intent.push({ id: nextId++, agent: ORCHESTRATOR_NAME, summary: verifiedFact, files, symbols: [], verified: true, createdAt: now() });
      for (const recipient of [...db.agent]) note(recipient.name, "fact", row.id, `[cowork] Verified fact: ${verifiedFact}`);
    }
  };

  // ---- Orchestrator, as in module/src/index.ts ----
  const getRequest = (id: number): RequestRow => {
    const row = db.request.find((r) => r.id === id);
    if (!row) throw new SenderError(`Unknown request #${id}`);
    return row;
  };
  const touch = (row: RequestRow, changes: Partial<RequestRow>) => Object.assign(row, changes, { updatedAt: now() });
  const participants = (row: ConflictRow) => [row.agentA, row.agentB].filter(Boolean);
  const post = (conflictId: number, author: string, kind: TableRows["message"]["kind"], body: string) => {
    db.message.push({ id: nextId++, conflictId, author, kind, body: cut(body, 4 * 1024), createdAt: now() });
  };
  const retireThreadWakeups = (id: number) => {
    for (const row of db.inbox) if (row.conflictId === id && (row.kind === "conflict" || row.kind === "message")) row.delivered = true;
  };
  const sinceDecision = (id: number) => {
    const all = db.message.filter((m) => m.conflictId === id).sort((a, b) => a.id - b.id);
    return all.slice(all.map((m) => m.kind).lastIndexOf("decision") + 1);
  };
  const bothAgreed = (row: ConflictRow) => {
    const recent = sinceDecision(row.id);
    return participants(row).every((agent) => recent.filter((m) => m.author === agent).at(-1)?.kind === "agree");
  };
  const pairGreen = (row: ConflictRow) => {
    const changed = participants(row).filter((agent) => latestSnapshotId(agent) > 0);
    if (changed.length === 0) return true;
    return db.check_run.some((run) => run.result === "green" && changed.every((agent) => run.agents.includes(agent)) && currentRun(run));
  };
  const escalateToHumans = (row: ConflictRow, by: string, reason: string) => {
    row.status = "escalated";
    stopTimer(row.id);
    retireThreadWakeups(row.id);
    post(row.id, by, "escalate", reason);
    for (const agent of participants(row)) {
      note(agent, "info", row.id, `[cowork] Conflict #${row.id} went to both humans: ${reason} Stop working on it; their decision will wake you.`);
    }
  };
  const parsePlan = (json: string): PlanInput => {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      throw new SenderError("The plan must be JSON");
    }
    const record = (item: unknown, label: string): Record<string, unknown> => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new SenderError(`${label} must be an object`);
      return item as Record<string, unknown>;
    };
    const text = (item: unknown, label: string, limit: number, required = true): string => {
      if (typeof item !== "string") throw new SenderError(`${label} must be text`);
      const result = cut(item.trim(), limit);
      if (required && !result) throw new SenderError(`${label} is empty`);
      return result;
    };
    const agentName = (item: unknown, label: string) => {
      const result = text(item, label, 64);
      name(result);
      return result;
    };
    const plan = record(value, "plan");
    const list = (key: string, max: number): unknown[] => {
      const items = plan[key] ?? [];
      if (!Array.isArray(items)) throw new SenderError(`plan.${key} must be a list`);
      if (items.length > max) throw new SenderError(`plan.${key} has more than ${max} entries`);
      return items;
    };
    const tasks = list("tasks", 20).map((item, index) => {
      const task = record(item, `plan.tasks[${index}]`);
      const files = task.files ?? [];
      if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) throw new SenderError(`plan.tasks[${index}].files must be a list of paths`);
      return {
        agent: agentName(task.agent, `plan.tasks[${index}].agent`),
        title: text(task.title, `plan.tasks[${index}].title`, 200),
        details: text(task.details ?? "", `plan.tasks[${index}].details`, 4 * 1024, false),
        files: (files as string[]).slice(0, 50).map((file) => cut(file, 300)),
        major: task.major === true,
      };
    });
    const reviews: PlanInput["reviews"] = [];
    for (const [index, item] of list("reviews", 10).entries()) {
      const review = record(item, `plan.reviews[${index}]`);
      const reviewer = agentName(review.reviewer, `plan.reviews[${index}].reviewer`);
      const summary = text(review.summary, `plan.reviews[${index}].summary`, 2 * 1024);
      if (!reviews.some((existing) => existing.reviewer === reviewer)) reviews.push({ reviewer, summary });
    }
    const conflicts = list("conflicts", 10).map((item, index) => {
      const conflict = record(item, `plan.conflicts[${index}]`);
      const agentA = agentName(conflict.agentA, `plan.conflicts[${index}].agentA`);
      const agentB = agentName(conflict.agentB, `plan.conflicts[${index}].agentB`);
      if (agentA === agentB) throw new SenderError(`plan.conflicts[${index}] needs two different agents`);
      const suggested = typeof conflict.suggested === "string" && [agentA, agentB].includes(conflict.suggested) ? conflict.suggested : agentB;
      return {
        agentA, agentB, suggested,
        topic: text(conflict.topic, `plan.conflicts[${index}].topic`, 200),
        details: text(conflict.details ?? "", `plan.conflicts[${index}].details`, 2 * 1024, false),
      };
    });
    return { tasks, reviews, conflicts };
  };
  const openPotential = (requestId: number, c: PlanInput["conflicts"][number]) => {
    const pair = [c.agentA, c.agentB].sort().join("+");
    const said = `${c.topic}${c.details ? `. ${c.details}` : ""}`;
    const existing = db.conflict.find((row) => row.pair === pair && active(row.status));
    if (existing) {
      post(existing.id, ORCHESTRATOR_NAME, "message", `Request #${requestId} touches this too: ${said}`);
      if (existing.status === "open") {
        for (const agent of participants(existing)) note(agent, "message", existing.id, `[cowork] The orchestrator added to conflict #${existing.id}: ${c.topic}`);
      }
      return;
    }
    const id = nextId++;
    db.conflict.push({
      id, pair, kind: "potential", agentA: c.agentA, agentB: c.agentB, locA: "", locB: "",
      error: cut(`${c.topic}\n${c.details}`.trim(), 4 * 1024), explanation: "", fixer: c.suggested,
      status: "open", runKey: "", createdAt: now(), resolvedAt: 0,
    });
    post(id, ORCHESTRATOR_NAME, "message", `${said} Suggested: ${c.suggested} adapts. Agree between you who changes what.`);
    for (const agent of [c.agentA, c.agentB]) note(agent, "conflict", id, `[cowork] Conflict #${id} with ${agent === c.agentA ? c.agentB : c.agentA}: ${c.topic}`);
    scheduleEscalation(id);
  };
  const releasePlan = (request: RequestRow) => {
    let count = 0;
    for (const row of db.task) {
      if (row.requestId !== request.id || row.status !== "waiting_review") continue;
      Object.assign(row, { status: "assigned", updatedAt: now() });
      note(row.agent, "task", row.id, `[cowork] Task #${row.id} from the orchestrator: ${row.title}`);
      count++;
    }
    touch(request, { status: count ? "assigned" : "done" });
    for (const conflict of parsePlan(request.plan || "{}").conflicts) openPotential(request.id, conflict);
  };

  const reducers: { [R in ReducerName]: (args: ReducerArgs[R]) => void } = {
    grant_access: () => {},
    revoke_access: () => {},
    register_agent: ([agent]) => {
      ensureAgent(agent).online = true;
    },
    post_snapshot: ([agent, sha, baseSha, files, diff]) => {
      const row = ensureAgent(agent);
      const createdAt = now();
      db.snapshot.push({ id: nextId++, agent, sha, baseSha, files, diff: cut(diff, 50 * 1024), createdAt });
      const blocked = db.conflict.some((c) => c.status === "needs_human" && (c.agentA === agent || c.agentB === agent));
      Object.assign(row, { status: blocked ? "red" : "working", files, lastSnapshotAt: createdAt });
    },
    post_intent: ([agent, summary, files, symbols]) => {
      const row = ensureAgent(agent);
      db.intent.push({ id: nextId++, agent, summary, files, symbols, verified: false, createdAt: now() });
      row.intent = summary;
      for (const other of [...db.agent]) {
        if (other.name !== agent) note(other.name, "heads_up", 0, `[cowork] ${agent} plans: ${summary} (files: ${files.join(", ")})`);
      }
    },
    report_check: ([runKey, agents, result, log]) => {
      oneOf(result, ["green", "red"]);
      agents.forEach(name);
      const row = { runKey, agents, result, log: cut(log, 20 * 1024), createdAt: now() };
      const index = db.check_run.findIndex((r) => r.runKey === runKey);
      if (index >= 0) db.check_run[index] = row;
      else db.check_run.push(row);
      if (result === "green" && currentRun(row)) for (const agent of agents) refresh(agent);
    },
    report_conflict: ([kind, agentA, agentB, locA, locB, error, fixer, runKey]) => {
      oneOf(kind, ["self", "merge", "pair"]);
      name(agentA);
      if (kind === "self" ? agentB !== "" : !agentB || agentA === agentB) {
        throw new SenderError("self requires one agent; merge/pair require two distinct agents");
      }
      if (agentB) name(agentB);
      if (fixer !== agentA && fixer !== agentB) throw new SenderError("Fixer must belong to conflict");
      const check = db.check_run.find((r) => r.runKey === runKey);
      if (!check || check.result !== "red" || !covers(check, { agentA, agentB })) {
        throw new SenderError("Conflict requires a red check covering its agents");
      }
      if (!currentRun(check)) return;
      const pair = agentB ? [agentA, agentB].sort().join("+") : agentA;
      const existing = db.conflict.find((c) => c.pair === pair && active(c.status));
      const cutError = cut(error, 4 * 1024);
      const other = fixer === agentA ? agentB : agentA;
      if (existing) {
        const changed = existing.error !== cutError || existing.fixer !== fixer;
        const keepExplanation = existing.error === cutError && existing.fixer === fixer;
        Object.assign(existing, { kind, agentA, agentB, locA, locB, error: cutError, fixer, runKey, explanation: keepExplanation ? existing.explanation : "" });
        if (changed && existing.status !== "needs_human") {
          retireWakeups(existing.id);
          const why = existing.kind === "potential" ? `The combined check now fails for conflict #${existing.id}.` : "Still red after your last change.";
          note(fixer, "conflict", existing.id, `[cowork] ${why} Conflict #${existing.id}: you are the fixer`);
          if (other) note(other, "info", existing.id, `[cowork] Conflict #${existing.id}: ${fixer} is the fixer`);
        }
      } else {
        const id = nextId++;
        db.conflict.push({
          id, pair, kind: kind as ConflictRow["kind"], agentA, agentB, locA, locB, error: cutError, explanation: "", fixer,
          status: "open", runKey, createdAt: now(), resolvedAt: 0,
        });
        note(fixer, "conflict", id, `[cowork] Conflict #${id}: you are the fixer`);
        if (other) note(other, "info", id, `[cowork] Conflict #${id}: ${fixer} is the fixer`);
        scheduleEscalation(id);
      }
      refresh(agentA);
      if (agentB) refresh(agentB);
    },
    add_diagnosis_step: ([conflictId, source, kind, detail]) => {
      getConflict(conflictId);
      oneOf(source, ["droid", "claude"]);
      oneOf(kind, ["status", "tool_call", "tool_result", "thought", "final", "error"]);
      db.diagnosis_step.push({ id: nextId++, conflictId, source, kind, detail: cut(detail, 2 * 1024), createdAt: now() });
    },
    set_explanation: ([conflictId, explanation]) => {
      const row = getConflict(conflictId);
      if (active(row.status)) writeExplanation(row, explanation);
    },
    set_explanation_if_current: ([conflictId, expectedRunKey, expectedError, expectedFixer, explanation]) => {
      const row = db.conflict.find((c) => c.id === conflictId);
      if (row && matchesVersion(row, { expectedRunKey, expectedError, expectedFixer })) writeExplanation(row, explanation);
    },
    resolve_conflict: ([conflictId, verifiedFact]) => {
      const row = getConflict(conflictId);
      if (mutableConflict(row) && !sentBack(row) && greenEvidence(row)) finishResolution(row, verifiedFact);
    },
    resolve_conflict_if_current: ([conflictId, expectedRunKey, expectedError, expectedFixer, verifiedRunKey, verifiedFact]) => {
      const row = db.conflict.find((c) => c.id === conflictId);
      if (row && matchesVersion(row, { expectedRunKey, expectedError, expectedFixer }) && !sentBack(row) && greenEvidence(row, verifiedRunKey)) {
        finishResolution(row, verifiedFact);
      }
    },
    flag_needs_human: ([conflictId, reason]) => {
      const row = getConflict(conflictId);
      if (row.status === "resolved" || row.status === "needs_human") return;
      row.status = "needs_human";
      retireWakeups(row.id);
      stopTimer(row.id);
      for (const recipient of [row.agentA, row.agentB].filter(Boolean)) {
        note(recipient, "info", row.id, `[cowork] Conflict #${row.id} needs a person: ${reason}. Do not edit tests to make checks pass.`);
        refresh(recipient);
      }
    },
    review_test_change: ([conflictId, approve, comment]) => {
      const row = getConflict(conflictId);
      if (row.status !== "needs_human") throw new SenderError(`Conflict #${row.id} is not waiting for a person`);
      const trimmed = cut(comment.trim(), 500);
      const said = trimmed ? ` (${trimmed})` : "";
      const other = row.fixer === row.agentA ? row.agentB : row.agentA;
      if (approve) {
        if (!greenEvidence(row)) throw new SenderError("The combined check is still red. Approve the test change once it passes.");
        finishResolution(row, "");
        for (const recipient of [row.agentA, row.agentB].filter(Boolean)) {
          note(recipient, "info", row.id, `[cowork] A person approved the test change for conflict #${row.id}${said}. The conflict is resolved.`);
        }
        return;
      }
      row.status = "open";
      reviews.set(row.id, latestSnapshotId(row.fixer));
      stopTimer(row.id);
      scheduleEscalation(row.id);
      note(row.fixer, "conflict", row.id, `[cowork] A person sent your fix for conflict #${row.id} back${said}. Put back the tests you changed, then fix the code so those tests pass as they are.`);
      if (other) note(other, "info", row.id, `[cowork] Conflict #${row.id}: a person sent ${row.fixer}'s test change back${said}.`);
      refresh(row.agentA);
      if (row.agentB) refresh(row.agentB);
    },
    send_note: ([agent, kind, message]) => {
      oneOf(kind, ["info", "heads_up", "fact"]);
      note(agent, kind, 0, message);
    },
    mark_delivered: ([inboxIds]) => {
      const ids = new Set(inboxIds);
      for (const row of db.inbox) if (ids.has(row.id)) row.delivered = true;
    },
    reset_all: () => {
      for (const id of [...timers.keys()]) stopTimer(id);
      reviews.clear();
      for (const table of Object.keys(db) as TableName[]) db[table].length = 0;
      nextId = 1;
    },
    submit_request: ([agent, body]) => {
      ensureAgent(agent);
      const text = cut(body.trim(), 4 * 1024);
      if (!text) throw new SenderError("Say what you want the orchestrator to do");
      db.request.push({ id: nextId++, agent, body: text, status: "new", summary: "", plan: "", createdAt: now(), updatedAt: now() });
    },
    start_request: ([requestId]) => {
      const row = getRequest(requestId);
      if (row.status !== "new" && row.status !== "planning") throw new SenderError(`Request #${row.id} is already ${row.status}`);
      touch(row, { status: "planning" });
    },
    add_plan_step: ([requestId, kind, detail]) => {
      getRequest(requestId);
      oneOf(kind, ["status", "tool_call", "tool_result", "thought", "final", "error"]);
      db.plan_step.push({ id: nextId++, requestId, kind, detail: cut(detail, 2 * 1024), createdAt: now() });
    },
    publish_plan: ([requestId, summary, planJson]) => {
      const request = getRequest(requestId);
      if (request.status !== "new" && request.status !== "planning") throw new SenderError(`Request #${request.id} is already ${request.status}`);
      const plan = parsePlan(planJson);
      const text = cut(summary.trim(), 4 * 1024);
      const held = plan.reviews.length > 0;
      for (const review of plan.reviews) {
        db.review.push({ id: nextId++, requestId, reviewer: review.reviewer, summary: review.summary, status: "pending", answer: "", createdAt: now(), decidedAt: 0 });
        note(review.reviewer, "info", 0, `[cowork] ${request.agent}'s request #${requestId} affects your feature, so your human reviews it on the dashboard first: ${review.summary}`);
      }
      for (const task of plan.tasks) {
        ensureAgent(task.agent);
        const id = nextId++;
        db.task.push({ id, requestId, ...task, status: held ? "waiting_review" : "assigned", note: "", createdAt: now(), updatedAt: now() });
        if (!held) note(task.agent, "task", id, `[cowork] Task #${id} from the orchestrator: ${task.title}`);
      }
      touch(request, { summary: text, plan: JSON.stringify(plan), status: held ? "waiting_review" : plan.tasks.length ? "assigned" : "done" });
      if (!held) for (const conflict of plan.conflicts) openPotential(requestId, conflict);
      const waiting = held ? ` Waiting for review by ${plan.reviews.map((review) => review.reviewer).join(", ")}.` : "";
      note(request.agent, "info", 0, `[cowork] The orchestrator planned your request #${requestId}: ${cut(text, 1000)}${waiting}`);
    },
    fail_request: ([requestId, reason]) => {
      const row = getRequest(requestId);
      if (row.status !== "new" && row.status !== "planning") return;
      const why = cut(reason.trim() || "No plan came out.", 1024);
      touch(row, { status: "failed", summary: why });
      note(row.agent, "info", 0, `[cowork] The orchestrator couldn't plan your request #${row.id}: ${why}`);
    },
    decide_review: ([reviewId, approve, answer]) => {
      const review = db.review.find((r) => r.id === reviewId);
      if (!review) throw new SenderError(`Unknown review #${reviewId}`);
      if (review.status !== "pending") throw new SenderError(`Review #${review.id} is already ${review.status}`);
      const request = getRequest(review.requestId);
      const text = cut(answer.trim(), 500);
      const said = text ? ` (${text})` : "";
      Object.assign(review, { status: approve ? "approved" : "rejected", answer: text, decidedAt: now() });
      if (approve) {
        note(request.agent, "info", 0, `[cowork] ${review.reviewer}'s human approved your request #${request.id}${said}.`);
        const pending = db.review.some((r) => r.requestId === request.id && r.status === "pending");
        if (!pending && request.status === "waiting_review") releasePlan(request);
        return;
      }
      for (const row of db.review) if (row.requestId === request.id && row.status === "pending") Object.assign(row, { status: "cancelled", decidedAt: now() });
      for (const row of db.task) {
        if (row.requestId === request.id && row.status === "waiting_review") {
          Object.assign(row, { status: "cancelled", note: `Sent back by ${review.reviewer}'s human${said}`, updatedAt: now() });
        }
      }
      touch(request, { status: "rejected" });
      note(request.agent, "info", 0, `[cowork] ${review.reviewer}'s human sent your request #${request.id} back${said}. Nothing was assigned. Tell your human; they can ask again with a changed request.`);
    },
    complete_task: ([taskId, agent, summary]) => {
      name(agent);
      const row = db.task.find((t) => t.id === taskId);
      if (!row) throw new SenderError(`Unknown task #${taskId}`);
      if (row.agent !== agent) throw new SenderError(`Task #${row.id} belongs to ${row.agent}`);
      if (row.status !== "assigned") throw new SenderError(`Task #${row.id} is ${row.status}, not assigned`);
      if (latestSnapshotId(agent) > 0 && !db.check_run.some((run) => run.result === "green" && run.agents.includes(agent) && currentRun(run))) {
        throw new SenderError("No current green check includes your latest snapshot. Run check_with_team, then try again.");
      }
      const text = cut(summary.trim(), 2 * 1024);
      Object.assign(row, { status: "done", note: text, updatedAt: now() });
      const request = db.request.find((r) => r.id === row.requestId);
      if (!request) return;
      if (request.agent !== agent) note(request.agent, "info", 0, `[cowork] ${agent} finished task #${row.id} of your request #${request.id}: ${cut(text, 300)}`);
      const left = db.task.some((t) => t.requestId === request.id && (t.status === "assigned" || t.status === "waiting_review"));
      if (!left && request.status === "assigned") {
        touch(request, { status: "done" });
        note(request.agent, "info", 0, `[cowork] Every task of your request #${request.id} is done.`);
      }
    },
    post_message: ([conflictId, agent, kind, body]) => {
      name(agent);
      oneOf(kind, ["message", "agree", "escalate"]);
      const row = getConflict(conflictId);
      if (row.agentA !== agent && row.agentB !== agent) throw new SenderError(`${agent} isn't part of conflict #${row.id}`);
      if (!row.agentB) throw new SenderError(`Conflict #${row.id} involves only you; fix it and run check_with_team`);
      if (row.status !== "open") {
        throw new SenderError(row.status === "escalated" ? `Conflict #${row.id} is with both humans now; wait for their decision`
          : `Conflict #${row.id} is ${row.status === "needs_human" ? "waiting for a person (a fix changed tests)" : "already resolved"}`);
      }
      const text = body.trim();
      if (!text) throw new SenderError("The message is empty");
      post(row.id, agent, kind, text);
      if (kind === "escalate") {
        escalateToHumans(row, agent, `${agent} asked for a decision: ${cut(text, 300)}`);
        return;
      }
      const agreed = kind === "agree" && bothAgreed(row);
      if (agreed && pairGreen(row)) {
        finishResolution(row, text);
        return;
      }
      const other = row.agentA === agent ? row.agentB : row.agentA;
      note(other, "message", row.id, `[cowork] ${agent} ${kind === "agree" ? "agrees" : "says"} in conflict #${row.id}: ${cut(text, 1000)}`);
      if (agreed) {
        for (const recipient of participants(row)) {
          note(recipient, "info", row.id, `[cowork] You both agree on conflict #${row.id}, but no current green check covers both of you. Run check_with_team after your last edit, then agree again.`);
        }
      }
      const spoken = sinceDecision(row.id).filter((m) => participants(row).includes(m.author) && (m.kind === "message" || m.kind === "agree"));
      if (spoken.length >= MAX_MESSAGES) escalateToHumans(row, ORCHESTRATOR_NAME, `${MAX_MESSAGES} messages without agreement.`);
    },
    decide_conflict: ([conflictId, decision]) => {
      const row = getConflict(conflictId);
      if (row.status !== "escalated" && row.status !== "open") throw new SenderError(`Conflict #${row.id} is ${row.status}; only an open or escalated conflict takes a decision`);
      const text = decision.trim();
      if (!text) throw new SenderError("Write the decision first");
      row.status = "open";
      stopTimer(row.id);
      retireThreadWakeups(row.id);
      post(row.id, HUMAN_AUTHOR, "decision", text);
      for (const agent of participants(row)) note(agent, "message", row.id, `[cowork] Your humans decided conflict #${row.id}: ${cut(text, 1000)}`);
    },
  };

  function runSql(sql: string) {
    return sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => {
        const match = /^SELECT\s+\*\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+))?$/i.exec(statement);
        if (!match) throw new HttpError(400, `mock-stdb only understands SELECT * FROM <table> [WHERE col = value AND ...]: ${statement}`);
        const table = match[1] as TableName;
        if (!(table in Columns)) throw new HttpError(400, `no such table: ${table}`);
        const columns: readonly string[] = Columns[table];
        const conditions = parseWhere(match[2] ?? "", columns);
        const rows = (db[table] as unknown as Array<Record<string, unknown>>).filter((row) =>
          conditions.every(([column, value]) => row[column] === value),
        );
        return {
          schema: { elements: columns.map((column) => ({ name: { some: column } })) },
          rows: rows.map((row) => columns.map((column) => row[column])),
        };
      });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : error instanceof SenderError ? 400 : 500;
      send(res, status, error instanceof Error ? error.message : String(error));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/v1\/database\/([^/]+)\/(?:call\/([^/]+)|(sql)|(dump))$/.exec(url.pathname);
    if (!match) return send(res, 404, "not found");
    if (decodeURIComponent(match[1] ?? "") !== MOCK_DB_NAME) return send(res, 404, `no database named ${match[1]} (the mock is "${MOCK_DB_NAME}")`);
    if (match[4]) return send(res, 200, JSON.stringify(db, null, 2), "application/json");
    if (req.method !== "POST") return send(res, 405, "use POST");
    if (!req.headers.authorization?.startsWith("Bearer ")) return send(res, 401, "missing Authorization: Bearer <token>");
    const body = await readBody(req);
    if (match[3]) return send(res, 200, JSON.stringify(runSql(body)), "application/json");

    const reducer = decodeURIComponent(match[2] ?? "") as ReducerName;
    if (!(reducer in ARITY)) return send(res, 404, `no such reducer: ${reducer}`);
    const args: unknown = JSON.parse(body || "[]");
    if (!Array.isArray(args) || args.length !== ARITY[reducer]) return send(res, 400, `${reducer} takes ${ARITY[reducer]} arguments`);
    (reducers[reducer] as (args: unknown[]) => void)(args);
    calls.push({ reducer, args });
    send(res, 200, "");
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? DEFAULT_PORT, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    db,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        for (const id of [...timers.keys()]) stopTimer(id);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Parses `col = value AND col = value`. Values: 'quoted strings', numbers, true or false. */
function parseWhere(where: string, columns: readonly string[]): Array<[string, unknown]> {
  const conditions: Array<[string, unknown]> = [];
  const condition = /\s*(\w+)\s*=\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?|true|false)\s*(?:AND\b|$)/giy;
  let consumed = 0;
  for (let match = condition.exec(where); match; match = condition.exec(where)) {
    const column = match[1] ?? "";
    const raw = match[2] ?? "";
    if (!columns.includes(column)) throw new HttpError(400, `no such column: ${column}`);
    const value =
      raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw.toLowerCase() === "true" ? true : raw.toLowerCase() === "false" ? false : Number(raw);
    conditions.push([column, value]);
    consumed = condition.lastIndex;
    if (consumed >= where.length) break;
  }
  if (where.trim() && where.slice(consumed).trim()) throw new HttpError(400, `mock-stdb can't parse this WHERE clause: ${where}`);
  return conditions;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

const runDirectly = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (runDirectly) {
  const mock = await startMockStdb({ port: Number(process.env.MOCK_STDB_PORT ?? DEFAULT_PORT) });
  console.log(`Mock SpacetimeDB on ${mock.url}, database "${MOCK_DB_NAME}". Tables live in memory; Ctrl+C stops it.`);
  console.log(`Run hooks/scripts with:  STDB_HOST=${mock.url}  STDB_DB=${MOCK_DB_NAME}  STDB_TOKEN=anything  (process environment, not .env)`);
  console.log(`See every table:   ${mock.url}/v1/database/${MOCK_DB_NAME}/dump`);
}
