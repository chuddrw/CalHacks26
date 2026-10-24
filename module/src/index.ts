/**
 * WHAT IT'S FOR: Part C's SpacetimeDB 2.13 transactional module. Public columns and reducer
 * argument order match shared/src/schema.ts. Approved public types: u32 IDs, f64 safe integer
 * millisecond timestamps. Presence connections and five-minute escalation timers are private.
 */
import { ScheduleAt } from 'spacetimedb';
import { schema, table, t, SenderError, CaseConversionPolicy, type ReducerCtx } from 'spacetimedb/server';

const agent = table({ name: 'agent', public: true }, {
  name: t.string().primaryKey(), online: t.bool(), status: t.string(), intent: t.string(),
  files: t.array(t.string()), lastSnapshotAt: t.f64().name("lastSnapshotAt"),
});
const snapshot = table({ name: 'snapshot', public: true }, {
  id: t.u32().primaryKey().autoInc(), agent: t.string(), sha: t.string(), baseSha: t.string().name("baseSha"),
  files: t.array(t.string()), diff: t.string(), createdAt: t.f64().name("createdAt"),
});
const intent = table({ name: 'intent', public: true }, {
  id: t.u32().primaryKey().autoInc(), agent: t.string(), summary: t.string(),
  files: t.array(t.string()), symbols: t.array(t.string()), verified: t.bool(), createdAt: t.f64().name("createdAt"),
});
const check_run = table({ name: 'check_run', public: true }, {
  runKey: t.string().name("runKey").primaryKey(), agents: t.array(t.string()), result: t.string(),
  log: t.string(), createdAt: t.f64().name("createdAt"),
});
const conflict = table({ name: 'conflict', public: true }, {
  id: t.u32().primaryKey().autoInc(), pair: t.string().index('btree'), kind: t.string(),
  agentA: t.string().name("agentA"), agentB: t.string().name("agentB"), locA: t.string().name("locA"), locB: t.string().name("locB"), error: t.string(),
  explanation: t.string(), fixer: t.string(), status: t.string(), runKey: t.string().name("runKey"),
  createdAt: t.f64().name("createdAt"), resolvedAt: t.f64().name("resolvedAt"),
});
const inbox = table({ name: 'inbox', public: true }, {
  id: t.u32().primaryKey().autoInc(), agent: t.string().index('btree'), kind: t.string(),
  conflictId: t.u32().name("conflictId"), message: t.string(), delivered: t.bool(), createdAt: t.f64().name("createdAt"),
});
const diagnosis_step = table({ name: 'diagnosis_step', public: true }, {
  id: t.u32().primaryKey().autoInc(), conflictId: t.u32().name("conflictId").index('btree'), source: t.string(),
  kind: t.string(), detail: t.string(), createdAt: t.f64().name("createdAt"),
});
const agent_connection = table({ name: 'agent_connection' }, {
  connectionId: t.connectionId().primaryKey(), agent: t.string(),
});
const escalation_timer = table({ name: 'escalation_timer' }, {
  scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), conflictId: t.u32().name("conflictId"),
});
const spacetimedb = schema({ agent, snapshot, intent, check_run, conflict, inbox,
  diagnosis_step, agent_connection, escalation_timer }, {
  // SQL callers already use the frozen camelCase column names; don't normalize them.
  CASE_CONVERSION_POLICY: CaseConversionPolicy.None,
});
export default spacetimedb;
type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;

