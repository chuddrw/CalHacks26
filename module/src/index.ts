/**
 * WHAT IT'S FOR: Part C's SpacetimeDB 2.13 transactional module. Public columns and reducer
 * argument order match shared/src/schema.ts. Approved public types: u32 IDs, f64 safe integer
 * millisecond timestamps. Team data is private; authenticated views preserve the public query
 * names and rows. Owner-managed Reader/Editor membership governs access independently of
 * Maincloud management roles. Required ACCESS_OWNER_IDENTITY is the owner's public identity.
 */
import { Identity, ScheduleAt } from 'spacetimedb';
import { schema, table, t, SenderError, CaseConversionPolicy, type ReducerCtx, type ViewCtx } from 'spacetimedb/server';

const agentData = table({ name: 'agent_data' }, {
  name: t.string().primaryKey(), online: t.bool(), status: t.string(), intent: t.string(),
  files: t.array(t.string()), lastSnapshotAt: t.f64().name("lastSnapshotAt"),
});
const snapshotData = table({ name: 'snapshot_data' }, {
  id: t.u32().primaryKey().autoInc(), agent: t.string(), sha: t.string(), baseSha: t.string().name("baseSha"),
  files: t.array(t.string()), diff: t.string(), createdAt: t.f64().name("createdAt"),
});
const intentData = table({ name: 'intent_data' }, {
  id: t.u32().primaryKey().autoInc(), agent: t.string(), summary: t.string(),
  files: t.array(t.string()), symbols: t.array(t.string()), verified: t.bool(), createdAt: t.f64().name("createdAt"),
});
const checkRunData = table({ name: 'check_run_data' }, {
  runKey: t.string().name("runKey").primaryKey(), agents: t.array(t.string()), result: t.string(),
  log: t.string(), createdAt: t.f64().name("createdAt"),
});
const conflictData = table({ name: 'conflict_data' }, {
  id: t.u32().primaryKey().autoInc(), pair: t.string().index('btree'), kind: t.string(),
  agentA: t.string().name("agentA"), agentB: t.string().name("agentB"), locA: t.string().name("locA"), locB: t.string().name("locB"), error: t.string(),
  explanation: t.string(), fixer: t.string(), status: t.string(), runKey: t.string().name("runKey"),
  createdAt: t.f64().name("createdAt"), resolvedAt: t.f64().name("resolvedAt"),
});
const inboxData = table({ name: 'inbox_data' }, {
  id: t.u32().primaryKey().autoInc(), agent: t.string().index('btree'), kind: t.string(),
  conflictId: t.u32().name("conflictId"), message: t.string(), delivered: t.bool(), createdAt: t.f64().name("createdAt"),
});
const diagnosisStepData = table({ name: 'diagnosis_step_data' }, {
  id: t.u32().primaryKey().autoInc(), conflictId: t.u32().name("conflictId").index('btree'), source: t.string(),
  kind: t.string(), detail: t.string(), createdAt: t.f64().name("createdAt"),
});
const agent_connection = table({ name: 'agent_connection' }, {
  connectionId: t.connectionId().primaryKey(), agent: t.string(), identity: t.identity().default(Identity.zero()),
});
const escalation_timer = table({ name: 'escalation_timer' }, {
  scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), conflictId: t.u32().name("conflictId"),
});
const accessMember = table({ name: 'access_member' }, {
  identity: t.identity().primaryKey(), role: t.string(),
});
const spacetimedb = schema({ agentData, snapshotData, intentData, checkRunData, conflictData, inboxData,
  diagnosisStepData, accessMember, agent_connection, escalation_timer }, {
  // SQL callers already use the frozen camelCase column names; don't normalize them.
  CASE_CONVERSION_POLICY: CaseConversionPolicy.None,
  env: { ACCESS_OWNER_IDENTITY: t.string() },
});
export default spacetimedb;
type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;
type AccessCtx = Pick<ViewCtx<typeof spacetimedb.schemaType>, 'db' | 'env' | 'sender'>;

