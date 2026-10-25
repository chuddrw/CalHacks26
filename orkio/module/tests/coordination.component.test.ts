/**
 * WHAT IT'S FOR: Part C state-machine component tests, independent of hooks, watcher orchestration
 * and UI. Exercises the real SpacetimeDB datastore; only its missing env fixture is supplied.
 */
import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import db, * as module from '../src/index';
import { seedRedConflict, resolveAfterGreen } from './state-fixture';

type Ctx = Parameters<typeof module.post_snapshot>[0];
const pair = {
  kind: 'pair', agentA: 'a', agentB: 'b', locA: 'src/user.ts:4', locB: 'src/idle.ts:8',
  error: 'expected elapsed minutes, received milliseconds', fixer: 'b', runKey: 'a1+b1',
};
function caller(subject: string, connection: bigint) {
  return TestAuth.fromJwtPayload(JSON.stringify({ iss: 'cowork-state-components', sub: subject }), new ConnectionId(connection));
}
function setup() {
  const h = createModuleTestHarness(db, module);
  h.clock.set(new Timestamp(1_700_000_000_123_000n));
  const owner = caller('owner', 1n);
  const editor = caller('editor', 2n);
  const otherEditor = caller('other-editor', 3n);
  const reader = caller('reader', 4n);
  const identity = (who: TestAuth) => h.viewContext(who).sender;
  const ownerHex = identity(owner).toHexString();
  const env = { ACCESS_OWNER_IDENTITY: ownerHex, get: (() => ownerHex) as Ctx['env']['get'] };
  const tx = <T>(who: TestAuth, body: (ctx: Ctx) => T) => h.withReducerTx(who, ctx => body({
    ...ctx, databaseIdentity: ctx.databaseIdentity, identity: ctx.identity, senderAuth: ctx.senderAuth, env,
  }));
  const view = (who: TestAuth) => ({ ...h.viewContext(who), env });
  tx(owner, ctx => {
    module.grant_access(ctx, { identity: identity(editor).toHexString(), role: 'editor' });
    module.grant_access(ctx, { identity: identity(otherEditor).toHexString(), role: 'editor' });
    module.grant_access(ctx, { identity: identity(reader).toHexString(), role: 'reader' });
  });
  const open = (args = pair) => {
    tx(editor, ctx => seedRedConflict(ctx, args));
    return [...h.db.conflictData.iter()].find(row => row.runKey === args.runKey)!;
  };
  return { h, owner, editor, otherEditor, reader, identity, tx, view, open };
}

