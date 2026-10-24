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
/** A person sent a test-changing fix back; only a newer snapshot from the fixer can resolve it. */
const testReview = table({ name: 'test_review' }, {
  conflictId: t.u32().name("conflictId").primaryKey(), snapshotId: t.u32().name("snapshotId"), createdAt: t.f64().name("createdAt"),
});
const accessMember = table({ name: 'access_member' }, {
  identity: t.identity().primaryKey(), role: t.string(),
});
// Orchestrator (branch feat/orchestrator): what humans asked, the plan's tasks and reviews, the
// conversation inside each conflict thread, and the orchestrator's live steps.
const requestData = table({ name: 'request_data' }, {
  id: t.u32().primaryKey().autoInc(), agent: t.string(), body: t.string(), status: t.string(),
  summary: t.string(), plan: t.string(), createdAt: t.f64().name("createdAt"), updatedAt: t.f64().name("updatedAt"),
});
const taskData = table({ name: 'task_data' }, {
  id: t.u32().primaryKey().autoInc(), requestId: t.u32().name("requestId").index('btree'), agent: t.string(),
  title: t.string(), details: t.string(), files: t.array(t.string()), major: t.bool(), status: t.string(),
  note: t.string(), createdAt: t.f64().name("createdAt"), updatedAt: t.f64().name("updatedAt"),
});
const reviewData = table({ name: 'review_data' }, {
  id: t.u32().primaryKey().autoInc(), requestId: t.u32().name("requestId").index('btree'), reviewer: t.string(),
  summary: t.string(), status: t.string(), answer: t.string(), createdAt: t.f64().name("createdAt"),
  decidedAt: t.f64().name("decidedAt"),
});
const messageData = table({ name: 'message_data' }, {
  id: t.u32().primaryKey().autoInc(), conflictId: t.u32().name("conflictId").index('btree'), author: t.string(),
  kind: t.string(), body: t.string(), createdAt: t.f64().name("createdAt"),
});
const planStepData = table({ name: 'plan_step_data' }, {
  id: t.u32().primaryKey().autoInc(), requestId: t.u32().name("requestId").index('btree'), kind: t.string(),
  detail: t.string(), createdAt: t.f64().name("createdAt"),
});
const spacetimedb = schema({ agentData, snapshotData, intentData, checkRunData, conflictData, inboxData,
  diagnosisStepData, accessMember, agent_connection, escalation_timer, testReview,
  requestData, taskData, reviewData, messageData, planStepData }, {
  // SQL callers already use the frozen camelCase column names; don't normalize them.
  CASE_CONVERSION_POLICY: CaseConversionPolicy.None,
  env: { ACCESS_OWNER_IDENTITY: t.string() },
});
export default spacetimedb;
type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;
type AccessCtx = Pick<ViewCtx<typeof spacetimedb.schemaType>, 'db' | 'env' | 'sender'>;

/** Author of the orchestrator's thread messages and of verified facts (shared ORCHESTRATOR_NAME). */
const ORCHESTRATOR = 'orchestrator';
/** Author of a decision both humans send from the dashboard (shared HUMAN_AUTHOR). */
const HUMAN = 'human';
/** Messages in one thread, since the last human decision, before it goes to both humans. */
const MAX_MESSAGES = 12;

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
export const request = spacetimedb.view({ name: 'request', public: true }, t.array(requestData.rowType),
  ctx => ctx.from.requestData.where(() => role(ctx) !== null).build());
export const task = spacetimedb.view({ name: 'task', public: true }, t.array(taskData.rowType),
  ctx => ctx.from.taskData.where(() => role(ctx) !== null).build());
export const review = spacetimedb.view({ name: 'review', public: true }, t.array(reviewData.rowType),
  ctx => ctx.from.reviewData.where(() => role(ctx) !== null).build());
export const message = spacetimedb.view({ name: 'message', public: true }, t.array(messageData.rowType),
  ctx => ctx.from.messageData.where(() => role(ctx) !== null).build());