function parseIdentity(value: string, label = 'Identity'): Identity {
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) throw new SenderError(`${label} must be a valid public identity`);
  const identity = Identity.fromString(value);
  if (identity.isEqual(Identity.zero())) throw new SenderError(`${label} must be nonzero`);
  return identity;
}
function ownerIdentity(ctx: AccessCtx): Identity {
  return parseIdentity(ctx.env.ACCESS_OWNER_IDENTITY, 'ACCESS_OWNER_IDENTITY');
}
function role(ctx: AccessCtx): 'owner' | 'reader' | 'editor' | null {
  if (ctx.sender.isEqual(ownerIdentity(ctx))) return 'owner';
  const member = ctx.db.accessMember.identity.find(ctx.sender);
  return member?.role === 'reader' || member?.role === 'editor' ? member.role : null;
}
function signedIn(ctx: Ctx): void {
  const jwt = ctx.senderAuth.jwt;
  if (!ctx.senderAuth.hasJWT || !jwt || !jwt.issuer || !jwt.subject || !jwt.identity.isEqual(ctx.sender)) {
    throw new SenderError('Sign in before accessing this database');
  }
}
function requireEditor(ctx: Ctx): void {
  signedIn(ctx);
  const access = role(ctx);
  if (access !== 'editor' && access !== 'owner') throw new SenderError('Editor access required');
}
function requireOwner(ctx: Ctx): void {
  signedIn(ctx);
  if (role(ctx) !== 'owner') throw new SenderError('Owner access required');
}

export const client_connected = spacetimedb.clientConnected(ctx => {
  signedIn(ctx);
  if (!role(ctx)) throw new SenderError('Database membership required');
});

/** Every view reads the membership index inside its callback, including on revocation. */
export const agent = spacetimedb.view({ name: 'agent', public: true }, t.array(agentData.rowType),
  ctx => ctx.from.agentData.where(() => role(ctx) !== null).build());
export const snapshot = spacetimedb.view({ name: 'snapshot', public: true }, t.array(snapshotData.rowType),
  ctx => ctx.from.snapshotData.where(() => role(ctx) !== null).build());
export const intent = spacetimedb.view({ name: 'intent', public: true }, t.array(intentData.rowType),
  ctx => ctx.from.intentData.where(() => role(ctx) !== null).build());
export const check_run = spacetimedb.view({ name: 'check_run', public: true }, t.array(checkRunData.rowType),
  ctx => ctx.from.checkRunData.where(() => role(ctx) !== null).build());
export const conflict = spacetimedb.view({ name: 'conflict', public: true }, t.array(conflictData.rowType),
  ctx => ctx.from.conflictData.where(() => role(ctx) !== null).build());
export const inbox = spacetimedb.view({ name: 'inbox', public: true }, t.array(inboxData.rowType),
  ctx => ctx.from.inboxData.where(() => role(ctx) !== null).build());
export const diagnosis_step = spacetimedb.view({ name: 'diagnosis_step', public: true }, t.array(diagnosisStepData.rowType),
  ctx => ctx.from.diagnosisStepData.where(() => role(ctx) !== null).build());

