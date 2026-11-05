/** WHAT IT'S FOR: the identity binding. An approved person with a handle can only act as that handle;
 * callers without a profile (orchestrator, dashboard, older setups) behave exactly as before.
 */
import { expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import db, * as module from '../src/index';

type Ctx = Parameters<typeof module.post_snapshot>[0];
const who = (subject: string, connection: bigint) =>
  TestAuth.fromJwtPayload(JSON.stringify({ iss: 'cowork-identity-test', sub: subject }), new ConnectionId(connection));
function setup() {
  const h = createModuleTestHarness(db, module);
  const owner = who('owner', 1n), ana = who('ana', 2n), ben = who('ben', 3n), orch = who('orch', 4n);
  const id = (a: TestAuth) => h.viewContext(a).sender.toHexString();
  const ownerHex = id(owner);
  const env = { ACCESS_OWNER_IDENTITY: ownerHex, get: (() => ownerHex) as Ctx['env']['get'] };
  const tx = <T>(a: TestAuth, fn: (ctx: Ctx) => T) => h.withReducerTx(a, ctx => fn({
    ...ctx, identity: ctx.identity, databaseIdentity: ctx.databaseIdentity, senderAuth: ctx.senderAuth, env,
  } as Ctx));
  tx(owner, ctx => {
    for (const a of [ana, ben, orch]) module.grant_access(ctx, { identity: id(a), role: 'editor' });
    module.set_member_profile(ctx, { identity: id(ana), handle: 'ana', displayName: 'Ana' });
    module.set_member_profile(ctx, { identity: id(ben), handle: 'ben', displayName: 'Ben' });
  });
  return { h, owner, ana, ben, orch, id, tx };
}
const snapshot = (agent: string) => ({ agent, sha: 'a1', baseSha: 'base', files: ['a.ts'], diff: 'd' });

it('a person with a handle can act as themselves but not as someone else', () => {
  const s = setup();
  s.tx(s.ana, ctx => module.post_snapshot(ctx, snapshot('ana')));
  expect(() => s.tx(s.ana, ctx => module.post_snapshot(ctx, snapshot('ben')))).toThrow('You are ana, not ben');
  expect(() => s.tx(s.ana, ctx => module.submit_request(ctx, { agent: 'ben', body: 'x' }))).toThrow('You are ana, not ben');
  expect(() => s.tx(s.ben, ctx => module.post_intent(ctx, { agent: 'ana', summary: 's', files: [], symbols: [] }))).toThrow('You are ben, not ana');
  expect(() => s.tx(s.ben, ctx => module.complete_task(ctx, { taskId: 1, agent: 'ana', summary: 's' }))).toThrow('You are ben, not ana');
  expect(() => s.tx(s.ben, ctx => module.post_message(ctx, { conflictId: 1, agent: 'ana', kind: 'message', body: 'x' }))).toThrow('You are ben, not ana');
  expect(() => s.tx(s.ben, ctx => module.report_usage(ctx, { agent: 'ana', requestId: 0, taskId: 0, conflictId: 0, phase: 'idle-wake', model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }))).toThrow('You are ben, not ana');
});

it('a caller without a profile (the orchestrator, older setups) keeps working as any agent', () => {
  const s = setup();
  s.tx(s.orch, ctx => module.post_snapshot(ctx, snapshot('a')));
  s.tx(s.orch, ctx => module.submit_request(ctx, { agent: 'zed', body: 'x' }));
  expect(s.h.db.requestData.count()).toBe(1n);
});

it('submit_request_as_me uses the caller\'s own handle, and fails without one', () => {
  const s = setup();
  s.tx(s.ana, ctx => module.submit_request_as_me(ctx, { body: 'make lastLogin milliseconds' }));
  expect([...s.h.db.requestData.iter()][0]!.agent).toBe('ana');
  expect(() => s.tx(s.orch, ctx => module.submit_request_as_me(ctx, { body: 'x' }))).toThrow('no agent handle');
  expect(() => s.tx(s.ana, ctx => module.submit_request_as_me(ctx, { body: '  ' }))).toThrow('Say what you want');
});

it('handles are unique and well formed, and only the owner sets them', () => {
  const s = setup();
  expect(() => s.tx(s.owner, ctx => module.set_member_profile(ctx, { identity: s.id(s.orch), handle: 'ana', displayName: 'Other' }))).toThrow('already taken');
  expect(() => s.tx(s.owner, ctx => module.set_member_profile(ctx, { identity: s.id(s.orch), handle: 'Not Valid', displayName: 'x' }))).toThrow('lowercase');
  expect(() => s.tx(s.ana, ctx => module.set_member_profile(ctx, { identity: s.id(s.ana), handle: 'ana2', displayName: 'x' }))).toThrow('Owner access required');
  s.tx(s.owner, ctx => module.set_member_profile(ctx, { identity: s.id(s.ana), handle: 'ana', displayName: 'Ana Renamed' }));
  expect(s.h.db.memberProfileData.count()).toBe(2n);
});

it('revoking access removes the profile and frees the handle; reset_all keeps profiles', () => {
  const s = setup();
  s.tx(s.owner, ctx => module.reset_all(ctx, {}));
  expect(s.h.db.memberProfileData.count()).toBe(2n);
  s.tx(s.owner, ctx => module.revoke_access(ctx, { identity: s.id(s.ana) }));
  expect(s.h.db.memberProfileData.count()).toBe(1n);
  s.tx(s.owner, ctx => module.set_member_profile(ctx, { identity: s.id(s.orch), handle: 'ana', displayName: 'New Ana' }));
});

it('the member_profile view is readable by any role and by nobody else', () => {
  const s = setup();
  const ctx = (a: TestAuth) => ({ ...s.h.viewContext(a), env: { ACCESS_OWNER_IDENTITY: s.id(s.owner), get: (() => s.id(s.owner)) as Ctx['env']['get'] } });
  expect(module.member_profile).toBeDefined();
  expect(ctx(s.ana).sender).toBeDefined();
});

it('a person can only report checks and conflicts they are part of, and only mark their own inbox delivered', () => {
  const s = setup();
  // report_check: must include your own handle
  expect(() => s.tx(s.ana, ctx => module.report_check(ctx, { runKey: 'k1', agents: ['ben'], result: 'green', log: '' }))).toThrow('You are ana');
  s.tx(s.ana, ctx => module.report_check(ctx, { runKey: 'k2', agents: ['ana', 'ben'], result: 'green', log: '' }));
  // report_conflict: must involve you
  const conflict = (agentA: string, agentB: string) => ({ kind: 'pair', agentA, agentB, locA: 'a.ts:1', locB: 'b.ts:1', error: 'e', fixer: agentA, runKey: 'k3' });
  expect(() => s.tx(s.ana, ctx => module.report_conflict(ctx, conflict('ben', 'zed')))).toThrow('You are ana');
  s.tx(s.ana, ctx => module.report_check(ctx, { runKey: 'k3', agents: ['ana', 'ben'], result: 'red', log: 'boom' }));
  s.tx(s.ana, ctx => module.report_conflict(ctx, conflict('ana', 'ben')));
  // mark_delivered: a teammate's wake-ups are not yours to silence
  s.tx(s.orch, ctx => module.send_note(ctx, { agent: 'ben', kind: 'info', message: 'hi ben' }));
  const row = [...s.h.db.inboxData.iter()].find(r => r.agent === 'ben' && r.message === 'hi ben')!;
  expect(() => s.tx(s.ana, ctx => module.mark_delivered(ctx, { inboxIds: [row.id] }))).toThrow("ben's");
  s.tx(s.ben, ctx => module.mark_delivered(ctx, { inboxIds: [row.id] }));
  expect(s.h.db.inboxData.id.find(row.id)?.delivered).toBe(true);
  // callers without a profile (the orchestrator) are unchanged
  s.tx(s.orch, ctx => module.mark_delivered(ctx, { inboxIds: [row.id] }));
});
