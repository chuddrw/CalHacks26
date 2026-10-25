/** WHAT IT'S FOR: reordered-result and atomic revision-guard regressions for Part C's reducers. */
import { expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import db, * as module from '../src/index';
import { seedRedConflict, reportCurrentGreen } from './state-fixture';

type Ctx = Parameters<typeof module.report_check>[0];
const pair = { kind: 'pair', agentA: 'a', agentB: 'b', locA: 'a.ts:1', locB: 'b.ts:1', error: 'old error', fixer: 'b', runKey: 'a1+b1' };
function setup() {
  const h = createModuleTestHarness(db, module);
  const owner = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'cowork-revision-test', sub: 'owner' }), new ConnectionId(1n));
  const reader = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'cowork-revision-test', sub: 'reader' }), new ConnectionId(2n));
  const identity = (who: TestAuth) => h.viewContext(who).sender;
  const ownerHex = identity(owner).toHexString();
  const env = { ACCESS_OWNER_IDENTITY: ownerHex, get: (() => ownerHex) as Ctx['env']['get'] };
  const tx = <T>(body: (ctx: Ctx) => T, who = owner) => h.withReducerTx(who, ctx => body({
    ...ctx, identity: ctx.identity, databaseIdentity: ctx.databaseIdentity, senderAuth: ctx.senderAuth, env,
  }));
  h.clock.set(new Timestamp(1_700_000_000_000_000n));
  tx(ctx => module.grant_access(ctx, { identity: identity(reader).toHexString(), role: 'reader' }));
  const snapshot = (agent: string, sha: string) => tx(ctx => module.post_snapshot(ctx, { agent, sha, baseSha: 'base', files: [`${agent}.ts`], diff: '' }));
  const open = (args = pair) => {
    tx(ctx => seedRedConflict(ctx, args));
    return [...h.db.conflictData.iter()].find(row => row.runKey === args.runKey)!;
  };
  return { h, tx, snapshot, open, owner, reader };
}
function version(conflict: { id: number; runKey: string; error: string; fixer: string }) {
  return { conflictId: conflict.id, expectedRunKey: conflict.runKey, expectedError: conflict.error, expectedFixer: conflict.fixer };
}

it('stores late green history without painting a newer snapshot green, even within the same millisecond', () => {
  const s = setup(); s.snapshot('a', 'a1'); s.snapshot('a', 'a2');
  s.tx(ctx => module.report_check(ctx, { runKey: 'a1', agents: ['a'], result: 'green', log: 'old result' }));
  expect(s.h.db.checkRunData.runKey.find('a1')?.result).toBe('green');
  expect(s.h.db.agentData.name.find('a')?.status).toBe('working');
  s.tx(ctx => module.report_check(ctx, { runKey: 'a2', agents: ['a'], result: 'green', log: 'fresh result' }));
  expect(s.h.db.agentData.name.find('a')?.status).toBe('green');
});

it.each([
  { runKey: '', agents: [] }, { runKey: 'a1+a1', agents: ['a', 'a'] }, { runKey: 'a1+b1', agents: ['a', 'b'] },
])('incomplete or ambiguous current-run evidence never paints agents green ($runKey)', run => {
  const s = setup(); s.snapshot('a', 'a1');
  s.tx(ctx => module.report_check(ctx, { ...run, result: 'green', log: '' }));
  expect(s.h.db.agentData.name.find('a')?.status).toBe('working');
  expect(s.h.db.agentData.name.find('b')).toBeNull();
});

it('late red localization cannot create a conflict after a newer green run', () => {
  const s = setup(); s.snapshot('a', 'a1'); s.snapshot('b', 'b1');
  s.tx(ctx => module.report_check(ctx, { runKey: pair.runKey, agents: ['a', 'b'], result: 'red', log: 'old failure' }));
  s.snapshot('a', 'a2');
  s.tx(ctx => module.report_check(ctx, { runKey: 'a2+b1', agents: ['a', 'b'], result: 'green', log: 'fixed' }));
  s.tx(ctx => module.report_conflict(ctx, pair));
  expect(s.h.db.conflictData.count()).toBe(0n);
  expect(s.h.db.inboxData.count()).toBe(0n);
  expect(s.h.db.escalation_timer.count()).toBe(0n);
  expect([...s.h.db.agentData.iter()].map(row => row.status)).toEqual(['green', 'green']);
});