export const grant_access = spacetimedb.reducer({ identity: t.string(), role: t.string() }, (ctx, args) => {
  requireOwner(ctx);
  oneOf(args.role, ['reader', 'editor']);
  const identity = parseIdentity(args.identity);
  if (identity.isEqual(ownerIdentity(ctx))) throw new SenderError('Owner access is configured by ACCESS_OWNER_IDENTITY');
  const row = { identity, role: args.role };
  const previous = ctx.db.accessMember.identity.find(identity);
  if (previous) ctx.db.accessMember.identity.update(row);
  else ctx.db.accessMember.insert(row);
});
export const revoke_access = spacetimedb.reducer({ identity: t.string() }, (ctx, args) => {
  requireOwner(ctx);
  const identity = parseIdentity(args.identity);
  if (identity.isEqual(ownerIdentity(ctx))) throw new SenderError('Owner access is configured by ACCESS_OWNER_IDENTITY');
  ctx.db.accessMember.identity.delete(identity);
  // A revoked socket cannot write or read views again; retire its presence immediately as well.
  const affected = new Set<string>();
  for (const connection of ctx.db.agent_connection.iter()) if (connection.identity.isEqual(identity)) {
    affected.add(connection.agent);
    ctx.db.agent_connection.connectionId.delete(connection.connectionId);
  }
  for (const name of affected) {
    const agent = ctx.db.agentData.name.find(name);
    if (agent) ctx.db.agentData.name.update({ ...agent, online:
      [...ctx.db.agent_connection.iter()].some(connection => connection.agent === name) });
  }
});

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
  return ctx.db.agentData.name.find(value) ?? ctx.db.agentData.insert({ name: value, online: false,
    status: 'green', intent: '', files: [], lastSnapshotAt: 0 });
}
function active(status: string): boolean { return status !== 'resolved'; }
function refresh(ctx: Ctx, value: string): void {
  if (!value) return;
  const row = ensureAgent(ctx, value);
  const blocked = [...ctx.db.conflictData.iter()].some(c => active(c.status) &&
    (c.agentA === value || c.agentB === value));
  ctx.db.agentData.name.update({ ...row, status: blocked ? 'red' : 'green' });
}
function note(ctx: Ctx, recipient: string, kind: string, conflictId: number, message: string): void {
  ensureAgent(ctx, recipient);
  ctx.db.inboxData.insert({ id: 0, agent: recipient, kind, conflictId, message,
    delivered: false, createdAt: now(ctx) });
}
function getConflict(ctx: Ctx, id: number) {
  const row = ctx.db.conflictData.id.find(id);
  if (!row) throw new SenderError(`Unknown conflict #${id}`);
  return row;
}
function retireWakeups(ctx: Ctx, id: number): void {
  for (const message of ctx.db.inboxData.iter()) if (message.conflictId === id &&
    message.kind === 'conflict' && !message.delivered) ctx.db.inboxData.id.update({ ...message, delivered: true });
}