function now(ctx: Ctx): number {
  const ms = Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new SenderError('Timestamp out of range');
  return ms;
}
function name(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) throw new SenderError('Invalid agent name');
}
function oneOf(value: string, values: readonly string[]): void {
  if (!values.includes(value)) throw new SenderError(`Invalid value: ${value}`);
}
/** Bound display fields in UTF-8 bytes without splitting surrogate pairs. */
function cut(value: string, limit: number): string {
  let bytes = 0;
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > limit) break;
    result += char;
  }
  return result;
}
function ensureAgent(ctx: Ctx, value: string) {
  name(value);
  return ctx.db.agent.name.find(value) ?? ctx.db.agent.insert({ name: value, online: false,
    status: 'green', intent: '', files: [], lastSnapshotAt: 0 });
}
function active(status: string): boolean { return status !== 'resolved'; }
function refresh(ctx: Ctx, value: string): void {
  if (!value) return;
  const row = ensureAgent(ctx, value);
  const blocked = [...ctx.db.conflict.iter()].some(c => active(c.status) &&
    (c.agentA === value || c.agentB === value));
  ctx.db.agent.name.update({ ...row, status: blocked ? 'red' : 'green' });
}
function note(ctx: Ctx, recipient: string, kind: string, conflictId: number, message: string): void {
  ensureAgent(ctx, recipient);
  ctx.db.inbox.insert({ id: 0, agent: recipient, kind, conflictId, message,
    delivered: false, createdAt: now(ctx) });
}
function getConflict(ctx: Ctx, id: number) {
  const row = ctx.db.conflict.id.find(id);
  if (!row) throw new SenderError(`Unknown conflict #${id}`);
  return row;
}
function retireWakeups(ctx: Ctx, id: number): void {
  for (const message of ctx.db.inbox.iter()) if (message.conflictId === id &&
    message.kind === 'conflict' && !message.delivered) ctx.db.inbox.id.update({ ...message, delivered: true });
}