export const plan_step = spacetimedb.view({ name: 'plan_step', public: true }, t.array(planStepData.rowType),
  ctx => ctx.from.planStepData.where(() => role(ctx) !== null).build());

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
/** A potential conflict is a prediction, not a failed check, so it never turns an agent red. */
function refresh(ctx: Ctx, value: string): void {
  if (!value) return;
  const row = ensureAgent(ctx, value);
  const blocked = [...ctx.db.conflictData.iter()].some(c => active(c.status) && c.kind !== 'potential' &&
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
type ConflictRecord = ReturnType<typeof getConflict>;
type Version = { expectedRunKey: string; expectedError: string; expectedFixer: string };
/** Snapshot IDs define posting order even when multiple snapshots share a millisecond timestamp. */
function currentRun(ctx: Ctx, run: { runKey: string; agents: string[] }): boolean {
  const agents = new Set(run.agents);
  if (!agents.size || agents.size !== run.agents.length) return false;
  const latest = new Map<string, { id: number; sha: string }>();
  for (const snapshot of ctx.db.snapshotData.iter()) if (agents.has(snapshot.agent)) {
    const previous = latest.get(snapshot.agent);
    if (!previous || snapshot.id > previous.id) latest.set(snapshot.agent, snapshot);
  }
  return latest.size === agents.size && [...latest.values()].map(row => row.sha).sort().join('+') === run.runKey;
}
function covers(run: { agents: string[] }, conflict: { agentA: string; agentB: string }): boolean {
  return run.agents.includes(conflict.agentA) && (!conflict.agentB || run.agents.includes(conflict.agentB));
}
function mutableConflict(row: ConflictRecord): boolean { return row.status === 'open' || row.status === 'escalated'; }
function matchesVersion(row: ConflictRecord, expected: Version): boolean {
  return mutableConflict(row) && row.runKey === expected.expectedRunKey && row.error === expected.expectedError && row.fixer === expected.expectedFixer;
}
function greenEvidence(ctx: Ctx, conflict: ConflictRecord, runKey?: string): boolean {
  const runs = runKey === undefined ? [...ctx.db.checkRunData.iter()] : [ctx.db.checkRunData.runKey.find(runKey)];
  return runs.some(run => run !== null && run.result === 'green' && covers(run, conflict) && currentRun(ctx, run));
}
function latestSnapshotId(ctx: Ctx, agent: string): number {
  let id = 0;
  for (const row of ctx.db.snapshotData.iter()) if (row.agent === agent && row.id > id) id = row.id;
  return id;
}
/** True while a person's "send back" stands: the fixer has posted nothing newer since. */
function sentBack(ctx: Ctx, row: ConflictRecord): boolean {
  const review = ctx.db.testReview.conflictId.find(row.id);
  return !!review && latestSnapshotId(ctx, row.fixer) <= review.snapshotId;
}
function scheduleEscalation(ctx: Ctx, conflictId: number): void {
  ctx.db.escalation_timer.insert({ scheduledId: 0n, scheduledAt:
    ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + 5n * 60n * 1_000_000n), conflictId });
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
  // Old results remain useful history, but must never paint newer untested snapshots green.
  if (args.result === 'green' && currentRun(ctx, row)) for (const value of args.agents) refresh(ctx, value);
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
  const check = ctx.db.checkRunData.runKey.find(args.runKey);
  if (!check || check.result !== 'red' || !covers(check, args)) throw new SenderError('Conflict requires a red check covering its agents');
  if (!currentRun(ctx, check)) return;
  const pair = args.agentB ? [args.agentA, args.agentB].sort().join('+') : args.agentA;
  const existing = [...ctx.db.conflictData.pair.filter(pair)].find(c => active(c.status));
  const error = cut(args.error, 4 * 1024);
  if (existing) {
    const changed = existing.error !== error || existing.fixer !== args.fixer;
    ctx.db.conflictData.id.update({ ...existing, ...args, error,
      explanation: existing.error === error && existing.fixer === args.fixer ? existing.explanation : '' });
    if (changed && existing.status !== 'needs_human') {
      retireWakeups(ctx, existing.id);
      // A potential conflict (flagged by the orchestrator) that a check now confirms isn't a retry.
      const why = existing.kind === 'potential' ? `The combined check now fails for conflict #${existing.id}.` : 'Still red after your last change.';
      note(ctx, args.fixer, 'conflict', existing.id, `[cowork] ${why} Conflict #${existing.id}: you are the fixer`);
      const other = args.fixer === args.agentA ? args.agentB : args.agentA;
      if (other) note(ctx, other, 'info', existing.id, `[cowork] Conflict #${existing.id}: ${args.fixer} is the fixer`);
    }
  } else {
    const row = ctx.db.conflictData.insert({ id: 0, pair, ...args, error, explanation: '',
      status: 'open', createdAt: now(ctx), resolvedAt: 0 });
    note(ctx, args.fixer, 'conflict', row.id, `[cowork] Conflict #${row.id}: you are the fixer`);
    const other = args.fixer === args.agentA ? args.agentB : args.agentA;
    if (other) note(ctx, other, 'info', row.id, `[cowork] Conflict #${row.id}: ${args.fixer} is the fixer`);
    scheduleEscalation(ctx, row.id);
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
function writeExplanation(ctx: Ctx, row: ConflictRecord, explanation: string): void {
  if (row.explanation === explanation) return;
  ctx.db.conflictData.id.update({ ...row, explanation });
  const latestWakeup = [...ctx.db.inboxData.iter()]
    .filter(m => m.conflictId === row.id && m.agent === row.fixer && m.kind === 'conflict')
    .sort((a, b) => b.id - a.id)[0];
  // Older notifications may have been retired during a retry rather than shown to the fixer.
  if (latestWakeup?.delivered) note(ctx, row.fixer, 'info', row.id, `[cowork] Diagnosis for conflict #${row.id}: ${explanation}`);
}
export const set_explanation = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), explanation: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const row = getConflict(ctx, args.conflictId);
  if (active(row.status)) writeExplanation(ctx, row, args.explanation);
});
export const set_explanation_if_current = spacetimedb.reducer({ conflictId: t.u32(), expectedRunKey: t.string(),
  expectedError: t.string(), expectedFixer: t.string(), explanation: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const row = ctx.db.conflictData.id.find(args.conflictId);
  if (row && matchesVersion(row, args)) writeExplanation(ctx, row, args.explanation);
});
function finishResolution(ctx: Ctx, row: ConflictRecord, verifiedFact: string): void {
  ctx.db.conflictData.id.update({ ...row, status: 'resolved', resolvedAt: now(ctx) });
  retireWakeups(ctx, row.id);
  for (const timer of ctx.db.escalation_timer.iter()) if (timer.conflictId === row.id) {
    ctx.db.escalation_timer.scheduledId.delete(timer.scheduledId);
  }
  ctx.db.testReview.conflictId.delete(row.id);
  refresh(ctx, row.agentA);
  if (row.agentB) refresh(ctx, row.agentB);
  if (verifiedFact.trim()) {
    const files = [...new Set([...(ctx.db.agentData.name.find(row.agentA)?.files ?? []),
      ...(ctx.db.agentData.name.find(row.agentB)?.files ?? [])])];
    ctx.db.intentData.insert({ id: 0, agent: ORCHESTRATOR, summary: verifiedFact, files,
      symbols: [], verified: true, createdAt: now(ctx) });
    for (const recipient of ctx.db.agentData.iter()) note(ctx, recipient.name, 'fact', row.id, `[cowork] Verified fact: ${verifiedFact}`);
  }
}
export const resolve_conflict = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), verifiedFact: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const row = getConflict(ctx, args.conflictId);
  if (mutableConflict(row) && !sentBack(ctx, row) && greenEvidence(ctx, row)) finishResolution(ctx, row, args.verifiedFact);
});
export const resolve_conflict_if_current = spacetimedb.reducer({ conflictId: t.u32(), expectedRunKey: t.string(),
  expectedError: t.string(), expectedFixer: t.string(), verifiedRunKey: t.string(), verifiedFact: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const row = ctx.db.conflictData.id.find(args.conflictId);
  if (row && matchesVersion(row, args) && !sentBack(ctx, row) && greenEvidence(ctx, row, args.verifiedRunKey)) {
    finishResolution(ctx, row, args.verifiedFact);
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
/**
 * A person's answer to a needs_human conflict (the fix changed existing tests).
 *   approve: the test change is accepted. Needs a current green check: approval can't make a red check pass.
 *   reject:  the conflict reopens and the fixer is woken to restore the tests and fix the code instead.
 *            Until the fixer posts a newer snapshot, no check can resolve it.
 */
export const review_test_change = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), approve: t.bool(),
  comment: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const row = getConflict(ctx, args.conflictId);
  if (row.status !== 'needs_human') throw new SenderError(`Conflict #${row.id} is not waiting for a person`);
  const comment = cut(args.comment.trim(), 500);
  const said = comment ? ` (${comment})` : '';
  const other = row.fixer === row.agentA ? row.agentB : row.agentA;
  if (args.approve) {
    if (!greenEvidence(ctx, row)) throw new SenderError('The combined check is still red. Approve the test change once it passes.');
    finishResolution(ctx, row, '');
    for (const recipient of [row.agentA, row.agentB].filter(Boolean)) {
      note(ctx, recipient, 'info', row.id, `[cowork] A person approved the test change for conflict #${row.id}${said}. The conflict is resolved.`);
    }
    return;
  }
  ctx.db.conflictData.id.update({ ...row, status: 'open' });
  const review = { conflictId: row.id, snapshotId: latestSnapshotId(ctx, row.fixer), createdAt: now(ctx) };
  if (ctx.db.testReview.conflictId.find(row.id)) ctx.db.testReview.conflictId.update(review);
  else ctx.db.testReview.insert(review);
  for (const timer of ctx.db.escalation_timer.iter()) if (timer.conflictId === row.id) {
    ctx.db.escalation_timer.scheduledId.delete(timer.scheduledId);
  }
  scheduleEscalation(ctx, row.id);
  note(ctx, row.fixer, 'conflict', row.id, `[cowork] A person sent your fix for conflict #${row.id} back${said}. Put back the tests you changed, then fix the code so those tests pass as they are.`);
  if (other) note(ctx, other, 'info', row.id, `[cowork] Conflict #${row.id}: a person sent ${row.fixer}'s test change back${said}.`);
  refresh(ctx, row.agentA);
  if (row.agentB) refresh(ctx, row.agentB);
});
export const send_note = spacetimedb.reducer({ agent: t.string(), kind: t.string(), message: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  oneOf(args.kind, ['info', 'heads_up', 'fact']);
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
  for (const row of ctx.db.planStepData.iter()) ctx.db.planStepData.id.delete(row.id);
  for (const row of ctx.db.messageData.iter()) ctx.db.messageData.id.delete(row.id);
  for (const row of ctx.db.reviewData.iter()) ctx.db.reviewData.id.delete(row.id);
  for (const row of ctx.db.taskData.iter()) ctx.db.taskData.id.delete(row.id);
  for (const row of ctx.db.requestData.iter()) ctx.db.requestData.id.delete(row.id);
  for (const row of ctx.db.escalation_timer.iter()) ctx.db.escalation_timer.scheduledId.delete(row.scheduledId);
  for (const row of ctx.db.testReview.iter()) ctx.db.testReview.conflictId.delete(row.conflictId);
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
    if (row?.status === 'open') escalateToHumans(ctx, row, ORCHESTRATOR, 'Still open after 5 minutes.');
  });