describe('intent, inbox and diagnosis state components', () => {
  it('posts an unverified intent and notifies each other known agent exactly once', () => {
    const s = setup();
    s.tx(s.editor, ctx => {
      for (const agent of ['a', 'b', 'c']) module.post_snapshot(ctx, { agent, sha: `${agent}1`, baseSha: 'base', files: [], diff: '' });
      module.post_intent(ctx, { agent: 'a', summary: 'Use millisecond login times', files: ['src/user.ts'], symbols: ['User.lastLogin'] });
    });
    expect([...s.h.db.intentData.iter()]).toMatchObject([{
      agent: 'a', verified: false, summary: 'Use millisecond login times', files: ['src/user.ts'], symbols: ['User.lastLogin'],
    }]);
    expect(s.h.db.agentData.name.find('a')?.intent).toBe('Use millisecond login times');
    const notes = [...s.h.db.inboxData.iter()];
    expect(notes.map(row => [row.agent, row.kind, row.conflictId, row.delivered])).toEqual([
      ['b', 'heads_up', 0, false], ['c', 'heads_up', 0, false],
    ]);
    expect(notes.every(row => row.message.includes('a plans: Use millisecond login times'))).toBe(true);
  });

  it('keeps a pending diagnosis on the conflict and sends a note only after the fixer has received it', () => {
    const s = setup();
    const conflict = s.open();
    const wakeup = [...s.h.db.inboxData.iter()].find(row => row.kind === 'conflict')!;
    s.tx(s.editor, ctx => module.set_explanation(ctx, { conflictId: conflict.id, explanation: 'First explanation' }));
    expect(s.h.db.inboxData.count()).toBe(2n);
    expect(s.h.db.conflictData.id.find(conflict.id)?.explanation).toBe('First explanation');
    s.tx(s.editor, ctx => {
      module.mark_delivered(ctx, { inboxIds: [wakeup.id, wakeup.id, 999_999] });
      module.set_explanation(ctx, { conflictId: conflict.id, explanation: 'Updated diagnosis' });
      module.set_explanation(ctx, { conflictId: conflict.id, explanation: 'Updated diagnosis' });
    });
    const followups = [...s.h.db.inboxData.iter()].filter(row => row.id !== wakeup.id && row.agent === 'b');
    expect(followups).toMatchObject([{ kind: 'info', conflictId: conflict.id, delivered: false }]);
    expect(followups[0]!.message).toContain('Updated diagnosis');
    expect(s.h.db.inboxData.id.find(wakeup.id)?.delivered).toBe(true);
  });

  it('rejects unknown conflict diagnosis/transition calls without adding orphan rows', () => {
    const s = setup();
    const calls = [
      (ctx: Ctx) => module.add_diagnosis_step(ctx, { conflictId: 99, source: 'droid', kind: 'status', detail: 'orphan' }),
      (ctx: Ctx) => module.set_explanation(ctx, { conflictId: 99, explanation: 'orphan' }),
      (ctx: Ctx) => resolveAfterGreen(ctx, { conflictId: 99, verifiedFact: 'orphan' }),
      (ctx: Ctx) => module.flag_needs_human(ctx, { conflictId: 99, reason: 'orphan' }),
    ];
    for (const call of calls) expect(() => s.tx(s.editor, call)).toThrow('Unknown conflict #99');
    expect(s.h.db.agentData.count()).toBe(0n);
    expect(s.h.db.diagnosisStepData.count()).toBe(0n);
    expect(s.h.db.intentData.count()).toBe(0n);
    expect(s.h.db.inboxData.count()).toBe(0n);
  });

  it('a retired old wakeup does not count as delivery of the current retry diagnosis', () => {
    const s = setup(); const conflict = s.open();
    s.tx(s.editor, ctx => seedRedConflict(ctx, { ...pair, error: 'new error', runKey: 'a2+b1' }));
    const before = [...s.h.db.inboxData.iter()];
    const newestWakeup = before.filter(row => row.kind === 'conflict').at(-1)!;
    expect(newestWakeup.delivered).toBe(false);
    s.tx(s.editor, ctx => module.set_explanation(ctx, { conflictId: conflict.id, explanation: 'current retry diagnosis' }));
    // The pending message will read the current conflict at delivery; it needs no duplicate note.
    expect([...s.h.db.inboxData.iter()]).toEqual(before);
    expect(s.h.db.conflictData.id.find(conflict.id)?.explanation).toBe('current retry diagnosis');
  });

  it.each([
    { source: 'other', kind: 'status' }, { source: 'droid', kind: 'completion' },
  ])('rejects unsupported diagnosis metadata $source/$kind atomically', args => {
    const s = setup(); const conflict = s.open();
    expect(() => s.tx(s.editor, ctx => module.add_diagnosis_step(ctx, { conflictId: conflict.id, ...args, detail: 'invalid' }))).toThrow('Invalid value');
    expect(s.h.db.diagnosisStepData.count()).toBe(0n);
    expect(s.h.db.conflictData.id.find(conflict.id)).toEqual(conflict);
  });
});

