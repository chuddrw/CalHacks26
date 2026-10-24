/**
 * module/src/index.ts
 *
 * WHAT IT'S FOR
 *   The SpacetimeDB module: the code that runs inside our hosted database. It defines every
 *   table and reducer in shared/src/schema.ts, and it is the only place team state changes.
 *   Hooks, the watcher, the MCP server and the UI are all clients of this module. There is no
 *   other backend server.
 *
 * OWNER: C.
 * DONE WHEN: `npm run module:generate` produces bindings that match shared/src/schema.ts, and
 *            scripts/seed-fake.ts can fill every table.
 *
 * VERSION
 *   SpacetimeDB 2.x (CLI and npm package 2.13). Reducer names are the export names: 2.x converts
 *   them to snake_case for the database (registerAgent -> register_agent, which is what the HTTP
 *   calls in shared/src/stdb-http.ts use), and generated clients call them in camelCase with one
 *   object argument (conn.reducers.registerAgent({ agent })). Columns get the same treatment: SQL
 *   sees base_sha and created_at, clients see baseSha and createdAt.
 *
 * TYPES
 *   Ids are u32 and times are f64 milliseconds since the epoch, because the TypeScript SDK maps
 *   u64 to bigint and shared/src/schema.ts promises plain numbers to every client. f64 holds
 *   every millisecond timestamp exactly.
 *
 * TABLES (public unless marked private; column order MUST match Columns in shared/src/schema.ts)
 *   agent            pk name
 *   snapshot         pk id (auto-increment)
 *   intent           pk id (auto-increment)
 *   check_run        pk runKey
 *   conflict         pk id (auto-increment). Index on pair, for the "unresolved conflict for this pair" lookup.
 *   inbox            pk id (auto-increment). Index on agent.
 *   diagnosis_step   pk id (auto-increment). Index on conflictId.
 *   agent_connection PRIVATE. pk connectionId, plus the agent name. Keyed by connection, not
 *                    identity, because every laptop may use the same STDB_TOKEN.
 *                    Written by register_agent, read by the client_disconnected lifecycle reducer.
 *   escalation_timer PRIVATE schedule table: scheduledId, scheduledAt, conflictId. Calls
 *                    `escalate` at its scheduled time.
 *
 * UNRESOLVED
 *   A conflict is unresolved while its status is open, escalated or needs_human. needs_human
 *   counts because a person still has to act, so both agents stay red until then.
 *
 * REDUCERS (arguments in the order of ReducerArgs in shared/src/schema.ts)
 *   register_agent(agent)
 *     Upsert the agent row with online = true (status "green" if new). Insert agent_connection
 *     for this connection.
 *   post_snapshot(agent, sha, baseSha, files, diff)
 *     Insert a snapshot row. Upsert the agent: status "working", files, lastSnapshotAt = now.
 *   post_intent(agent, summary, files, symbols)
 *     Insert an intent with verified = false. Set agent.intent = summary. For every OTHER agent,
 *     insert an inbox row: kind "heads_up", message "<agent> plans: <summary> (files: ...)".
 *   report_check(runKey, agents, result, log)
 *     Upsert the check_run row. If green: set each listed agent to "green", unless it still has
 *     an unresolved conflict.
 *   report_conflict(kind, agentA, agentB, locA, locB, error, fixer, runKey)
 *     ONE TRANSACTION, the reason SpacetimeDB is the right place for this:
 *       - find the unresolved conflict with this pair (pairKey)
 *       - none: insert it (status "open", explanation "", resolvedAt 0), insert a "conflict" inbox
 *         row for the fixer and an "info" row for the other agent (none for kind "self"), and
 *         insert an escalation_timer row for now + ESCALATE_MINUTES
 *       - exists: update kind, locA, locB, error, fixer, runKey. A new fixer gets a "conflict" row;
 *         the same fixer gets one starting "Still red after your last change." if the error changed.
 *       - set agentA and agentB to status "red"
 *   add_diagnosis_step(conflictId, source, kind, detail)
 *     Insert a diagnosis_step row.
 *   set_explanation(conflictId, explanation)
 *     Set conflict.explanation. The hooks build the fixer's message from the conflict row when
 *     they deliver it, so nothing else is needed while that "conflict" inbox row is undelivered.
 *     If it was already delivered, insert an "info" row for the fixer:
 *     "Diagnosis for conflict #<id>: <explanation>".
 *   resolve_conflict(conflictId, verifiedFact)
 *     Status "resolved", resolvedAt = now. Set both agents "green" unless they have another
 *     unresolved conflict. If verifiedFact isn't empty: insert an intent (agent WATCHER_NAME,
 *     verified = true) and a "fact" inbox row for every agent.
 *   flag_needs_human(conflictId, reason)
 *     Status "needs_human". "info" inbox row to both agents: a person will look at it, and the
 *     tests stay as they are until then.
 *   send_note(agent, kind, message)
 *     Insert one inbox row for that agent. Used by the watcher's dependency heads-up.
 *   mark_delivered(inboxIds)
 *     Set delivered = true on each row.
 *   reset_all()
 *     Demo only (scripts/demo-reset.ts). Deletes every row in every table except agent and
 *     agent_connection. Agent rows go back to green with no intent and no files, and keep their
 *     online flag, so the dashboard still shows every card.
 *   escalate(timer row)            scheduled; rejects calls that don't come from the scheduler
 *     If the conflict is still "open", set it to "escalated". The UI shows it to the humans.
 *
 *   Inbox message text stays short ("Conflict #12: you are the fixer", "<agent> plans: ...").
 *   hooks/src/lib/format.ts turns rows into the full wording agents see.
 *
 * LIFECYCLE
 *   client_disconnected: look up agent_connection by ctx.connectionId. If found, delete it, and set
 *   that agent's online = false unless it has another live connection.
 *
 * SECURITY (say this in Q&A)
 *   Any client that knows the database name can call these reducers. That's fine for a
 *   hackathon demo. A real version would check ctx.sender against registered identities.
 */