// ---- Orchestrator (branch feat/orchestrator; design in checklists/orchestrator.md) ------------
// A human asks through their own agent (submit_request). The orchestrator's Droid plans it and
// publishes the plan in one transaction (publish_plan): tasks for the agents that own each feature,
// reviews for the humans whose features a major change affects, and potential conflicts it expects.
// The two agents of a conflict talk it out themselves (post_message). Both agreeing plus a current
// green check resolves it; otherwise it goes to both humans, who decide on the dashboard.

function findRequest(ctx: Ctx, id: number) { return ctx.db.requestData.id.find(id); }
type RequestRecord = NonNullable<ReturnType<typeof findRequest>>;
function getRequest(ctx: Ctx, id: number): RequestRecord {
  const row = findRequest(ctx, id);
  if (!row) throw new SenderError(`Unknown request #${id}`);
  return row;
}
function updateRequest(ctx: Ctx, row: RequestRecord, changes: Partial<RequestRecord>): void {
  ctx.db.requestData.id.update({ ...row, ...changes, updatedAt: now(ctx) });
}
function otherSide(row: ConflictRecord, agent: string): string { return row.agentA === agent ? row.agentB : row.agentA; }
function participants(row: ConflictRecord): string[] { return [row.agentA, row.agentB].filter(Boolean); }
function post(ctx: Ctx, conflictId: number, author: string, kind: string, body: string): void {
  ctx.db.messageData.insert({ id: 0, conflictId, author, kind, body: cut(body, 4 * 1024), createdAt: now(ctx) });
}
function clearTimers(ctx: Ctx, conflictId: number): void {
  for (const timer of [...ctx.db.escalation_timer.iter()]) if (timer.conflictId === conflictId) {
    ctx.db.escalation_timer.scheduledId.delete(timer.scheduledId);
  }
}
/** Undelivered wakeups about this conflict (opening and messages) would only confuse a waiting agent. */
function retireThreadWakeups(ctx: Ctx, conflictId: number): void {
  for (const row of [...ctx.db.inboxData.iter()]) if (row.conflictId === conflictId && !row.delivered &&
    (row.kind === 'conflict' || row.kind === 'message')) ctx.db.inboxData.id.update({ ...row, delivered: true });
}
/** The thread since the last human decision, oldest first. */
function sinceDecision(ctx: Ctx, conflictId: number) {
  const all = [...ctx.db.messageData.conflictId.filter(conflictId)].sort((a, b) => a.id - b.id);
  return all.slice(all.map(m => m.kind).lastIndexOf('decision') + 1);
}
function bothAgreed(ctx: Ctx, row: ConflictRecord): boolean {
  const recent = sinceDecision(ctx, row.id);
  return participants(row).every(agent => {
    const mine = recent.filter(m => m.author === agent);
    return mine[mine.length - 1]?.kind === 'agree';
  });
}
/** A current green check that includes every participant with a snapshot. No snapshots: nothing can be broken. */
function pairGreen(ctx: Ctx, row: ConflictRecord): boolean {
  const changed = participants(row).filter(agent => latestSnapshotId(ctx, agent) > 0);
  if (changed.length === 0) return true;
  return [...ctx.db.checkRunData.iter()].some(run => run.result === 'green' &&
    changed.every(agent => run.agents.includes(agent)) && currentRun(ctx, run));
}
function escalateToHumans(ctx: Ctx, row: ConflictRecord, by: string, reason: string): void {
  ctx.db.conflictData.id.update({ ...row, status: 'escalated' });
  clearTimers(ctx, row.id);
  retireThreadWakeups(ctx, row.id);
  post(ctx, row.id, by, 'escalate', reason);
  for (const agent of participants(row)) {
    note(ctx, agent, 'info', row.id, `[cowork] Conflict #${row.id} went to both humans: ${reason} Stop working on it; their decision will wake you.`);
  }
}