export const register_agent = spacetimedb.reducer({ agent: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  if (!ctx.connectionId) throw new SenderError('register_agent requires a live connection');
  const row = ensureAgent(ctx, args.agent);
  const old = ctx.db.agent_connection.connectionId.find(ctx.connectionId);
  if (old) ctx.db.agent_connection.connectionId.update({ ...old, agent: args.agent, identity: ctx.sender });
  else ctx.db.agent_connection.insert({ connectionId: ctx.connectionId, agent: args.agent, identity: ctx.sender });
  ctx.db.agentData.name.update({ ...row, online: true });
  if (old && old.agent !== args.agent) {
    const previous = ctx.db.agentData.name.find(old.agent);
    if (previous) ctx.db.agentData.name.update({ ...previous, online:
      [...ctx.db.agent_connection.iter()].some(c => c.agent === old.agent) });
  }
});
export const client_disconnected = spacetimedb.clientDisconnected(ctx => {
  if (!ctx.connectionId) return;
  const connection = ctx.db.agent_connection.connectionId.find(ctx.connectionId);
  if (!connection) return;
  ctx.db.agent_connection.connectionId.delete(ctx.connectionId);
  const row = ctx.db.agentData.name.find(connection.agent);
  if (row) ctx.db.agentData.name.update({ ...row, online:
    [...ctx.db.agent_connection.iter()].some(c => c.agent === connection.agent) });
});
export const post_snapshot = spacetimedb.reducer({ agent: t.string(), sha: t.string(),
  baseSha: t.string().name("baseSha"), files: t.array(t.string()), diff: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const row = ensureAgent(ctx, args.agent);
  const createdAt = now(ctx);
  ctx.db.snapshotData.insert({ id: 0, ...args, diff: cut(args.diff, 50 * 1024), createdAt });
  const blocked = [...ctx.db.conflictData.iter()].some(c => c.status === 'needs_human' &&
    (c.agentA === args.agent || c.agentB === args.agent));
  ctx.db.agentData.name.update({ ...row, status: blocked ? 'red' : 'working', files: args.files,
    lastSnapshotAt: createdAt });
});
export const post_intent = spacetimedb.reducer({ agent: t.string(), summary: t.string(),
  files: t.array(t.string()), symbols: t.array(t.string()) }, (ctx, args) => {
  requireEditor(ctx);
  const row = ensureAgent(ctx, args.agent);
  ctx.db.intentData.insert({ id: 0, ...args, verified: false, createdAt: now(ctx) });
  ctx.db.agentData.name.update({ ...row, intent: args.summary });
  for (const other of ctx.db.agentData.iter()) if (other.name !== args.agent) {
    note(ctx, other.name, 'heads_up', 0, `[cowork] ${args.agent} plans: ${args.summary} (files: ${args.files.join(', ')})`);
  }
});
export const report_check = spacetimedb.reducer({ runKey: t.string().name("runKey"), agents: t.array(t.string()),
  result: t.string(), log: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  oneOf(args.result, ['green', 'red']);
  args.agents.forEach(name);
  const row = { ...args, log: cut(args.log, 20 * 1024), createdAt: now(ctx) };
  if (ctx.db.checkRunData.runKey.find(args.runKey)) ctx.db.checkRunData.runKey.update(row);
  else ctx.db.checkRunData.insert(row);
  if (args.result === 'green') for (const value of args.agents) refresh(ctx, value);
});
export const report_conflict = spacetimedb.reducer({ kind: t.string(), agentA: t.string().name("agentA"),
  agentB: t.string().name("agentB"), locA: t.string().name("locA"), locB: t.string().name("locB"), error: t.string(), fixer: t.string(),
  runKey: t.string().name("runKey") }, (ctx, args) => {
  requireEditor(ctx);
  oneOf(args.kind, ['self', 'merge', 'pair']);
  name(args.agentA);
  if (args.kind === 'self' ? args.agentB !== '' : !args.agentB || args.agentA === args.agentB) {
    throw new SenderError('self requires one agent; merge/pair require two distinct agents');
  }
  if (args.agentB) name(args.agentB);
  if (args.fixer !== args.agentA && args.fixer !== args.agentB) throw new SenderError('Fixer must belong to conflict');
  const pair = args.agentB ? [args.agentA, args.agentB].sort().join('+') : args.agentA;
  const existing = [...ctx.db.conflictData.pair.filter(pair)].find(c => active(c.status));
  const error = cut(args.error, 4 * 1024);
  if (existing) {
    const changed = existing.error !== error || existing.fixer !== args.fixer;
    ctx.db.conflictData.id.update({ ...existing, ...args, error,
      explanation: existing.error === error && existing.fixer === args.fixer ? existing.explanation : '' });
    if (changed && existing.status !== 'needs_human') {
      retireWakeups(ctx, existing.id);
      note(ctx, args.fixer, 'conflict', existing.id, `[cowork] Still red after your last change. Conflict #${existing.id}: you are the fixer`);
      const other = args.fixer === args.agentA ? args.agentB : args.agentA;
      if (other) note(ctx, other, 'info', existing.id, `[cowork] Conflict #${existing.id}: ${args.fixer} is the fixer`);
    }
  } else {
    const row = ctx.db.conflictData.insert({ id: 0, pair, ...args, error, explanation: '',
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
  requireEditor(ctx);
  getConflict(ctx, args.conflictId);
  oneOf(args.source, ['droid', 'claude']);
  oneOf(args.kind, ['status', 'tool_call', 'tool_result', 'thought', 'final', 'error']);
  ctx.db.diagnosisStepData.insert({ id: 0, ...args, detail: cut(args.detail, 2 * 1024), createdAt: now(ctx) });
});
export const set_explanation = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), explanation: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const row = getConflict(ctx, args.conflictId);
  if (!active(row.status) || row.explanation === args.explanation) return;
  ctx.db.conflictData.id.update({ ...row, explanation: args.explanation });
  const delivered = [...ctx.db.inboxData.iter()].some(m => m.conflictId === row.id &&
    m.agent === row.fixer && m.kind === 'conflict' && m.delivered);
  if (delivered) note(ctx, row.fixer, 'info', row.id, `[cowork] Diagnosis for conflict #${row.id}: ${args.explanation}`);
});
export const resolve_conflict = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), verifiedFact: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const row = getConflict(ctx, args.conflictId);
  if (row.status === 'resolved' || row.status === 'needs_human') return;
  ctx.db.conflictData.id.update({ ...row, status: 'resolved', resolvedAt: now(ctx) });
  retireWakeups(ctx, row.id);
  for (const timer of ctx.db.escalation_timer.iter()) if (timer.conflictId === row.id) {
    ctx.db.escalation_timer.scheduledId.delete(timer.scheduledId);
  }
  refresh(ctx, row.agentA);
  if (row.agentB) refresh(ctx, row.agentB);
  if (args.verifiedFact.trim()) {
    const files = [...new Set([...(ctx.db.agentData.name.find(row.agentA)?.files ?? []),
      ...(ctx.db.agentData.name.find(row.agentB)?.files ?? [])])];
    ctx.db.intentData.insert({ id: 0, agent: 'watcher', summary: args.verifiedFact, files,
      symbols: [], verified: true, createdAt: now(ctx) });
    for (const recipient of ctx.db.agentData.iter()) note(ctx, recipient.name, 'fact', row.id, `[cowork] Verified fact: ${args.verifiedFact}`);
  }
});
export const flag_needs_human = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), reason: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const row = getConflict(ctx, args.conflictId);
  if (row.status === 'resolved' || row.status === 'needs_human') return;
  ctx.db.conflictData.id.update({ ...row, status: 'needs_human' });
  retireWakeups(ctx, row.id);
  for (const recipient of [row.agentA, row.agentB].filter(Boolean)) {
    note(ctx, recipient, 'info', row.id, `[cowork] Conflict #${row.id} needs a person: ${args.reason}. Do not edit tests to make checks pass.`);
    refresh(ctx, recipient);
  }
});
export const send_note = spacetimedb.reducer({ agent: t.string(), kind: t.string(), message: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  oneOf(args.kind, ['conflict', 'info', 'heads_up', 'fact']);
  note(ctx, args.agent, args.kind, 0, args.message);
});
export const mark_delivered = spacetimedb.reducer({ inboxIds: t.array(t.u32()) }, (ctx, args) => {
  requireEditor(ctx);
  for (const id of args.inboxIds) {
    const row = ctx.db.inboxData.id.find(id);
    if (row) ctx.db.inboxData.id.update({ ...row, delivered: true });
  }
});
export const reset_all = spacetimedb.reducer({}, ctx => {
  requireOwner(ctx);
  for (const row of ctx.db.escalation_timer.iter()) ctx.db.escalation_timer.scheduledId.delete(row.scheduledId);
  for (const row of ctx.db.agent_connection.iter()) ctx.db.agent_connection.connectionId.delete(row.connectionId);
  for (const row of ctx.db.diagnosisStepData.iter()) ctx.db.diagnosisStepData.id.delete(row.id);
  for (const row of ctx.db.inboxData.iter()) ctx.db.inboxData.id.delete(row.id);
  for (const row of ctx.db.conflictData.iter()) ctx.db.conflictData.id.delete(row.id);
  for (const row of ctx.db.checkRunData.iter()) ctx.db.checkRunData.runKey.delete(row.runKey);
  for (const row of ctx.db.intentData.iter()) ctx.db.intentData.id.delete(row.id);
  for (const row of ctx.db.snapshotData.iter()) ctx.db.snapshotData.id.delete(row.id);
  for (const row of ctx.db.agentData.iter()) ctx.db.agentData.name.delete(row.name);
});
export const escalate = spacetimedb.reducer({ onSchedule: escalation_timer },
  { arg: escalation_timer.rowType }, (ctx, { arg }) => {
    if (!ctx.senderAuth.isInternal || !ctx.sender.isEqual(ctx.databaseIdentity)) throw new SenderError('Scheduled calls only');
    const row = ctx.db.conflictData.id.find(arg.conflictId);
    if (row?.status === 'open') ctx.db.conflictData.id.update({ ...row, status: 'escalated' });
  });