describe('conflict state boundaries', () => {
  it('a self conflict wakes only its author and whitespace facts create no shared memory', () => {
    const s = setup();
    const conflict = s.open({ ...pair, kind: 'self', agentB: '', fixer: 'a', locB: '', runKey: 'a1' });
    expect(conflict).toMatchObject({ pair: 'a', kind: 'self', agentB: '', fixer: 'a' });
    expect([...s.h.db.inboxData.iter()]).toMatchObject([{ agent: 'a', kind: 'conflict' }]);
    expect(s.h.db.agentData.count()).toBe(1n);
    s.tx(s.editor, ctx => resolveAfterGreen(ctx, { conflictId: conflict.id, verifiedFact: ' \n ' }));
    expect(s.h.db.intentData.count()).toBe(0n);
    expect([...s.h.db.inboxData.iter()].some(row => row.kind === 'fact')).toBe(false);
    expect(s.h.db.agentData.name.find('a')?.status).toBe('green');
  });

  it.each([
    { label: 'unknown kind', args: { ...pair, kind: 'suspected' } },
    { label: 'self with two agents', args: { ...pair, kind: 'self' } },
    { label: 'pair without other agent', args: { ...pair, agentB: '' } },
    { label: 'merge without other agent', args: { ...pair, kind: 'merge', agentB: '' } },
    { label: 'duplicate agent', args: { ...pair, agentB: 'a' } },
    { label: 'outsider fixer', args: { ...pair, fixer: 'c' } },
    { label: 'invalid first name', args: { ...pair, agentA: 'A' } },
    { label: 'invalid second name', args: { ...pair, agentB: '../b' } },
  ])('rejects $label before leaving partial coordination state', ({ args }) => {
    const s = setup();
    expect(() => s.tx(s.editor, ctx => module.report_conflict(ctx, args))).toThrow();
    for (const table of [s.h.db.agentData, s.h.db.conflictData, s.h.db.inboxData, s.h.db.escalation_timer]) expect(table.count()).toBe(0n);
  });

  it('reversed pair order deduplicates and changed errors retire pending wakeups without another timer', () => {
    const s = setup(); const conflict = s.open();
    s.tx(s.editor, ctx => module.set_explanation(ctx, { conflictId: conflict.id, explanation: 'old error advice' }));
    s.tx(s.editor, ctx => seedRedConflict(ctx, {
      ...pair, agentA: 'b', agentB: 'a', locA: pair.locB, locB: pair.locA,
      error: 'new error after attempted fix', runKey: 'a2+b1',
    }));
    expect(s.h.db.conflictData.count()).toBe(1n);
    expect(s.h.db.escalation_timer.count()).toBe(1n);
    expect(s.h.db.conflictData.id.find(conflict.id)).toMatchObject({
      pair: 'a+b', agentA: 'b', agentB: 'a', locA: pair.locB, locB: pair.locA,
      error: 'new error after attempted fix', explanation: '', runKey: 'a2+b1', createdAt: conflict.createdAt,
    });
    const waiting = [...s.h.db.inboxData.iter()].filter(row => row.kind === 'conflict' && !row.delivered);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.message).toContain('Still red');
    expect(waiting[0]!.agent).toBe('b');
  });

  it('resolving an escalated conflict creates one new conflict when the same pair breaks again', () => {
    const s = setup(); const first = s.open();
    const timer = [...s.h.db.escalation_timer.iter()][0]!;
    s.tx(TestAuth.internal(), ctx => module.escalate(ctx, { arg: timer }));
    expect(s.h.db.conflictData.id.find(first.id)?.status).toBe('escalated');
    s.tx(s.editor, ctx => resolveAfterGreen(ctx, { conflictId: first.id, verifiedFact: '' }));
    const second = s.open({ ...pair, runKey: 'a2+b2' });
    expect(second.id).not.toBe(first.id);
    expect(s.h.db.conflictData.id.find(first.id)?.status).toBe('resolved');
    expect(second.status).toBe('open');
    expect(s.h.db.escalation_timer.count()).toBe(1n);
    const secondBefore = s.h.db.conflictData.id.find(second.id);
    s.tx(TestAuth.internal(), ctx => module.escalate(ctx, { arg: timer }));
    expect(s.h.db.conflictData.id.find(second.id)).toEqual(secondBefore);
  });

  it('human escalation and late timer delivery are idempotent and never publish a fact', () => {
    const s = setup(); const conflict = s.open();
    const timer = [...s.h.db.escalation_timer.iter()][0]!;
    s.tx(s.editor, ctx => module.flag_needs_human(ctx, { conflictId: conflict.id, reason: 'tests weakened' }));
    const inboxBefore = [...s.h.db.inboxData.iter()];
    s.tx(s.editor, ctx => module.flag_needs_human(ctx, { conflictId: conflict.id, reason: 'repeat' }));
    s.tx(TestAuth.internal(), ctx => module.escalate(ctx, { arg: timer }));
    s.tx(s.editor, ctx => resolveAfterGreen(ctx, { conflictId: conflict.id, verifiedFact: 'unverified claim' }));
    expect(s.h.db.conflictData.id.find(conflict.id)?.status).toBe('needs_human');
    expect([...s.h.db.inboxData.iter()]).toEqual(inboxBefore);
    expect(s.h.db.intentData.count()).toBe(0n);
  });
});