import { ScheduleAt } from 'spacetimedb';
import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

const ESCALATE_MINUTES = 5;
// Same value and format as shared/src/schema.ts; the module can't import that file.
const WATCHER_NAME = 'watcher';
const MAX_ERROR = 4 * 1024;
const MAX_DETAIL = 2 * 1024;
const MAX_LOG = 20 * 1024;
const MAX_DIFF = 50 * 1024;

const agent = table(
  { name: 'agent', public: true },
  {
    name: t.string().primaryKey(),
    online: t.bool(),
    status: t.string(),
    intent: t.string(),
    files: t.array(t.string()),
    lastSnapshotAt: t.f64(),
  }
);

const snapshot = table(
  { name: 'snapshot', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    agent: t.string(),
    sha: t.string(),
    baseSha: t.string(),
    files: t.array(t.string()),
    diff: t.string(),
    createdAt: t.f64(),
  }
);

const intent = table(
  { name: 'intent', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    agent: t.string(),
    summary: t.string(),
    files: t.array(t.string()),
    symbols: t.array(t.string()),
    verified: t.bool(),
    createdAt: t.f64(),
  }
);

const checkRun = table(
  { name: 'check_run', public: true },
  {
    runKey: t.string().primaryKey(),
    agents: t.array(t.string()),
    result: t.string(),
    log: t.string(),
    createdAt: t.f64(),
  }
);

const conflict = table(
  { name: 'conflict', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    pair: t.string().index('btree'),
    kind: t.string(),
    agentA: t.string(),
    agentB: t.string(),
    locA: t.string(),
    locB: t.string(),
    error: t.string(),
    explanation: t.string(),
    fixer: t.string(),
    status: t.string(),
    runKey: t.string(),
    createdAt: t.f64(),
    resolvedAt: t.f64(),
  }
);

const inbox = table(
  { name: 'inbox', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    agent: t.string().index('btree'),
    kind: t.string(),
    conflictId: t.u32(),
    message: t.string(),
    delivered: t.bool(),
    createdAt: t.f64(),
  }
);

const diagnosisStep = table(
  { name: 'diagnosis_step', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    conflictId: t.u32().index('btree'),
    source: t.string(),
    kind: t.string(),
    detail: t.string(),
    createdAt: t.f64(),
  }
);

const agentConnection = table(
  { name: 'agent_connection' },
  {
    connectionId: t.connectionId().primaryKey(),
    agent: t.string(),
  }
);