it('late red localization cannot replace newer conflict evidence or send another wakeup', () => {
  const s = setup(); const old = s.open();
  const current = s.open({ ...pair, runKey: 'a2+b1', error: 'current error', fixer: 'a' });
  const messages = [...s.h.db.inboxData.iter()];
  s.tx(ctx => module.report_conflict(ctx, pair));
  expect(s.h.db.conflictData.id.find(old.id)).toEqual(current);
  expect([...s.h.db.inboxData.iter()]).toEqual(messages);
  expect(s.h.db.escalation_timer.count()).toBe(1n);
});

it('requires a reported red run that covers both participants before creating a conflict', () => {
  const s = setup(); s.snapshot('a', 'a1'); s.snapshot('b', 'b1'); s.snapshot('c', 'c1');
  expect(() => s.tx(ctx => module.report_conflict(ctx, pair))).toThrow('red check covering');
  s.tx(ctx => module.report_check(ctx, { runKey: pair.runKey, agents: ['a', 'b'], result: 'green', log: '' }));
  expect(() => s.tx(ctx => module.report_conflict(ctx, pair))).toThrow('red check covering');
  s.tx(ctx => module.report_check(ctx, { runKey: 'c1', agents: ['c'], result: 'red', log: '' }));
  expect(() => s.tx(ctx => module.report_conflict(ctx, { ...pair, runKey: 'c1' }))).toThrow('red check covering');
  expect(s.h.db.conflictData.count()).toBe(0n);
  expect(s.h.db.inboxData.count()).toBe(0n);
});

it.each(['runKey', 'error', 'fixer'] as const)('atomic diagnosis guard rejects superseded %s after request transit', changed => {
  const s = setup(); const old = s.open();
  const update = changed === 'runKey' ? { ...pair, runKey: 'a2+b1' }
    : changed === 'error' ? { ...pair, error: 'new error' } : { ...pair, fixer: 'a' };
  const current = s.open(update);
  const before = [...s.h.db.inboxData.iter()];
  s.tx(ctx => module.set_explanation_if_current(ctx, { ...version(old), explanation: 'stale advice' }));
  expect(s.h.db.conflictData.id.find(old.id)?.explanation).toBe('');
  expect([...s.h.db.inboxData.iter()]).toEqual(before);
  s.tx(ctx => module.set_explanation_if_current(ctx, { ...version(current), explanation: 'fresh advice' }));
  expect(s.h.db.conflictData.id.find(old.id)?.explanation).toBe('fresh advice');
});

it('legacy resolution cannot resolve or publish facts without current covering green evidence', () => {
  const s = setup(); const conflict = s.open();
  s.tx(ctx => module.resolve_conflict(ctx, { conflictId: conflict.id, verifiedFact: 'not verified' }));
  expect(s.h.db.conflictData.id.find(conflict.id)?.status).toBe('open');
  expect(s.h.db.intentData.count()).toBe(0n);
  s.tx(ctx => module.report_check(ctx, { runKey: 'a1', agents: ['a'], result: 'green', log: '' }));
  s.tx(ctx => module.resolve_conflict(ctx, { conflictId: conflict.id, verifiedFact: 'only one side passed' }));
  expect(s.h.db.conflictData.id.find(conflict.id)?.status).toBe('open');
  s.tx(ctx => reportCurrentGreen(ctx, conflict.id));
  s.snapshot('a', 'a2');
  s.tx(ctx => module.resolve_conflict(ctx, { conflictId: conflict.id, verifiedFact: 'obsolete green' }));
  expect(s.h.db.conflictData.id.find(conflict.id)?.status).toBe('open');
  expect(s.h.db.intentData.count()).toBe(0n);
});