interface PlanTask { agent: string; title: string; details: string; files: string[]; major: boolean }
interface PlanReview { reviewer: string; summary: string }
interface PlanConflict { agentA: string; agentB: string; topic: string; details: string; suggested: string }
interface Plan { tasks: PlanTask[]; reviews: PlanReview[]; conflicts: PlanConflict[] }

/** Validates the orchestrator's plan (shared PlanInput) before any row is written. */
function parsePlan(json: string): Plan {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new SenderError('The plan must be JSON'); }
  const record = (item: unknown, label: string): Record<string, unknown> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SenderError(`${label} must be an object`);
    return item as Record<string, unknown>;
  };
  const text = (item: unknown, label: string, limit: number, required = true): string => {
    if (typeof item !== 'string') throw new SenderError(`${label} must be text`);
    const result = cut(item.trim(), limit);
    if (required && !result) throw new SenderError(`${label} is empty`);
    return result;
  };
  const agentName = (item: unknown, label: string): string => { const result = text(item, label, 64); name(result); return result; };
  const plan = record(value, 'plan');
  const list = (key: string, max: number): unknown[] => {
    const items = plan[key] ?? [];
    if (!Array.isArray(items)) throw new SenderError(`plan.${key} must be a list`);
    if (items.length > max) throw new SenderError(`plan.${key} has more than ${max} entries`);
    return items;
  };
  const tasks = list('tasks', 20).map((item, index) => {
    const task = record(item, `plan.tasks[${index}]`);
    const files = task.files ?? [];
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) throw new SenderError(`plan.tasks[${index}].files must be a list of paths`);
    return { agent: agentName(task.agent, `plan.tasks[${index}].agent`), title: text(task.title, `plan.tasks[${index}].title`, 200),
      details: text(task.details ?? '', `plan.tasks[${index}].details`, 4 * 1024, false),
      files: (files as string[]).slice(0, 50).map(file => cut(file, 300)), major: task.major === true };
  });
  const reviews: PlanReview[] = [];
  for (const [index, item] of list('reviews', 10).entries()) {
    const review = record(item, `plan.reviews[${index}]`);
    const reviewer = agentName(review.reviewer, `plan.reviews[${index}].reviewer`);
    const summary = text(review.summary, `plan.reviews[${index}].summary`, 2 * 1024);
    if (!reviews.some(existing => existing.reviewer === reviewer)) reviews.push({ reviewer, summary });
  }
  const conflicts = list('conflicts', 10).map((item, index) => {
    const conflict = record(item, `plan.conflicts[${index}]`);
    const agentA = agentName(conflict.agentA, `plan.conflicts[${index}].agentA`);
    const agentB = agentName(conflict.agentB, `plan.conflicts[${index}].agentB`);
    if (agentA === agentB) throw new SenderError(`plan.conflicts[${index}] needs two different agents`);
    const suggested = typeof conflict.suggested === 'string' && [agentA, agentB].includes(conflict.suggested) ? conflict.suggested : agentB;
    return { agentA, agentB, topic: text(conflict.topic, `plan.conflicts[${index}].topic`, 200),
      details: text(conflict.details ?? '', `plan.conflicts[${index}].details`, 2 * 1024, false), suggested };
  });
  return { tasks, reviews, conflicts };
}