const escalationTimer = table(
  { name: 'escalation_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    conflictId: t.u32(),
  }
);

const spacetimedb = schema({
  agent,
  snapshot,
  intent,
  checkRun,
  conflict,
  inbox,
  diagnosisStep,
  agentConnection,
  escalationTimer,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type ConflictRow = NonNullable<ReturnType<Ctx['db']['conflict']['id']['find']>>;
type AgentRow = NonNullable<ReturnType<Ctx['db']['agent']['name']['find']>>;

const UNRESOLVED = ['open', 'escalated', 'needs_human'];

function nowMs(ctx: Ctx): number {
  return Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Same rule as pairKey() in shared/src/schema.ts. */
function pairKey(a: string, b: string): string {
  return b === '' ? a : [a, b].sort().join('+');
}

function getOrCreateAgent(ctx: Ctx, name: string): AgentRow {
  const existing = ctx.db.agent.name.find(name);
  if (existing) return existing;
  return ctx.db.agent.insert({ name, online: false, status: 'green', intent: '', files: [], lastSnapshotAt: 0 });
}

function setAgentStatus(ctx: Ctx, name: string, status: string): void {
  if (name === '') return;
  const row = getOrCreateAgent(ctx, name);
  if (row.status !== status) ctx.db.agent.name.update({ ...row, status });
}

function hasUnresolvedConflict(ctx: Ctx, name: string, exceptId = -1): boolean {
  for (const c of ctx.db.conflict.iter()) {
    if (c.id !== exceptId && UNRESOLVED.includes(c.status) && (c.agentA === name || c.agentB === name)) return true;
  }
  return false;
}

function unresolvedConflictForPair(ctx: Ctx, pair: string): ConflictRow | undefined {
  return [...ctx.db.conflict.pair.filter(pair)].find((c) => UNRESOLVED.includes(c.status));
}

function addInbox(ctx: Ctx, to: string, kind: string, conflictId: number, message: string): void {
  if (to === '') return;
  ctx.db.inbox.insert({ id: 0, agent: to, kind, conflictId, message, delivered: false, createdAt: nowMs(ctx) });
}

function findConflict(ctx: Ctx, conflictId: number): ConflictRow {
  const row = ctx.db.conflict.id.find(conflictId);
  if (!row) throw new SenderError(`no conflict #${conflictId}`);
  return row;
}

export const registerAgent = spacetimedb.reducer({ agent: t.string() }, (ctx, { agent: name }) => {
  const row = getOrCreateAgent(ctx, name);
  if (!row.online) ctx.db.agent.name.update({ ...row, online: true });
  if (ctx.connectionId) {
    const existing = ctx.db.agentConnection.connectionId.find(ctx.connectionId);
    if (existing) ctx.db.agentConnection.connectionId.update({ ...existing, agent: name });
    else ctx.db.agentConnection.insert({ connectionId: ctx.connectionId, agent: name });
  }
});

export const postSnapshot = spacetimedb.reducer(
  { agent: t.string(), sha: t.string(), baseSha: t.string(), files: t.array(t.string()), diff: t.string() },
  (ctx, { agent: name, sha, baseSha, files, diff }) => {
    const now = nowMs(ctx);
    ctx.db.snapshot.insert({ id: 0, agent: name, sha, baseSha, files, diff: clip(diff, MAX_DIFF), createdAt: now });
    const row = getOrCreateAgent(ctx, name);
    ctx.db.agent.name.update({ ...row, status: 'working', files, lastSnapshotAt: now });
  }
);

export const postIntent = spacetimedb.reducer(
  { agent: t.string(), summary: t.string(), files: t.array(t.string()), symbols: t.array(t.string()) },
  (ctx, { agent: name, summary, files, symbols }) => {
    ctx.db.intent.insert({ id: 0, agent: name, summary, files, symbols, verified: false, createdAt: nowMs(ctx) });
    const row = getOrCreateAgent(ctx, name);
    ctx.db.agent.name.update({ ...row, intent: summary });
    const message = `${name} plans: ${summary}${files.length ? ` (files: ${files.join(', ')})` : ''}`;
    for (const other of ctx.db.agent.iter()) {
      if (other.name !== name) addInbox(ctx, other.name, 'heads_up', 0, message);
    }
  }
);

export const reportCheck = spacetimedb.reducer(
  { runKey: t.string(), agents: t.array(t.string()), result: t.string(), log: t.string() },
  (ctx, { runKey, agents, result, log }) => {
    const row = { runKey, agents, result, log: clip(log, MAX_LOG), createdAt: nowMs(ctx) };
    if (ctx.db.checkRun.runKey.find(runKey)) ctx.db.checkRun.runKey.update(row);
    else ctx.db.checkRun.insert(row);
    if (result !== 'green') return;
    for (const name of agents) {
      if (!hasUnresolvedConflict(ctx, name)) setAgentStatus(ctx, name, 'green');
    }
  }
);

export const reportConflict = spacetimedb.reducer(
  {
    kind: t.string(),
    agentA: t.string(),
    agentB: t.string(),
    locA: t.string(),
    locB: t.string(),
    error: t.string(),
    fixer: t.string(),
    runKey: t.string(),
  },
  (ctx, { kind, agentA, agentB, locA, locB, error, fixer, runKey }) => {
    const pair = pairKey(agentA, agentB);
    const clipped = clip(error, MAX_ERROR);
    const existing = unresolvedConflictForPair(ctx, pair);

    if (!existing) {
      const now = nowMs(ctx);
      const created = ctx.db.conflict.insert({
        id: 0,
        pair,
        kind,
        agentA,
        agentB,
        locA,
        locB,
        error: clipped,
        explanation: '',
        fixer,
        status: 'open',
        runKey,
        createdAt: now,
        resolvedAt: 0,
      });
      addInbox(ctx, fixer, 'conflict', created.id, `Conflict #${created.id}: you are the fixer`);
      const other = fixer === agentA ? agentB : agentA;
      if (kind !== 'self') {
        addInbox(ctx, other, 'info', created.id, `Conflict #${created.id} (${pair}): ${fixer} is fixing it. Keep your change as it is.`);
      }
      const due = ctx.timestamp.microsSinceUnixEpoch + BigInt(ESCALATE_MINUTES) * 60_000_000n;
      ctx.db.escalationTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(due), conflictId: created.id });
    } else {
      ctx.db.conflict.id.update({ ...existing, kind, agentA, agentB, locA, locB, error: clipped, fixer, runKey });
      if (fixer !== existing.fixer) {
        addInbox(ctx, fixer, 'conflict', existing.id, `Conflict #${existing.id}: you are now the fixer`);
        addInbox(ctx, existing.fixer, 'info', existing.id, `Conflict #${existing.id}: ${fixer} is fixing it now.`);
      } else if (clipped !== existing.error) {
        addInbox(ctx, fixer, 'conflict', existing.id, `Still red after your last change. Conflict #${existing.id}: you are the fixer`);
      }
    }

    setAgentStatus(ctx, agentA, 'red');
    setAgentStatus(ctx, agentB, 'red');
  }
);

export const addDiagnosisStep = spacetimedb.reducer(
  { conflictId: t.u32(), source: t.string(), kind: t.string(), detail: t.string() },
  (ctx, { conflictId, source, kind, detail }) => {
    ctx.db.diagnosisStep.insert({ id: 0, conflictId, source, kind, detail: clip(detail, MAX_DETAIL), createdAt: nowMs(ctx) });
  }
);

export const setExplanation = spacetimedb.reducer(
  { conflictId: t.u32(), explanation: t.string() },
  (ctx, { conflictId, explanation }) => {
    const row = findConflict(ctx, conflictId);
    ctx.db.conflict.id.update({ ...row, explanation });
    const fixerRows = [...ctx.db.inbox.agent.filter(row.fixer)].filter(
      (m) => m.kind === 'conflict' && m.conflictId === conflictId
    );
    if (fixerRows.length > 0 && fixerRows.every((m) => m.delivered)) {
      addInbox(ctx, row.fixer, 'info', conflictId, `Diagnosis for conflict #${conflictId}: ${explanation}`);
    }
  }
);

export const resolveConflict = spacetimedb.reducer(
  { conflictId: t.u32(), verifiedFact: t.string() },
  (ctx, { conflictId, verifiedFact }) => {
    const row = findConflict(ctx, conflictId);
    if (row.status === 'resolved') return;
    ctx.db.conflict.id.update({ ...row, status: 'resolved', resolvedAt: nowMs(ctx) });
    for (const timer of [...ctx.db.escalationTimer.iter()]) {
      if (timer.conflictId === conflictId) ctx.db.escalationTimer.scheduledId.delete(timer.scheduledId);
    }
    for (const name of [row.agentA, row.agentB]) {
      if (name !== '' && !hasUnresolvedConflict(ctx, name, conflictId)) setAgentStatus(ctx, name, 'green');
    }
    const fact = verifiedFact.trim();
    if (fact === '') return;
    ctx.db.intent.insert({
      id: 0,
      agent: WATCHER_NAME,
      summary: fact,
      files: [],
      symbols: [],
      verified: true,
      createdAt: nowMs(ctx),
    });
    for (const member of ctx.db.agent.iter()) addInbox(ctx, member.name, 'fact', conflictId, fact);
  }
);

export const flagNeedsHuman = spacetimedb.reducer(
  { conflictId: t.u32(), reason: t.string() },
  (ctx, { conflictId, reason }) => {
    const row = findConflict(ctx, conflictId);
    ctx.db.conflict.id.update({ ...row, status: 'needs_human' });
    const message = `Conflict #${conflictId} is waiting for a person: ${reason} Keep every existing test as it is until they decide.`;
    addInbox(ctx, row.agentA, 'info', conflictId, message);
    if (row.agentB !== row.agentA) addInbox(ctx, row.agentB, 'info', conflictId, message);
  }
);

export const sendNote = spacetimedb.reducer(
  { agent: t.string(), kind: t.string(), message: t.string() },
  (ctx, { agent: name, kind, message }) => {
    addInbox(ctx, name, kind, 0, message);
  }
);

export const markDelivered = spacetimedb.reducer({ inboxIds: t.array(t.u32()) }, (ctx, { inboxIds }) => {
  for (const id of inboxIds) {
    const row = ctx.db.inbox.id.find(id);
    if (row && !row.delivered) ctx.db.inbox.id.update({ ...row, delivered: true });
  }
});

export const resetAll = spacetimedb.reducer((ctx) => {
  for (const row of [...ctx.db.snapshot.iter()]) ctx.db.snapshot.id.delete(row.id);
  for (const row of [...ctx.db.intent.iter()]) ctx.db.intent.id.delete(row.id);
  for (const row of [...ctx.db.checkRun.iter()]) ctx.db.checkRun.runKey.delete(row.runKey);
  for (const row of [...ctx.db.conflict.iter()]) ctx.db.conflict.id.delete(row.id);
  for (const row of [...ctx.db.inbox.iter()]) ctx.db.inbox.id.delete(row.id);
  for (const row of [...ctx.db.diagnosisStep.iter()]) ctx.db.diagnosisStep.id.delete(row.id);
  for (const row of [...ctx.db.escalationTimer.iter()]) ctx.db.escalationTimer.scheduledId.delete(row.scheduledId);
  for (const row of [...ctx.db.agent.iter()]) {
    ctx.db.agent.name.update({ ...row, status: 'green', intent: '', files: [], lastSnapshotAt: 0 });
  }
});

export const escalate = spacetimedb.reducer(
  { onSchedule: escalationTimer },
  { timer: escalationTimer.rowType },
  (ctx, { timer }) => {
    if (!ctx.senderAuth.isInternal) throw new SenderError('escalate only runs on its schedule');
    const row = ctx.db.conflict.id.find(timer.conflictId);
    if (row && row.status === 'open') ctx.db.conflict.id.update({ ...row, status: 'escalated' });
  }
);

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  if (!ctx.connectionId) return;
  const row = ctx.db.agentConnection.connectionId.find(ctx.connectionId);
  if (!row) return;
  ctx.db.agentConnection.connectionId.delete(ctx.connectionId);
  const stillConnected = [...ctx.db.agentConnection.iter()].some((c) => c.agent === row.agent);
  const member = ctx.db.agent.name.find(row.agent);
  if (member && !stillConnected && member.online) ctx.db.agent.name.update({ ...member, online: false });
});
