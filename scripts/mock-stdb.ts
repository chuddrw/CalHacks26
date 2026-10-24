/**
 * scripts/mock-stdb.ts
 *
 * WHAT IT'S FOR
 *   A stand-in for our SpacetimeDB database for work without a server: the same two HTTP endpoints
 *   the hooks and scripts use, every table from shared/src/schema.ts in memory, and every reducer
 *   behaving the way Part C's module (module/src/index.ts) does: the same validation, the same
 *   "current, covering check" rules, the same inbox wording. A's end-to-end test runs against it,
 *   and B and D can point at it too (npm run seed works).
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
  WATCHER_NAME,
  type ConflictRow,
  type ReducerArgs,
  type ReducerName,
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
  send_note: 3,
  mark_delivered: 1,
  reset_all: 0,
};

function emptyTables(): Tables {
  return { agent: [], snapshot: [], intent: [], check_run: [], conflict: [], inbox: [], diagnosis_step: [] };
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
    const blocked = db.conflict.some((c) => active(c.status) && (c.agentA === value || c.agentB === value));
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
    refresh(row.agentA);
    if (row.agentB) refresh(row.agentB);
    if (verifiedFact.trim()) {
      const files = [...new Set([
        ...(db.agent.find((a) => a.name === row.agentA)?.files ?? []),
        ...(db.agent.find((a) => a.name === row.agentB)?.files ?? []),
      ])];
      db.intent.push({ id: nextId++, agent: WATCHER_NAME, summary: verifiedFact, files, symbols: [], verified: true, createdAt: now() });
      for (const recipient of [...db.agent]) note(recipient.name, "fact", row.id, `[cowork] Verified fact: ${verifiedFact}`);
    }
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
          note(fixer, "conflict", existing.id, `[cowork] Still red after your last change. Conflict #${existing.id}: you are the fixer`);
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
        const timer = setTimeout(() => {
          const row = db.conflict.find((c) => c.id === id);
          if (row?.status === "open") row.status = "escalated";
        }, escalateMs);
        timer.unref();
        timers.set(id, timer);
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
      if (mutableConflict(row) && greenEvidence(row)) finishResolution(row, verifiedFact);
    },
    resolve_conflict_if_current: ([conflictId, expectedRunKey, expectedError, expectedFixer, verifiedRunKey, verifiedFact]) => {
      const row = db.conflict.find((c) => c.id === conflictId);
      if (row && matchesVersion(row, { expectedRunKey, expectedError, expectedFixer }) && greenEvidence(row, verifiedRunKey)) {
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
      for (const table of Object.keys(db) as TableName[]) db[table].length = 0;
      nextId = 1;
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