export const register_agent = spacetimedb.reducer({ agent: t.string() }, (ctx, args) => {
  if (!ctx.connectionId) throw new SenderError('register_agent requires a live connection');
  const row = ensureAgent(ctx, args.agent);
  const old = ctx.db.agent_connection.connectionId.find(ctx.connectionId);
  if (old) ctx.db.agent_connection.connectionId.update({ ...old, agent: args.agent });
  else ctx.db.agent_connection.insert({ connectionId: ctx.connectionId, agent: args.agent });
  ctx.db.agent.name.update({ ...row, online: true });
  if (old && old.agent !== args.agent) {
    const previous = ctx.db.agent.name.find(old.agent);
    if (previous) ctx.db.agent.name.update({ ...previous, online:
      [...ctx.db.agent_connection.iter()].some(c => c.agent === old.agent) });
  }
});
export const client_disconnected = spacetimedb.clientDisconnected(ctx => {
  if (!ctx.connectionId) return;
  const connection = ctx.db.agent_connection.connectionId.find(ctx.connectionId);
  if (!connection) return;
  ctx.db.agent_connection.connectionId.delete(ctx.connectionId);
  const row = ctx.db.agent.name.find(connection.agent);
  if (row) ctx.db.agent.name.update({ ...row, online:
    [...ctx.db.agent_connection.iter()].some(c => c.agent === connection.agent) });
});
export const post_snapshot = spacetimedb.reducer({ agent: t.string(), sha: t.string(),
  baseSha: t.string().name("baseSha"), files: t.array(t.string()), diff: t.string() }, (ctx, args) => {
  const row = ensureAgent(ctx, args.agent);
  const createdAt = now(ctx);
  ctx.db.snapshot.insert({ id: 0, ...args, diff: cut(args.diff, 50 * 1024), createdAt });
  const blocked = [...ctx.db.conflict.iter()].some(c => c.status === 'needs_human' &&
    (c.agentA === args.agent || c.agentB === args.agent));
  ctx.db.agent.name.update({ ...row, status: blocked ? 'red' : 'working', files: args.files,
    lastSnapshotAt: createdAt });
});
export const post_intent = spacetimedb.reducer({ agent: t.string(), summary: t.string(),
  files: t.array(t.string()), symbols: t.array(t.string()) }, (ctx, args) => {
  const row = ensureAgent(ctx, args.agent);
  ctx.db.intent.insert({ id: 0, ...args, verified: false, createdAt: now(ctx) });
  ctx.db.agent.name.update({ ...row, intent: args.summary });
  for (const other of ctx.db.agent.iter()) if (other.name !== args.agent) {
    note(ctx, other.name, 'heads_up', 0, `[cowork] ${args.agent} plans: ${args.summary} (files: ${args.files.join(', ')})`);
  }
});
export const report_check = spacetimedb.reducer({ runKey: t.string().name("runKey"), agents: t.array(t.string()),
  result: t.string(), log: t.string() }, (ctx, args) => {
  oneOf(args.result, ['green', 'red']);
  args.agents.forEach(name);
  const row = { ...args, log: cut(args.log, 20 * 1024), createdAt: now(ctx) };
  if (ctx.db.check_run.runKey.find(args.runKey)) ctx.db.check_run.runKey.update(row);
  else ctx.db.check_run.insert(row);
  if (args.result === 'green') for (const value of args.agents) refresh(ctx, value);
});
export const report_conflict = spacetimedb.reducer({ kind: t.string(), agentA: t.string().name("agentA"),
  agentB: t.string().name("agentB"), locA: t.string().name("locA"), locB: t.string().name("locB"), error: t.string(), fixer: t.string(),
  runKey: t.string().name("runKey") }, (ctx, args) => {
  oneOf(args.kind, ['self', 'merge', 'pair']);
  name(args.agentA);
  if (args.kind === 'self' ? args.agentB !== '' : !args.agentB || args.agentA === args.agentB) {
    throw new SenderError('self requires one agent; merge/pair require two distinct agents');
  }
  if (args.agentB) name(args.agentB);
  if (args.fixer !== args.agentA && args.fixer !== args.agentB) throw new SenderError('Fixer must belong to conflict');
  const pair = args.agentB ? [args.agentA, args.agentB].sort().join('+') : args.agentA;
  const existing = [...ctx.db.conflict.pair.filter(pair)].find(c => active(c.status));
  const error = cut(args.error, 4 * 1024);
  if (existing) {
    const changed = existing.error !== error || existing.fixer !== args.fixer;
    ctx.db.conflict.id.update({ ...existing, ...args, error,
      explanation: existing.error === error && existing.fixer === args.fixer ? existing.explanation : '' });
    if (changed && existing.status !== 'needs_human') {
      retireWakeups(ctx, existing.id);
      note(ctx, args.fixer, 'conflict', existing.id, `[cowork] Still red after your last change. Conflict #${existing.id}: you are the fixer`);
      const other = args.fixer === args.agentA ? args.agentB : args.agentA;
      if (other) note(ctx, other, 'info', existing.id, `[cowork] Conflict #${existing.id}: ${args.fixer} is the fixer`);
    }
  } else {
    const row = ctx.db.conflict.insert({ id: 0, pair, ...args, error, explanation: '',
      status: 'open', createdAt: now(ctx), resolvedAt: 0 });
    note(ctx, args.fixer, 'conflict', row.id, `[cowork] Conflict #${row.id}: you are the fixer`);
    const other = args.fixer === args.agentA ? args.agentB : args.agentA;
    if (other) note(ctx, other, 'info', row.id, `[cowork] Conflict #${row.id}: ${args.fixer} is the fixer`);
    ctx.db.escalation_timer.insert({ scheduledId: 0n, scheduledAt:
      ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + 5n * 60n * 1_000_000n), conflictId: row.id });
  }
  refresh(ctx, args.agentA);
  if (args.agentB) refresh(ctx, args.agentB);
});
export const add_diagnosis_step = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), source: t.string(),
  kind: t.string(), detail: t.string() }, (ctx, args) => {
  getConflict(ctx, args.conflictId);
  oneOf(args.source, ['droid', 'claude']);
  oneOf(args.kind, ['status', 'tool_call', 'tool_result', 'thought', 'final', 'error']);
  ctx.db.diagnosis_step.insert({ id: 0, ...args, detail: cut(args.detail, 2 * 1024), createdAt: now(ctx) });
});
export const set_explanation = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), explanation: t.string() }, (ctx, args) => {
  const row = getConflict(ctx, args.conflictId);
  if (!active(row.status) || row.explanation === args.explanation) return;
  ctx.db.conflict.id.update({ ...row, explanation: args.explanation });
  const delivered = [...ctx.db.inbox.iter()].some(m => m.conflictId === row.id &&
    m.agent === row.fixer && m.kind === 'conflict' && m.delivered);
  if (delivered) note(ctx, row.fixer, 'info', row.id, `[cowork] Diagnosis for conflict #${row.id}: ${args.explanation}`);
});
export const resolve_conflict = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), verifiedFact: t.string() }, (ctx, args) => {
  const row = getConflict(ctx, args.conflictId);
  if (row.status === 'resolved' || row.status === 'needs_human') return;
  ctx.db.conflict.id.update({ ...row, status: 'resolved', resolvedAt: now(ctx) });
  retireWakeups(ctx, row.id);
  for (const timer of ctx.db.escalation_timer.iter()) if (timer.conflictId === row.id) {
    ctx.db.escalation_timer.scheduledId.delete(timer.scheduledId);
  }
  refresh(ctx, row.agentA);
  if (row.agentB) refresh(ctx, row.agentB);
  if (args.verifiedFact.trim()) {
    const files = [...new Set([...(ctx.db.agent.name.find(row.agentA)?.files ?? []),
      ...(ctx.db.agent.name.find(row.agentB)?.files ?? [])])];
    ctx.db.intent.insert({ id: 0, agent: 'watcher', summary: args.verifiedFact, files,
      symbols: [], verified: true, createdAt: now(ctx) });
    for (const recipient of ctx.db.agent.iter()) note(ctx, recipient.name, 'fact', row.id, `[cowork] Verified fact: ${args.verifiedFact}`);
  }
});
export const flag_needs_human = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), reason: t.string() }, (ctx, args) => {
  const row = getConflict(ctx, args.conflictId);
  if (row.status === 'resolved' || row.status === 'needs_human') return;
  ctx.db.conflict.id.update({ ...row, status: 'needs_human' });
  retireWakeups(ctx, row.id);
  for (const recipient of [row.agentA, row.agentB].filter(Boolean)) {
    note(ctx, recipient, 'info', row.id, `[cowork] Conflict #${row.id} needs a person: ${args.reason}. Do not edit tests to make checks pass.`);
    refresh(ctx, recipient);
  }
});
export const send_note = spacetimedb.reducer({ agent: t.string(), kind: t.string(), message: t.string() }, (ctx, args) => {
  oneOf(args.kind, ['conflict', 'info', 'heads_up', 'fact']);
  note(ctx, args.agent, args.kind, 0, args.message);
});
export const mark_delivered = spacetimedb.reducer({ inboxIds: t.array(t.u32()) }, (ctx, args) => {
  for (const id of args.inboxIds) {
    const row = ctx.db.inbox.id.find(id);
    if (row) ctx.db.inbox.id.update({ ...row, delivered: true });
  }
});
export const reset_all = spacetimedb.reducer({}, ctx => {
  for (const row of ctx.db.escalation_timer.iter()) ctx.db.escalation_timer.scheduledId.delete(row.scheduledId);
  for (const row of ctx.db.agent_connection.iter()) ctx.db.agent_connection.connectionId.delete(row.connectionId);
  for (const row of ctx.db.diagnosis_step.iter()) ctx.db.diagnosis_step.id.delete(row.id);
  for (const row of ctx.db.inbox.iter()) ctx.db.inbox.id.delete(row.id);
  for (const row of ctx.db.conflict.iter()) ctx.db.conflict.id.delete(row.id);
  for (const row of ctx.db.check_run.iter()) ctx.db.check_run.runKey.delete(row.runKey);
  for (const row of ctx.db.intent.iter()) ctx.db.intent.id.delete(row.id);
  for (const row of ctx.db.snapshot.iter()) ctx.db.snapshot.id.delete(row.id);
  for (const row of ctx.db.agent.iter()) ctx.db.agent.name.delete(row.name);
});
export const escalate = spacetimedb.reducer({ onSchedule: escalation_timer },
  { arg: escalation_timer.rowType }, (ctx, { arg }) => {
    if (!ctx.sender.isEqual(ctx.identity)) throw new SenderError('Scheduled calls only');
    const row = ctx.db.conflict.id.find(arg.conflictId);
    if (row?.status === 'open') ctx.db.conflict.id.update({ ...row, status: 'escalated' });
  });
