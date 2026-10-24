/** WHAT IT'S FOR: transactional, lifecycle and frozen-interface regression tests for Part C. */
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ConnectionId, ScheduleAt, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import { CaseConversionPolicy } from 'spacetimedb/server';
import { Columns } from '../../shared/src/schema.ts';
import db, * as reducers from '../src/index';
import { seedRedConflict, resolveAfterGreen } from './state-fixture';

function auth(connection = 1n) {
  return TestAuth.fromJwtPayload(JSON.stringify({ iss: 'cowork-test', sub: 'same-user' }), new ConnectionId(connection));
}
function harness() {
  const h = createModuleTestHarness(db, reducers);
  h.clock.set(new Timestamp(1_700_000_000_123_000n));
  // SDK 2.13's portable harness does not inject declared environment values yet.
  // Override only env while retaining its real transaction, identity and JWT contexts.
  const owner = h.viewContext(auth()).sender.toHexString();
  const transaction = h.withReducerTx.bind(h);
  h.withReducerTx = (who, body) => transaction(who, ctx => body({
    ...ctx, identity: ctx.identity, databaseIdentity: ctx.databaseIdentity, senderAuth: ctx.senderAuth,
    env: { ACCESS_OWNER_IDENTITY: owner, get: (() => owner) as typeof ctx.env.get },
  }));
  return h;
}
const backing = { agent: 'agentData', snapshot: 'snapshotData', intent: 'intentData', check_run: 'checkRunData', conflict: 'conflictData', inbox: 'inboxData', diagnosis_step: 'diagnosisStepData' } as const;
const args = {
  kind: 'pair', agentA: 'a', agentB: 'b', locA: 'src/user.ts:1', locB: 'src/idle.ts:2',
  error: 'seconds versus milliseconds', fixer: 'b', runKey: 'a1+b1',
};

it('preserves all public column and reducer parameter orders', () => {
  harness(); // Describe/register module exports before inspecting function definitions.
  expect(db.moduleDef.caseConversionPolicy).toEqual(CaseConversionPolicy.None);
  for (const [tableName, columns] of Object.entries(Columns)) {
    const table = db.schemaType.tables[backing[tableName as keyof typeof Columns]];
    const row = db.typespace.types[table.tableDef.productTypeRef]!;
    expect(row.tag).toBe('Product');
    if (row.tag === 'Product') expect(row.value.elements.map(e => e.name)).toEqual(columns);
    expect(table.tableDef.tableAccess.tag).toBe('Private');
    const view = db.moduleDef.views.find(v => v.sourceName === tableName);
    expect(view, `${tableName} remains an authenticated public view`).toMatchObject({ isPublic: true, isAnonymous: false });
  }
  const expected = {
    register_agent: ['agent'], post_snapshot: ['agent', 'sha', 'baseSha', 'files', 'diff'],
    post_intent: ['agent', 'summary', 'files', 'symbols'], report_check: ['runKey', 'agents', 'result', 'log'],
    report_conflict: ['kind', 'agentA', 'agentB', 'locA', 'locB', 'error', 'fixer', 'runKey'],
    add_diagnosis_step: ['conflictId', 'source', 'kind', 'detail'], set_explanation: ['conflictId', 'explanation'],
    resolve_conflict: ['conflictId', 'verifiedFact'], flag_needs_human: ['conflictId', 'reason'],
    send_note: ['agent', 'kind', 'message'], mark_delivered: ['inboxIds'], reset_all: [],
    grant_access: ['identity', 'role'], revoke_access: ['identity'],
    set_explanation_if_current: ['conflictId', 'expectedRunKey', 'expectedError', 'expectedFixer', 'explanation'],
    resolve_conflict_if_current: ['conflictId', 'expectedRunKey', 'expectedError', 'expectedFixer', 'verifiedRunKey', 'verifiedFact'],
    review_test_change: ['conflictId', 'approve', 'comment'],
  };
  for (const [name, parameters] of Object.entries(expected)) {
    const reducer = db.moduleDef.reducers.find(r => r.sourceName === name);
    expect(reducer?.params.elements.map(e => e.name)).toEqual(parameters);
  }
});

