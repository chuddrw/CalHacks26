/** WHAT IT'S FOR: Part C authorization regression checks using real portable-datastore transactions and queries.
 * The SDK test harness currently omits env injection; test contexts supply only the configured public owner ID.
 */
import { expect, it } from 'vitest';
import { ConnectionId, Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import db, * as module from '../src/index';
import { seedRedConflict, reportCurrentGreen } from './state-fixture';

type Ctx = Parameters<typeof module.post_snapshot>[0];
function caller(subject: string, connection: bigint) {
  return TestAuth.fromJwtPayload(JSON.stringify({ iss: 'cowork-access-test', sub: subject }), new ConnectionId(connection));
}
function setup() {
  const h = createModuleTestHarness(db, module);
  const owner = caller('owner', 1n);
  const reader = caller('reader', 2n);
  const editor = caller('editor', 3n);
  const stranger = caller('stranger', 4n);
  const identity = (who: TestAuth) => h.viewContext(who).sender;
  const ownerHex = identity(owner).toHexString();
  const environment = { ACCESS_OWNER_IDENTITY: ownerHex, get: (() => ownerHex) as Ctx['env']['get'] };
  const tx = <T>(who: TestAuth, callback: (ctx: Ctx) => T, signed = true) => h.withReducerTx(who, ctx => callback({
    ...ctx, identity: ctx.identity, databaseIdentity: ctx.databaseIdentity,
    senderAuth: signed ? ctx.senderAuth : { isInternal: false, hasJWT: false, jwt: null },
    env: environment,
  }));
  const view = (who: TestAuth) => ({ ...h.viewContext(who), env: environment });
  tx(owner, ctx => {
    module.grant_access(ctx, { identity: identity(reader).toHexString(), role: 'reader' });
    module.grant_access(ctx, { identity: identity(editor).toHexString(), role: 'editor' });
  });
  return { h, owner, reader, editor, stranger, identity, tx, view, environment };
}
const conflict = { kind: 'pair', agentA: 'a', agentB: 'b', locA: 'a.ts:1', locB: 'b.ts:1', error: 'unit mismatch', fixer: 'b', runKey: 'a1+b1' };
const mutations: Array<[string, (ctx: Ctx) => void]> = [
  ['register_agent', ctx => module.register_agent(ctx, { agent: 'a' })],
  ['post_snapshot', ctx => module.post_snapshot(ctx, { agent: 'a', sha: 'a1', baseSha: 'base', files: ['a.ts'], diff: 'diff' })],
  ['post_intent', ctx => module.post_intent(ctx, { agent: 'a', summary: 'intent', files: ['a.ts'], symbols: ['value'] })],
  ['report_check', ctx => module.report_check(ctx, { runKey: 'a1+b1', agents: ['a', 'b'], result: 'green', log: 'ok' })],
  ['report_conflict', ctx => module.report_conflict(ctx, conflict)],
  ['add_diagnosis_step', ctx => module.add_diagnosis_step(ctx, { conflictId: 1, source: 'droid', kind: 'status', detail: 'started' })],
  ['set_explanation', ctx => module.set_explanation(ctx, { conflictId: 1, explanation: 'cause' })],
  ['resolve_conflict', ctx => module.resolve_conflict(ctx, { conflictId: 1, verifiedFact: 'fact' })],
  ['flag_needs_human', ctx => module.flag_needs_human(ctx, { conflictId: 1, reason: 'test deleted' })],
  ['send_note', ctx => module.send_note(ctx, { agent: 'a', kind: 'info', message: 'note' })],
  ['mark_delivered', ctx => module.mark_delivered(ctx, { inboxIds: [1] })],
];
function state(h: ReturnType<typeof setup>['h']) {
  const names = ['agentData', 'snapshotData', 'intentData', 'checkRunData', 'conflictData', 'inboxData', 'diagnosisStepData', 'agent_connection', 'escalation_timer', 'accessMember'] as const;
  return Object.fromEntries(names.map(name => [name, [...h.db[name].iter()]]));
}
function seed(s: ReturnType<typeof setup>) {
  s.tx(s.owner, ctx => {
    module.register_agent(ctx, { agent: 'a' });
    module.post_snapshot(ctx, { agent: 'a', sha: 'a1', baseSha: 'base', files: ['a.ts'], diff: 'evidence' });
    module.post_snapshot(ctx, { agent: 'b', sha: 'b1', baseSha: 'base', files: ['b.ts'], diff: 'evidence' });
    module.post_intent(ctx, { agent: 'a', summary: 'intent', files: ['a.ts'], symbols: ['value'] });
    module.report_check(ctx, { runKey: conflict.runKey, agents: ['a', 'b'], result: 'red', log: 'failure' });
    module.report_conflict(ctx, conflict);
    module.add_diagnosis_step(ctx, { conflictId: 1, source: 'droid', kind: 'status', detail: 'started' });
  });
}
const views = {
  agent: { fn: module.agent, backing: 'agentData' },
  snapshot: { fn: module.snapshot, backing: 'snapshotData' },
  intent: { fn: module.intent, backing: 'intentData' },
  check_run: { fn: module.check_run, backing: 'checkRunData' },
  conflict: { fn: module.conflict, backing: 'conflictData' },
  inbox: { fn: module.inbox, backing: 'inboxData' },
  diagnosis_step: { fn: module.diagnosis_step, backing: 'diagnosisStepData' },
} as const;

it.each(mutations)('%s denies unsigned, nonmember and reader mutations without changing any rows', (_name, mutation) => {
  const s = setup(); seed(s);
  const before = state(s.h);
  for (const [who, signed] of [[s.owner, false], [s.stranger, true], [s.reader, true]] as const) {
    expect(() => s.tx(who, mutation, signed)).toThrow();
    expect(state(s.h)).toEqual(before);
  }
});

it('rejects a transaction including earlier valid writes if an unsigned mutation follows', () => {
  const s = setup();
  const before = state(s.h);
  expect(() => s.tx(s.owner, ctx => {
    module.post_snapshot(ctx, { agent: 'a', sha: 'a1', baseSha: 'base', files: [], diff: '' });
    module.send_note({ ...ctx, senderAuth: { isInternal: false, hasJWT: false, jwt: null } }, { agent: 'a', kind: 'info', message: 'denied' });
  })).toThrow();
  expect(state(s.h)).toEqual(before);
});

it('signed readers and editors may connect; unsigned callers and nonmembers may not', () => {
  const s = setup();
  for (const who of [s.owner, s.reader, s.editor]) expect(() => s.tx(who, ctx => module.client_connected(ctx, {}))).not.toThrow();
  expect(() => s.tx(s.stranger, ctx => module.client_connected(ctx, {}))).toThrow();
  expect(() => s.tx(s.owner, ctx => module.client_connected(ctx, {}), false)).toThrow();
});

it('public views return every original row/column for readers and no data for nonmembers', () => {
  const s = setup(); seed(s);
  for (const [name, view] of Object.entries(views)) {
    const expected = [...s.h.db[view.backing].iter()];
    expect(expected.length, `${name} fixture populated`).toBeGreaterThan(0);
    for (const who of [s.owner, s.reader, s.editor]) {
      expect(s.h.runQuery(view.fn(s.view(who))), `${name} authorized row parity`).toEqual(expected);
    }
    expect(s.h.runQuery(view.fn(s.view(s.stranger))), `${name} nonmember`).toEqual([]);
  }
});

it('editors can execute the existing coordination flow but cannot administer membership or reset', () => {
  const s = setup();
  s.tx(s.editor, ctx => module.post_snapshot(ctx, { agent: 'b', sha: 'b1', baseSha: 'base', files: ['b.ts'], diff: 'evidence' }));
  for (const [name, mutate] of mutations) {
    if (name === 'resolve_conflict' || name === 'flag_needs_human') continue;
    expect(() => s.tx(s.editor, ctx => {
      if (name === 'report_conflict') seedRedConflict(ctx, conflict);
      else mutate(ctx);
    }), name).not.toThrow();
  }
  expect(s.h.db.snapshotData.count()).toBe(2n);
  expect(s.h.db.conflictData.count()).toBe(1n);
  expect(() => s.tx(s.editor, ctx => {
    reportCurrentGreen(ctx, 1);
    module.resolve_conflict(ctx, { conflictId: 1, verifiedFact: 'verified after green' });
  })).not.toThrow();
  expect(s.h.db.intentData.count()).toBe(2n);
  expect(() => s.tx(s.editor, ctx => module.grant_access(ctx, { identity: s.identity(s.stranger).toHexString(), role: 'editor' }))).toThrow();
  expect(() => s.tx(s.editor, ctx => module.revoke_access(ctx, { identity: s.identity(s.reader).toHexString() }))).toThrow();
  expect(() => s.tx(s.editor, ctx => module.reset_all(ctx, {}))).toThrow();
  expect(s.h.db.snapshotData.count()).toBe(2n);
});

it('owner alone administers membership, validates roles, and resets data while preserving ACL', () => {
  const s = setup(); seed(s);
  for (const who of [s.reader, s.editor, s.stranger]) {
    expect(() => s.tx(who, ctx => module.grant_access(ctx, { identity: s.identity(s.stranger).toHexString(), role: 'reader' }))).toThrow();
    expect(() => s.tx(who, ctx => module.revoke_access(ctx, { identity: s.identity(s.reader).toHexString() }))).toThrow();
    expect(() => s.tx(who, ctx => module.reset_all(ctx, {}))).toThrow();
  }
  expect(() => s.tx(s.owner, ctx => module.grant_access(ctx, { identity: s.identity(s.stranger).toHexString(), role: 'owner' }))).toThrow();
  expect(() => s.tx(s.owner, ctx => module.grant_access(ctx, { identity: Identity.zero().toHexString(), role: 'editor' }))).toThrow();
  expect(() => s.tx(s.owner, ctx => module.revoke_access(ctx, { identity: s.identity(s.owner).toHexString() }))).toThrow();
  s.tx(s.owner, ctx => module.grant_access(ctx, { identity: s.identity(s.stranger).toHexString(), role: 'reader' }));
  const members = [...s.h.db.accessMember.iter()];
  s.tx(s.owner, ctx => module.reset_all(ctx, {}));
  expect([...s.h.db.accessMember.iter()]).toEqual(members);
  for (const view of Object.values(views)) expect(s.h.db[view.backing].count()).toBe(0n);
  expect(s.h.db.agent_connection.count()).toBe(0n);
  expect(s.h.db.escalation_timer.count()).toBe(0n);
});

it('revocation immediately removes view access and denies later writes on an existing identity', () => {
  const s = setup(); seed(s);
  const existingViewContext = s.view(s.editor);
  expect(s.h.runQuery(module.snapshot(existingViewContext))).toHaveLength(2);
  s.tx(s.owner, ctx => module.revoke_access(ctx, { identity: s.identity(s.editor).toHexString() }));
  for (const view of Object.values(views)) expect(s.h.runQuery(view.fn(existingViewContext))).toEqual([]);
  const before = state(s.h);
  expect(() => s.tx(s.editor, ctx => module.post_snapshot(ctx, { agent: 'a', sha: 'later', baseSha: 'base', files: [], diff: '' }))).toThrow();
  expect(() => s.tx(s.editor, ctx => module.client_connected(ctx, {}))).toThrow();
  expect(state(s.h)).toEqual(before);
});

it('missing or malformed owner configuration fails closed for public views and mutations', () => {
  const s = setup(); seed(s);
  for (const value of ['', 'invalid', '0'.repeat(64)]) {
    const env = { ACCESS_OWNER_IDENTITY: value, get: (() => value) as Ctx['env']['get'] };
    expect(() => s.tx(s.owner, ctx => module.post_snapshot({ ...ctx, env }, { agent: 'a', sha: 'later', baseSha: 'base', files: [], diff: '' }))).toThrow();
    expect(() => s.h.runQuery(module.snapshot({ ...s.view(s.owner), env }))).toThrow();
  }
});

it('unsigned owner and mismatched JWT identity cannot obtain owner or editor privileges', () => {
  const s = setup();
  expect(() => s.tx(s.owner, ctx => module.grant_access(ctx, { identity: s.identity(s.stranger).toHexString(), role: 'editor' }), false)).toThrow();
  expect(() => s.tx(s.owner, ctx => module.revoke_access(ctx, { identity: s.identity(s.reader).toHexString() }), false)).toThrow();
  expect(() => s.tx(s.owner, ctx => module.reset_all(ctx, {}), false)).toThrow();
  expect(() => s.tx(s.stranger, ctx => module.send_note({ ...ctx, sender: s.identity(s.owner) }, { agent: 'a', kind: 'info', message: 'forged owner' }))).toThrow();
  expect(s.h.db.accessMember.count()).toBe(2n);
  expect(s.h.db.inboxData.count()).toBe(0n);
});

it('editors can flag a conflict for human review', () => {
  const s = setup(); seed(s);
  s.tx(s.editor, ctx => module.flag_needs_human(ctx, { conflictId: 1, reason: 'test edited' }));
  expect(s.h.db.conflictData.id.find(1)?.status).toBe('needs_human');
});

it('all backing tables and ACL are private and every read surface requires a caller identity', () => {
  setup();
  for (const table of Object.values(db.schemaType.tables)) expect(table.tableDef.tableAccess.tag).toBe('Private');
  expect(db.moduleDef.views.filter(view => view.isAnonymous)).toEqual([]);
  expect(db.moduleDef.views.map(view => view.sourceName).sort()).toEqual(Object.keys(views).sort());
});

it('downgrading an editor to reader preserves reads and denies writes immediately', () => {
  const s = setup(); seed(s);
  s.tx(s.owner, ctx => module.grant_access(ctx, { identity: s.identity(s.editor).toHexString(), role: 'reader' }));
  expect(s.h.runQuery(module.snapshot(s.view(s.editor)))).toHaveLength(2);
  expect(() => s.tx(s.editor, ctx => module.send_note(ctx, { agent: 'a', kind: 'info', message: 'denied' }))).toThrow();
  expect(s.h.db.accessMember.identity.find(s.identity(s.editor))?.role).toBe('reader');
});