describe('display byte boundaries', () => {
  it.each([
    { field: 'snapshot diff', limit: 50 * 1024 }, { field: 'check log', limit: 20 * 1024 },
    { field: 'conflict error', limit: 4 * 1024 }, { field: 'diagnosis detail', limit: 2 * 1024 },
  ])('$field preserves a complete Unicode prefix within its $limit-byte boundary', ({ field, limit }) => {
    const s = setup();
    // A 4-byte astral character fits; the next three-byte character must be omitted in full.
    const prefix = 'x'.repeat(limit - 5) + '😀';
    const input = prefix + '界' + 'trailing ASCII';
    let output = '';
    if (field === 'snapshot diff') {
      s.tx(s.editor, ctx => module.post_snapshot(ctx, { agent: 'a', sha: 'a1', baseSha: 'base', files: [], diff: input }));
      output = [...s.h.db.snapshotData.iter()][0]!.diff;
    } else if (field === 'check log') {
      s.tx(s.editor, ctx => module.report_check(ctx, { runKey: 'a1', agents: ['a'], result: 'red', log: input }));
      output = s.h.db.checkRunData.runKey.find('a1')!.log;
    } else if (field === 'conflict error') {
      output = s.open({ ...pair, error: input }).error;
    } else {
      const conflict = s.open();
      s.tx(s.editor, ctx => module.add_diagnosis_step(ctx, { conflictId: conflict.id, source: 'claude', kind: 'final', detail: input }));
      output = [...s.h.db.diagnosisStepData.iter()][0]!.detail;
    }
    expect(output).toBe(prefix);
    expect(Buffer.byteLength(output, 'utf8')).toBe(limit - 1);
    expect(output.endsWith('😀')).toBe(true);
  });
});

