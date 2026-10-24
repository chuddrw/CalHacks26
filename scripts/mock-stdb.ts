/**
 * scripts/mock-stdb.ts
 *
 * WHAT IT'S FOR
 *   A stand-in for our SpacetimeDB database until C publishes the real module. It serves the same
 *   two HTTP endpoints the hooks and scripts use, keeps every table from shared/src/schema.ts in
 *   memory, and runs each reducer the way module/src/index.ts describes it. A tests the hooks and
 *   the MCP server against it; B and D can point at it too (npm run seed works); and C can read it
 *   as a runnable version of the module spec.
 *
 * OWNER: A wrote it. Whoever changes a reducer in module/src/index.ts changes it here too, until we
 *        switch to the real database.
 * USAGE: npm run mock-db        (listens on http://127.0.0.1:3077; set MOCK_STDB_PORT to change it)
 *   then in repo 1's .env:  STDB_HOST=http://127.0.0.1:3077  STDB_DB=mock  STDB_TOKEN=anything
 *   hooks/test/e2e.ts starts its own copy on a random port with startMockStdb().
 *
 * ENDPOINTS
 *   POST /v1/database/mock/call/<reducer>   JSON array of arguments, same order as ReducerArgs
 *   POST /v1/database/mock/sql              only `SELECT * FROM <table> [WHERE col = value AND ...]`
 *   GET  /v1/database/mock/dump             mock only: every table as JSON, for debugging
 *   Calls without "Authorization: Bearer <anything>" get 401, like the real database.
 *
 * WHAT IT DOESN'T DO
 *   - No WebSocket subscriptions, so the UI and the watcher's live updates need the real database
 *     (or polling against this one).
 *   - No persistence: restarting it empties every table.
 *   - No identities: register_agent marks the agent online, but nothing ever marks it offline.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Columns,
  WATCHER_NAME,
  pairKey,
  type AgentName,
  type AgentRow,
  type ConflictRow,
  type InboxKind,
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
  /** Every reducer call, in order. */
  calls: Array<{ reducer: string; args: unknown[] }>;
  close(): Promise<void>;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ARITY: Record<ReducerName, number> = {
  register_agent: 1,
  post_snapshot: 5,
  post_intent: 4,
  report_check: 4,
  report_conflict: 8,
  add_diagnosis_step: 4,
  set_explanation: 2,
  resolve_conflict: 2,
  flag_needs_human: 2,
  send_note: 3,
  mark_delivered: 1,
  reset_all: 0,
};

function emptyTables(): Tables {
  return { agent: [], snapshot: [], intent: [], check_run: [], conflict: [], inbox: [], diagnosis_step: [] };
}