it('generated public bindings preserve actual wire names and numeric field types', () => {
  harness();
  for (const [tableName, columns] of Object.entries(Columns)) {
    const source = readFileSync(new URL(`../../shared/module_bindings/${tableName}_table.ts`, import.meta.url), 'utf8');
    const fields = [...source.matchAll(/^  (\w+): __t\.(\w+)\((.*)$/gm)];
    expect(fields.map(field => field[1]), `${tableName} generated field order`).toEqual(columns);
    const table = db.schemaType.tables[backing[tableName as keyof typeof Columns]];
    const row = db.typespace.types[table.tableDef.productTypeRef]!;
    if (row.tag !== 'Product') throw new Error(`${tableName} must have a product row type`);
    for (const [index, field] of fields.entries()) {
      const nameOverride = field[3]!.match(/\.name\("([^"]+)"\)/)?.[1];
      expect(nameOverride ?? field[1], `${tableName}.${field[1]} SQL name`).toBe(columns[index]);
      const type = row.value.elements[index]!.algebraicType.tag.toLowerCase();
      expect(field[2], `${tableName}.${field[1]} generated type`).toBe(type);
    }
  }
});

it('atomically creates a conflict, red agents, the right inboxes and one timer', () => {
  const h = harness();
  h.withReducerTx(auth(), ctx => seedRedConflict(ctx, args));
  const [conflict] = [...h.db.conflictData.iter()];
  expect(conflict).toMatchObject({ pair: 'a+b', fixer: 'b', status: 'open', createdAt: 1_700_000_000_123, resolvedAt: 0 });
  expect([...h.db.agentData.iter()].map(a => a.status)).toEqual(['red', 'red']);
  expect([...h.db.inboxData.iter()].map(m => [m.agent, m.kind, m.conflictId])).toEqual([['b', 'conflict', conflict!.id], ['a', 'info', conflict!.id]]);
  expect([...h.db.escalation_timer.iter()]).toHaveLength(1);
  h.withReducerTx(auth(), ctx => seedRedConflict(ctx, args));
  expect(h.db.conflictData.count()).toBe(1n);
  expect(h.db.inboxData.count()).toBe(2n);
  expect(h.db.escalation_timer.count()).toBe(1n);
});

it('rolls back conflict, agent, inbox and timer writes on transaction failure', () => {
  const h = harness();
  expect(() => h.withReducerTx(auth(), ctx => {
    seedRedConflict(ctx, args);
    seedRedConflict(ctx, { ...args, fixer: 'outsider' });
  })).toThrow('Fixer must belong');
  for (const table of [h.db.conflictData, h.db.agentData, h.db.inboxData, h.db.escalation_timer]) expect(table.count()).toBe(0n);
});

it('reassigns the fixer with unchanged error and retires the old wakeup', () => {
  const h = harness();
  h.withReducerTx(auth(), ctx => seedRedConflict(ctx, args));
  const id = [...h.db.conflictData.iter()][0]!.id;
  h.withReducerTx(auth(), ctx => reducers.set_explanation(ctx, { conflictId: id, explanation: 'Advice for b' }));
  h.withReducerTx(auth(), ctx => seedRedConflict(ctx, { ...args, fixer: 'a' }));
  expect(h.db.conflictData.id.find(id)?.explanation).toBe('');
  const wakeups = [...h.db.inboxData.iter()].filter(m => m.kind === 'conflict' && !m.delivered);
  expect(wakeups).toHaveLength(1);
  expect(wakeups[0]!.agent).toBe('a');
  expect(h.db.conflictData.count()).toBe(1n);
  expect(h.db.escalation_timer.count()).toBe(1n);
});

it('publishes a verified fact once, only on resolution, and clears pending wakeups/timers', () => {
  const h = harness();
  h.withReducerTx(auth(), ctx => {
    seedRedConflict(ctx, args);
    reducers.post_snapshot(ctx, { agent: 'c', sha: 'c1', baseSha: 'base', files: [], diff: '' });
  });
  const id = [...h.db.conflictData.iter()][0]!.id;
  h.withReducerTx(auth(), ctx => reducers.set_explanation(ctx, { conflictId: id, explanation: 'lastLogin uses milliseconds' }));
  expect(h.db.intentData.count()).toBe(0n);
  h.withReducerTx(auth(), ctx => resolveAfterGreen(ctx, { conflictId: id, verifiedFact: 'lastLogin uses milliseconds' }));
  h.withReducerTx(auth(), ctx => resolveAfterGreen(ctx, { conflictId: id, verifiedFact: 'duplicate' }));
  expect([...h.db.intentData.iter()]).toMatchObject([{ agent: 'watcher', verified: true, summary: 'lastLogin uses milliseconds' }]);
  expect([...h.db.inboxData.iter()].filter(m => m.kind === 'fact').map(m => m.agent).sort()).toEqual(['a', 'b', 'c']);
  expect([...h.db.inboxData.iter()].filter(m => m.kind === 'conflict' && !m.delivered)).toHaveLength(0);
  expect(h.db.escalation_timer.count()).toBe(0n);
  expect(h.db.conflictData.id.find(id)?.resolvedAt).toBe(1_700_000_000_123);
  expect(h.db.agentData.name.find('a')?.status).toBe('green');
});

it('keeps needs_human red and deduplicated through snapshots, green checks and repeat reports', () => {
  const h = harness();
  h.withReducerTx(auth(), ctx => seedRedConflict(ctx, args));
  const id = [...h.db.conflictData.iter()][0]!.id;
  h.withReducerTx(auth(), ctx => {
    reducers.flag_needs_human(ctx, { conflictId: id, reason: 'test deleted' });
    reducers.post_snapshot(ctx, { agent: 'a', sha: 'a2', baseSha: 'base', files: [], diff: '' });
    reducers.report_check(ctx, { runKey: 'a2+b1', agents: ['a', 'b'], result: 'green', log: '' });
    resolveAfterGreen(ctx, { conflictId: id, verifiedFact: 'must not publish' });
    seedRedConflict(ctx, { ...args, error: 'new error', fixer: 'a', runKey: 'a2+b1' });
  });
  expect(h.db.conflictData.count()).toBe(1n);
  expect(h.db.conflictData.id.find(id)?.status).toBe('needs_human');
  expect([...h.db.agentData.iter()].map(a => a.status)).toEqual(['red', 'red']);
  expect(h.db.intentData.count()).toBe(0n);
  expect([...h.db.inboxData.iter()].filter(m => m.kind === 'conflict' && !m.delivered)).toHaveLength(0);
});

it('tracks multiple connections with one identity and handles reassignment/disconnect', () => {
  const h = harness();
  h.withReducerTx(auth(1n), ctx => reducers.register_agent(ctx, { agent: 'a' }));
  h.withReducerTx(auth(2n), ctx => reducers.register_agent(ctx, { agent: 'a' }));
  h.withReducerTx(auth(1n), ctx => reducers.client_disconnected(ctx, {}));
  expect(h.db.agentData.name.find('a')?.online).toBe(true);
  h.withReducerTx(auth(2n), ctx => reducers.register_agent(ctx, { agent: 'b' }));
  expect(h.db.agentData.name.find('a')?.online).toBe(false);
  expect(h.db.agentData.name.find('b')?.online).toBe(true);
  h.withReducerTx(auth(2n), ctx => reducers.client_disconnected(ctx, {}));
  expect(h.db.agentData.name.find('b')?.online).toBe(false);
  expect(h.db.agent_connection.count()).toBe(0n);
});

it('schedules escalation for five minutes and rejects external scheduled calls', () => {
  const h = harness();
  h.withReducerTx(auth(), ctx => seedRedConflict(ctx, args));
  const timer = [...h.db.escalation_timer.iter()][0]!;
  expect(timer.scheduledAt).toEqual(ScheduleAt.time(1_700_000_300_123_000n));
  expect(() => h.withReducerTx(auth(), ctx => reducers.escalate(ctx, { arg: timer }))).toThrow('Scheduled calls only');
  expect(h.db.conflictData.id.find(timer.conflictId)?.status).toBe('open');
  h.clock.set(new Timestamp(1_700_000_300_123_000n));
  h.withReducerTx(TestAuth.internal(), ctx => reducers.escalate(ctx, { arg: timer }));
  expect(h.db.conflictData.id.find(timer.conflictId)?.status).toBe('escalated');
});

it('keeps an agent red when resolving only one of its outstanding conflicts', () => {
  const h = harness();
  h.withReducerTx(auth(), ctx => {
    seedRedConflict(ctx, args);
    seedRedConflict(ctx, { ...args, agentB: 'c', fixer: 'a', runKey: 'a1+c1' });
  });
  const id = [...h.db.conflictData.iter()].find(c => c.pair === 'a+b')!.id;
  h.withReducerTx(auth(), ctx => resolveAfterGreen(ctx, { conflictId: id, verifiedFact: '' }));
  expect(h.db.agentData.name.find('a')?.status).toBe('red');
  expect(h.db.agentData.name.find('b')?.status).toBe('green');
});