/** Opens a potential conflict between two agents and wakes both. An active one for the pair gets a message instead. */
function openPotential(ctx: Ctx, requestId: number, c: PlanConflict): void {
  const pair = [c.agentA, c.agentB].sort().join('+');
  const said = `${c.topic}${c.details ? `. ${c.details}` : ''}`;
  const existing = [...ctx.db.conflictData.pair.filter(pair)].find(row => active(row.status));
  if (existing) {
    post(ctx, existing.id, ORCHESTRATOR, 'message', `Request #${requestId} touches this too: ${said}`);
    if (existing.status === 'open') for (const agent of participants(existing)) {
      note(ctx, agent, 'message', existing.id, `[cowork] The orchestrator added to conflict #${existing.id}: ${c.topic}`);
    }
    return;
  }
  const row = ctx.db.conflictData.insert({ id: 0, pair, kind: 'potential', agentA: c.agentA, agentB: c.agentB,
    locA: '', locB: '', error: cut(`${c.topic}\n${c.details}`.trim(), 4 * 1024), explanation: '', fixer: c.suggested,
    status: 'open', runKey: '', createdAt: now(ctx), resolvedAt: 0 });
  post(ctx, row.id, ORCHESTRATOR, 'message', `${said} Suggested: ${c.suggested} adapts. Agree between you who changes what.`);
  for (const agent of [c.agentA, c.agentB]) {
    note(ctx, agent, 'conflict', row.id, `[cowork] Conflict #${row.id} with ${agent === c.agentA ? c.agentB : c.agentA}: ${c.topic}`);
  }
  scheduleEscalation(ctx, row.id);
}