it('guarded resolution rejects superseded conflict versions even when a newer green check exists', () => {
  const s = setup(); const old = s.open();
  const current = s.open({ ...pair, runKey: 'a2+b1', error: 'new error', fixer: 'a' });
  const verifiedRunKey = s.tx(ctx => reportCurrentGreen(ctx, current.id));
  s.tx(ctx => module.resolve_conflict_if_current(ctx, { ...version(old), verifiedRunKey, verifiedFact: 'stale fact' }));
  expect(s.h.db.conflictData.id.find(current.id)?.status).toBe('open');
  expect(s.h.db.intentData.count()).toBe(0n);
  s.tx(ctx => module.resolve_conflict_if_current(ctx, { ...version(current), verifiedRunKey, verifiedFact: 'fresh verified fact' }));
  expect(s.h.db.conflictData.id.find(current.id)?.status).toBe('resolved');
  expect([...s.h.db.intentData.iter()]).toMatchObject([{ verified: true, summary: 'fresh verified fact' }]);
  expect(s.h.db.escalation_timer.count()).toBe(0n);
  s.tx(ctx => module.resolve_conflict_if_current(ctx, { ...version(current), verifiedRunKey, verifiedFact: 'duplicate' }));
  expect(s.h.db.intentData.count()).toBe(1n);
  const afterResolve = [...s.h.db.inboxData.iter()];
  s.tx(ctx => module.set_explanation_if_current(ctx, { ...version(current), explanation: 'late resolved advice' }));
  expect(s.h.db.conflictData.id.find(current.id)?.explanation).toBe('');
  expect([...s.h.db.inboxData.iter()]).toEqual(afterResolve);
});

it('guarded resolution requires its specified green run to cover both agents and remain current', () => {
  const s = setup(); const conflict = s.open();
  s.tx(ctx => module.report_check(ctx, { runKey: 'a1', agents: ['a'], result: 'green', log: '' }));
  for (const verifiedRunKey of ['missing', 'a1', pair.runKey]) {
    s.tx(ctx => module.resolve_conflict_if_current(ctx, { ...version(conflict), verifiedRunKey, verifiedFact: 'invalid fact' }));
    expect(s.h.db.conflictData.id.find(conflict.id)?.status).toBe('open');
  }
  const oldGreen = s.tx(ctx => reportCurrentGreen(ctx, conflict.id));
  s.snapshot('b', 'b2');
  s.tx(ctx => module.resolve_conflict_if_current(ctx, { ...version(conflict), verifiedRunKey: oldGreen, verifiedFact: 'stale fact' }));
  expect(s.h.db.conflictData.id.find(conflict.id)?.status).toBe('open');
  expect(s.h.db.intentData.count()).toBe(0n);
});

it('guarded completions ignore human-review, resolved and deleted conflicts', () => {
  const s = setup(); const conflict = s.open();
  const verifiedRunKey = s.tx(ctx => reportCurrentGreen(ctx, conflict.id));
  s.tx(ctx => module.flag_needs_human(ctx, { conflictId: conflict.id, reason: 'human decision required' }));
  const before = [...s.h.db.inboxData.iter()];
  s.tx(ctx => {
    module.set_explanation_if_current(ctx, { ...version(conflict), explanation: 'late advice' });
    module.resolve_conflict_if_current(ctx, { ...version(conflict), verifiedRunKey, verifiedFact: 'late fact' });
  });
  expect(s.h.db.conflictData.id.find(conflict.id)?.status).toBe('needs_human');
  expect(s.h.db.conflictData.id.find(conflict.id)?.explanation).toBe('');
  expect([...s.h.db.inboxData.iter()]).toEqual(before);
  s.tx(ctx => module.reset_all(ctx, {}));
  s.tx(ctx => {
    module.set_explanation_if_current(ctx, { ...version(conflict), explanation: 'after reset' });
    module.resolve_conflict_if_current(ctx, { ...version(conflict), verifiedRunKey, verifiedFact: 'after reset' });
  });
  expect(s.h.db.conflictData.count()).toBe(0n);
  expect(s.h.db.intentData.count()).toBe(0n);
});

it('guarded writers repeat authorization and one-off notes cannot create orphan conflict wakeups', () => {
  const s = setup(); const conflict = s.open();
  const verifiedRunKey = s.tx(ctx => reportCurrentGreen(ctx, conflict.id));
  expect(() => s.tx(ctx => module.set_explanation_if_current(ctx, { ...version(conflict), explanation: 'reader' }), s.reader)).toThrow('Editor access required');
  expect(() => s.tx(ctx => module.resolve_conflict_if_current(ctx, { ...version(conflict), verifiedRunKey, verifiedFact: 'reader' }), s.reader)).toThrow('Editor access required');
  const before = [...s.h.db.inboxData.iter()];
  expect(() => s.tx(ctx => module.send_note(ctx, { agent: 'a', kind: 'conflict', message: 'orphan' }))).toThrow('Invalid value');
  expect([...s.h.db.inboxData.iter()]).toEqual(before);
});