export async function startMockStdb(options: { port?: number; escalateMs?: number } = {}): Promise<MockStdb> {
  const db = emptyTables();
  const calls: MockStdb["calls"] = [];
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const escalateMs = options.escalateMs ?? ESCALATE_MS;
  let nextId = 1;
  const now = () => Date.now();

  const agentRow = (name: AgentName): AgentRow => {
    let row = db.agent.find((a) => a.name === name);
    if (!row) {
      row = { name, online: false, status: "green", intent: "", files: [], lastSnapshotAt: 0 };
      db.agent.push(row);
    }
    return row;
  };
  const note = (agent: AgentName, kind: InboxKind, conflictId: number, message: string) => {
    db.inbox.push({ id: nextId++, agent, kind, conflictId, message, delivered: false, createdAt: now() });
  };
  const isActive = (c: ConflictRow) => c.status === "open" || c.status === "escalated";
  const hasActiveConflict = (agent: AgentName) => db.conflict.some((c) => isActive(c) && (c.agentA === agent || c.agentB === agent));
  const conflictById = (id: number): ConflictRow => {
    const conflict = db.conflict.find((c) => c.id === id);
    if (!conflict) throw new HttpError(400, `no conflict with id ${id}`);
    return conflict;
  };
  const stopTimer = (id: number) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
  };

  const reducers: { [R in ReducerName]: (args: ReducerArgs[R]) => void } = {
    register_agent: ([agent]) => {
      agentRow(agent).online = true;
    },
    post_snapshot: ([agent, sha, baseSha, files, diff]) => {
      db.snapshot.push({ id: nextId++, agent, sha, baseSha, files, diff, createdAt: now() });
      Object.assign(agentRow(agent), { status: "working", files, lastSnapshotAt: now() });
    },
    post_intent: ([agent, summary, files, symbols]) => {
      db.intent.push({ id: nextId++, agent, summary, files, symbols, verified: false, createdAt: now() });
      agentRow(agent).intent = summary;
      const where = files.length ? ` (files: ${files.join(", ")})` : "";
      for (const other of db.agent) if (other.name !== agent) note(other.name, "heads_up", 0, `${agent} plans: ${summary}${where}`);
    },
    report_check: ([runKey, agents, result, log]) => {
      const row = { runKey, agents, result, log, createdAt: now() };
      const index = db.check_run.findIndex((r) => r.runKey === runKey);
      if (index >= 0) db.check_run[index] = row;
      else db.check_run.push(row);
      if (result === "green") for (const agent of agents) if (!hasActiveConflict(agent)) agentRow(agent).status = "green";
    },
    report_conflict: ([kind, agentA, agentB, locA, locB, error, fixer, runKey]) => {
      const pair = pairKey(agentA, agentB);
      const existing = db.conflict.find((c) => c.pair === pair && isActive(c));
      if (existing) {
        const errorChanged = existing.error !== error;
        Object.assign(existing, { kind, agentA, agentB, locA, locB, error, fixer, runKey });
        if (errorChanged) note(fixer, "conflict", existing.id, `Still red after your last change. Conflict #${existing.id}: you are the fixer.`);
      } else {
        const id = nextId++;
        db.conflict.push({
          id, pair, kind, agentA, agentB, locA, locB, error, explanation: "", fixer,
          status: "open", runKey, createdAt: now(), resolvedAt: 0,
        });
        note(fixer, "conflict", id, `Conflict #${id}: you are the fixer.`);
        const other = fixer === agentA ? agentB : agentA;
        if (other) note(other, "info", id, `Conflict #${id} between ${agentA} and ${agentB}: ${fixer} is fixing it.`);
        const timer = setTimeout(() => {
          const conflict = db.conflict.find((c) => c.id === id);
          if (conflict?.status === "open") conflict.status = "escalated";
        }, escalateMs);
        timer.unref();
        timers.set(id, timer);
      }
      agentRow(agentA).status = "red";
      if (agentB) agentRow(agentB).status = "red";
    },
    add_diagnosis_step: ([conflictId, source, kind, detail]) => {
      db.diagnosis_step.push({ id: nextId++, conflictId, source, kind, detail, createdAt: now() });
    },
    set_explanation: ([conflictId, explanation]) => {
      const conflict = conflictById(conflictId);
      conflict.explanation = explanation;
      const alreadyTold = db.inbox.some((r) => r.conflictId === conflictId && r.kind === "conflict" && r.agent === conflict.fixer && r.delivered);
      if (alreadyTold) note(conflict.fixer, "info", conflictId, `Diagnosis for conflict #${conflictId}: ${explanation}`);
    },
    resolve_conflict: ([conflictId, verifiedFact]) => {
      const conflict = conflictById(conflictId);
      conflict.status = "resolved";
      conflict.resolvedAt = now();
      stopTimer(conflictId);
      for (const agent of [conflict.agentA, conflict.agentB]) if (agent && !hasActiveConflict(agent)) agentRow(agent).status = "green";
      if (verifiedFact) {
        db.intent.push({ id: nextId++, agent: WATCHER_NAME, summary: verifiedFact, files: [], symbols: [], verified: true, createdAt: now() });
        for (const agent of db.agent) note(agent.name, "fact", conflictId, verifiedFact);
      }
    },
    flag_needs_human: ([conflictId, reason]) => {
      const conflict = conflictById(conflictId);
      conflict.status = "needs_human";
      stopTimer(conflictId);
      for (const agent of [conflict.agentA, conflict.agentB]) {
        if (agent) note(agent, "info", conflictId, `Conflict #${conflictId} needs a person: ${reason} Keep every existing test as it is.`);
      }
    },
    send_note: ([agent, kind, message]) => {
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
          schema: { elements: columns.map((name) => ({ name: { some: name } })) },
          rows: rows.map((row) => columns.map((column) => row[column])),
        };
      });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
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
    calls.push({ reducer, args });
    (reducers[reducer] as (args: unknown[]) => void)(args);
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
  console.log(`In repo 1's .env:  STDB_HOST=${mock.url}  STDB_DB=${MOCK_DB_NAME}  STDB_TOKEN=anything`);
  console.log(`See every table:   ${mock.url}/v1/database/${MOCK_DB_NAME}/dump`);
}