/** Every review approved: the held tasks go out (each wakes its agent) and the plan's conflicts open. */
function releasePlan(ctx: Ctx, request: RequestRecord): void {
  let count = 0;
  for (const row of [...ctx.db.taskData.requestId.filter(request.id)]) if (row.status === 'waiting_review') {
    ctx.db.taskData.id.update({ ...row, status: 'assigned', updatedAt: now(ctx) });
    // Task wakeups carry the task id in the inbox row's conflictId column.
    note(ctx, row.agent, 'task', row.id, `[cowork] Task #${row.id} from the orchestrator: ${row.title}`);
    count++;
  }
  updateRequest(ctx, request, { status: count ? 'assigned' : 'done' });
  for (const conflict of parsePlan(request.plan || '{}').conflicts) openPotential(ctx, request.id, conflict);
}

export const submit_request = spacetimedb.reducer({ agent: t.string(), body: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  ensureAgent(ctx, args.agent);
  const body = cut(args.body.trim(), 4 * 1024);
  if (!body) throw new SenderError('Say what you want the orchestrator to do');
  ctx.db.requestData.insert({ id: 0, agent: args.agent, body, status: 'new', summary: '', plan: '',
    createdAt: now(ctx), updatedAt: now(ctx) });
});
/** new -> planning. Also accepts "planning", so a restarted orchestrator can pick its request up again. */
export const start_request = spacetimedb.reducer({ requestId: t.u32().name("requestId") }, (ctx, args) => {
  requireEditor(ctx);
  const row = getRequest(ctx, args.requestId);
  if (row.status !== 'new' && row.status !== 'planning') throw new SenderError(`Request #${row.id} is already ${row.status}`);
  updateRequest(ctx, row, { status: 'planning' });
});
export const add_plan_step = spacetimedb.reducer({ requestId: t.u32().name("requestId"), kind: t.string(), detail: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  getRequest(ctx, args.requestId);
  oneOf(args.kind, ['status', 'tool_call', 'tool_result', 'thought', 'final', 'error']);
  ctx.db.planStepData.insert({ id: 0, ...args, detail: cut(args.detail, 2 * 1024), createdAt: now(ctx) });
});
export const publish_plan = spacetimedb.reducer({ requestId: t.u32().name("requestId"), summary: t.string(), plan: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const request = getRequest(ctx, args.requestId);
  if (request.status !== 'new' && request.status !== 'planning') throw new SenderError(`Request #${request.id} is already ${request.status}`);
  const plan = parsePlan(args.plan);
  const summary = cut(args.summary.trim(), 4 * 1024);
  const held = plan.reviews.length > 0;
  for (const review of plan.reviews) {
    ctx.db.reviewData.insert({ id: 0, requestId: request.id, reviewer: review.reviewer, summary: review.summary,
      status: 'pending', answer: '', createdAt: now(ctx), decidedAt: 0 });
    note(ctx, review.reviewer, 'info', 0, `[cowork] ${request.agent}'s request #${request.id} affects your feature, so your human reviews it on the dashboard first: ${review.summary}`);
  }
  for (const task of plan.tasks) {
    ensureAgent(ctx, task.agent);
    const row = ctx.db.taskData.insert({ id: 0, requestId: request.id, ...task, status: held ? 'waiting_review' : 'assigned',
      note: '', createdAt: now(ctx), updatedAt: now(ctx) });
    if (!held) note(ctx, task.agent, 'task', row.id, `[cowork] Task #${row.id} from the orchestrator: ${task.title}`);
  }
  updateRequest(ctx, request, { summary, plan: JSON.stringify(plan),
    status: held ? 'waiting_review' : plan.tasks.length ? 'assigned' : 'done' });
  if (!held) for (const conflict of plan.conflicts) openPotential(ctx, request.id, conflict);
  const waiting = held ? ` Waiting for review by ${plan.reviews.map(review => review.reviewer).join(', ')}.` : '';
  note(ctx, request.agent, 'info', 0, `[cowork] The orchestrator planned your request #${request.id}: ${cut(summary, 1000)}${waiting}`);
});
export const fail_request = spacetimedb.reducer({ requestId: t.u32().name("requestId"), reason: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const row = getRequest(ctx, args.requestId);
  if (row.status !== 'new' && row.status !== 'planning') return;
  const reason = cut(args.reason.trim() || 'No plan came out.', 1024);
  updateRequest(ctx, row, { status: 'failed', summary: reason });
  note(ctx, row.agent, 'info', 0, `[cowork] The orchestrator couldn't plan your request #${row.id}: ${reason}`);
});
export const decide_review = spacetimedb.reducer({ reviewId: t.u32().name("reviewId"), approve: t.bool(), answer: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const review = ctx.db.reviewData.id.find(args.reviewId);
  if (!review) throw new SenderError(`Unknown review #${args.reviewId}`);
  if (review.status !== 'pending') throw new SenderError(`Review #${review.id} is already ${review.status}`);
  const request = getRequest(ctx, review.requestId);
  const answer = cut(args.answer.trim(), 500);
  const said = answer ? ` (${answer})` : '';
  ctx.db.reviewData.id.update({ ...review, status: args.approve ? 'approved' : 'rejected', answer, decidedAt: now(ctx) });
  if (args.approve) {
    note(ctx, request.agent, 'info', 0, `[cowork] ${review.reviewer}'s human approved your request #${request.id}${said}.`);
    const pending = [...ctx.db.reviewData.requestId.filter(request.id)].some(row => row.status === 'pending');
    if (!pending && request.status === 'waiting_review') releasePlan(ctx, request);
    return;
  }
  for (const row of [...ctx.db.reviewData.requestId.filter(request.id)]) if (row.status === 'pending') {
    ctx.db.reviewData.id.update({ ...row, status: 'cancelled', decidedAt: now(ctx) });
  }
  for (const row of [...ctx.db.taskData.requestId.filter(request.id)]) if (row.status === 'waiting_review') {
    ctx.db.taskData.id.update({ ...row, status: 'cancelled', note: `Sent back by ${review.reviewer}'s human${said}`, updatedAt: now(ctx) });
  }
  updateRequest(ctx, request, { status: 'rejected' });
  note(ctx, request.agent, 'info', 0, `[cowork] ${review.reviewer}'s human sent your request #${request.id} back${said}. Nothing was assigned. Tell your human; they can ask again with a changed request.`);
});
export const complete_task = spacetimedb.reducer({ taskId: t.u32().name("taskId"), agent: t.string(), summary: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  name(args.agent);
  const row = ctx.db.taskData.id.find(args.taskId);
  if (!row) throw new SenderError(`Unknown task #${args.taskId}`);
  if (row.agent !== args.agent) throw new SenderError(`Task #${row.id} belongs to ${row.agent}`);
  if (row.status !== 'assigned') throw new SenderError(`Task #${row.id} is ${row.status}, not assigned`);
  // Tests decide: an agent that changed anything needs a current green check that includes it.
  if (latestSnapshotId(ctx, args.agent) > 0 && ![...ctx.db.checkRunData.iter()].some(run =>
    run.result === 'green' && run.agents.includes(args.agent) && currentRun(ctx, run))) {
    throw new SenderError('No current green check includes your latest snapshot. Run check_with_team, then try again.');
  }
  const summary = cut(args.summary.trim(), 2 * 1024);
  ctx.db.taskData.id.update({ ...row, status: 'done', note: summary, updatedAt: now(ctx) });
  const request = findRequest(ctx, row.requestId);
  if (!request) return;
  if (request.agent !== args.agent) note(ctx, request.agent, 'info', 0, `[cowork] ${args.agent} finished task #${row.id} of your request #${request.id}: ${cut(summary, 300)}`);
  const left = [...ctx.db.taskData.requestId.filter(request.id)].some(task => task.status === 'assigned' || task.status === 'waiting_review');
  if (!left && request.status === 'assigned') {
    updateRequest(ctx, request, { status: 'done' });
    note(ctx, request.agent, 'info', 0, `[cowork] Every task of your request #${request.id} is done.`);
  }
});
export const post_message = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), agent: t.string(), kind: t.string(),
  body: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  name(args.agent);
  oneOf(args.kind, ['message', 'agree', 'escalate']);
  const row = getConflict(ctx, args.conflictId);
  if (row.agentA !== args.agent && row.agentB !== args.agent) throw new SenderError(`${args.agent} isn't part of conflict #${row.id}`);
  if (!row.agentB) throw new SenderError(`Conflict #${row.id} involves only you; fix it and run check_with_team`);
  if (row.status !== 'open') {
    throw new SenderError(row.status === 'escalated' ? `Conflict #${row.id} is with both humans now; wait for their decision`
      : `Conflict #${row.id} is ${row.status === 'needs_human' ? 'waiting for a person (a fix changed tests)' : 'already resolved'}`);
  }
  const body = args.body.trim();
  if (!body) throw new SenderError('The message is empty');
  post(ctx, row.id, args.agent, args.kind, body);
  if (args.kind === 'escalate') {
    escalateToHumans(ctx, row, args.agent, `${args.agent} asked for a decision: ${cut(body, 300)}`);
    return;
  }
  const agreed = args.kind === 'agree' && bothAgreed(ctx, row);
  if (agreed && pairGreen(ctx, row)) {
    finishResolution(ctx, row, body);
    return;
  }
  const verb = args.kind === 'agree' ? 'agrees' : 'says';
  note(ctx, otherSide(row, args.agent), 'message', row.id, `[cowork] ${args.agent} ${verb} in conflict #${row.id}: ${cut(body, 1000)}`);
  if (agreed) for (const agent of participants(row)) {
    note(ctx, agent, 'info', row.id, `[cowork] You both agree on conflict #${row.id}, but no current green check covers both of you. Run check_with_team after your last edit, then agree again.`);
  }
  const spoken = sinceDecision(ctx, row.id).filter(m => participants(row).includes(m.author) && (m.kind === 'message' || m.kind === 'agree'));
  if (spoken.length >= MAX_MESSAGES) {
    escalateToHumans(ctx, ctx.db.conflictData.id.find(row.id)!, ORCHESTRATOR, `${MAX_MESSAGES} messages without agreement.`);
  }
});
export const decide_conflict = spacetimedb.reducer({ conflictId: t.u32().name("conflictId"), decision: t.string() }, (ctx, args) => {
  requireEditor(ctx);
  const row = getConflict(ctx, args.conflictId);
  if (row.status !== 'escalated' && row.status !== 'open') throw new SenderError(`Conflict #${row.id} is ${row.status}; only an open or escalated conflict takes a decision`);
  const decision = args.decision.trim();
  if (!decision) throw new SenderError('Write the decision first');
  ctx.db.conflictData.id.update({ ...row, status: 'open' });
  clearTimers(ctx, row.id);
  retireThreadWakeups(ctx, row.id);
  post(ctx, row.id, HUMAN, 'decision', decision);
  for (const agent of participants(row)) {
    note(ctx, agent, 'message', row.id, `[cowork] Your humans decided conflict #${row.id}: ${cut(decision, 1000)}`);
  }
});