describe('check, reset and multi-identity presence components', () => {
  it('upserts a run and updates only included agents, preserving a pending conflict as red', () => {
    const s = setup();
    s.tx(s.editor, ctx => {
      for (const agent of ['a', 'b', 'c']) module.post_snapshot(ctx, { agent, sha: `${agent}1`, baseSha: 'base', files: [], diff: '' });
      module.report_check(ctx, { runKey: pair.runKey, agents: ['a', 'b'], result: 'red', log: 'first failure' });
      seedRedConflict(ctx, pair);
    });
    s.h.clock.set(new Timestamp(1_700_000_005_123_000n));
    s.tx(s.editor, ctx => module.report_check(ctx, { runKey: pair.runKey, agents: ['a'], result: 'green', log: 'now green' }));
    expect(s.h.db.checkRunData.count()).toBe(1n);
    expect(s.h.db.checkRunData.runKey.find(pair.runKey)).toMatchObject({ agents: ['a'], result: 'green', log: 'now green', createdAt: 1_700_000_005_123 });
    expect(s.h.db.agentData.name.find('a')?.status).toBe('red');
    expect(s.h.db.agentData.name.find('b')?.status).toBe('red');
    expect(s.h.db.agentData.name.find('c')?.status).toBe('working');
    expect(() => s.tx(s.editor, ctx => module.report_check(ctx, { runKey: pair.runKey, agents: ['a'], result: 'suspected', log: '' }))).toThrow('Invalid value');
    expect(s.h.db.checkRunData.runKey.find(pair.runKey)?.log).toBe('now green');
  });

  it('post_snapshot updates only latest agent metadata and retains snapshot evidence and intent', () => {
    const s = setup();
    s.tx(s.editor, ctx => {
      module.register_agent(ctx, { agent: 'a' });
      module.post_intent(ctx, { agent: 'a', summary: 'retain this plan', files: ['old.ts'], symbols: [] });
      module.post_snapshot(ctx, { agent: 'a', sha: 'a1', baseSha: 'base', files: ['old.ts'], diff: 'old evidence' });
    });
    s.h.clock.set(new Timestamp(1_700_000_005_999_999n));
    s.tx(s.editor, ctx => module.post_snapshot(ctx, { agent: 'a', sha: 'a2', baseSha: 'base', files: ['new.ts'], diff: 'new evidence' }));
    expect([...s.h.db.snapshotData.iter()]).toMatchObject([{ sha: 'a1', diff: 'old evidence' }, { sha: 'a2', diff: 'new evidence' }]);
    expect(s.h.db.agentData.name.find('a')).toMatchObject({ online: true, status: 'working', intent: 'retain this plan', files: ['new.ts'], lastSnapshotAt: 1_700_000_005_999 });
  });

  it('revokes all sockets of one identity without dropping another identity sharing the agent name', () => {
    const s = setup();
    const sameIdentityOtherSocket = caller('editor', 20n);
    s.tx(s.editor, ctx => module.register_agent(ctx, { agent: 'a' }));
    s.tx(sameIdentityOtherSocket, ctx => module.register_agent(ctx, { agent: 'b' }));
    s.tx(s.otherEditor, ctx => module.register_agent(ctx, { agent: 'a' }));
    expect(s.h.db.agent_connection.count()).toBe(3n);
    s.tx(s.owner, ctx => module.revoke_access(ctx, { identity: s.identity(s.editor).toHexString() }));
    expect(s.h.db.agent_connection.count()).toBe(1n);
    expect(s.h.db.agentData.name.find('a')?.online).toBe(true);
    expect(s.h.db.agentData.name.find('b')?.online).toBe(false);
    s.tx(sameIdentityOtherSocket, ctx => module.client_disconnected(ctx, {}));
    expect(s.h.db.agentData.name.find('a')?.online).toBe(true);
    s.tx(s.otherEditor, ctx => module.client_disconnected(ctx, {}));
    expect(s.h.db.agentData.name.find('a')?.online).toBe(false);
  });

  it('reset is idempotent, cancels old coordination state and preserves membership for the next run', () => {
    const s = setup();
    const conflict = s.open();
    const staleTimer = [...s.h.db.escalation_timer.iter()][0]!;
    s.tx(s.editor, ctx => {
      module.register_agent(ctx, { agent: 'a' });
      module.add_diagnosis_step(ctx, { conflictId: conflict.id, source: 'droid', kind: 'status', detail: 'started' });
      module.post_intent(ctx, { agent: 'a', summary: 'old plan', files: [], symbols: [] });
      module.report_check(ctx, { runKey: 'old', agents: ['a'], result: 'red', log: 'old failure' });
    });
    const memberships = [...s.h.db.accessMember.iter()];
    s.tx(s.owner, ctx => module.reset_all(ctx, {}));
    s.tx(s.owner, ctx => module.reset_all(ctx, {}));
    s.tx(TestAuth.internal(), ctx => module.escalate(ctx, { arg: staleTimer }));
    for (const table of [s.h.db.agentData, s.h.db.snapshotData, s.h.db.intentData, s.h.db.checkRunData, s.h.db.conflictData,
      s.h.db.inboxData, s.h.db.diagnosisStepData, s.h.db.agent_connection, s.h.db.escalation_timer]) expect(table.count()).toBe(0n);
    expect([...s.h.db.accessMember.iter()]).toEqual(memberships);
    s.tx(s.editor, ctx => module.post_snapshot(ctx, { agent: 'a', sha: 'next-run', baseSha: 'base', files: [], diff: '' }));
    expect(s.h.runQuery(module.snapshot(s.view(s.reader)))).toMatchObject([{ sha: 'next-run' }]);
  });
});
