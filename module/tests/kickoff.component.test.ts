/** WHAT IT'S FOR: the kickoff flow in the module: submit (as your own handle), one round of questions,
 * a proposal, and the humans' decision. Nothing here touches the repo.
 */
import { expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import db, * as module from '../src/index';

type Ctx = Parameters<typeof module.post_snapshot>[0];
const who = (subject: string, connection: bigint) =>
  TestAuth.fromJwtPayload(JSON.stringify({ iss: 'cowork-kickoff-test', sub: subject }), new ConnectionId(connection));
const members = JSON.stringify([{ handle: 'ana', displayName: 'Ana', strengths: 'frontend' }, { handle: 'ben', displayName: 'Ben' }]);
function setup() {
  const h = createModuleTestHarness(db, module);
  const owner = who('owner', 1n), ana = who('ana', 2n), orch = who('orch', 3n), reader = who('reader', 4n);
  const id = (a: TestAuth) => h.viewContext(a).sender.toHexString();
  const ownerHex = id(owner);
  const env = { ACCESS_OWNER_IDENTITY: ownerHex, get: (() => ownerHex) as Ctx['env']['get'] };
  const tx = <T>(a: TestAuth, fn: (ctx: Ctx) => T) => h.withReducerTx(a, ctx => fn({
    ...ctx, identity: ctx.identity, databaseIdentity: ctx.databaseIdentity, senderAuth: ctx.senderAuth, env,
  } as Ctx));
  tx(owner, ctx => {
    for (const a of [ana, orch]) module.grant_access(ctx, { identity: id(a), role: 'editor' });
    module.grant_access(ctx, { identity: id(reader), role: 'reader' });
    module.set_member_profile(ctx, { identity: id(ana), handle: 'ana', displayName: 'Ana' });
  });
  const row = (n: number) => h.db.kickoffData.id.find(n)!;
  return { h, owner, ana, orch, reader, tx, row };
}
const start = (s: ReturnType<typeof setup>) => {
  s.tx(s.ana, ctx => module.submit_kickoff(ctx, { goal: 'a campus events app', constraints: 'React, 24 hours', members }));
  s.tx(s.orch, ctx => module.start_kickoff(ctx, { kickoffId: 1 }));
};

it('submit_kickoff takes the requester from the caller\'s profile and starts at new', () => {
  const s = setup();
  s.tx(s.ana, ctx => module.submit_kickoff(ctx, { goal: ' a campus events app ', constraints: 'React', members }));
  expect(s.row(1)).toMatchObject({ requester: 'ana', goal: 'a campus events app', constraints: 'React', status: 'new', questions: '', answers: '', proposal: '', ownersJson: '', note: '' });
  expect(JSON.parse(s.row(1).members)).toEqual([{ handle: 'ana', displayName: 'Ana', strengths: 'frontend' }, { handle: 'ben', displayName: 'Ben' }]);
});

it('submit_kickoff needs a profile, a goal and well-formed members', () => {
  const s = setup();
  expect(() => s.tx(s.orch, ctx => module.submit_kickoff(ctx, { goal: 'g', constraints: '', members }))).toThrow('no agent handle');
  expect(() => s.tx(s.ana, ctx => module.submit_kickoff(ctx, { goal: '  ', constraints: '', members }))).toThrow('what the team wants');
  expect(() => s.tx(s.ana, ctx => module.submit_kickoff(ctx, { goal: 'g', constraints: '', members: '[]' }))).toThrow('at least one');
  expect(() => s.tx(s.ana, ctx => module.submit_kickoff(ctx, { goal: 'g', constraints: '', members: 'nope' }))).toThrow('valid JSON');
  expect(() => s.tx(s.ana, ctx => module.submit_kickoff(ctx, { goal: 'g', constraints: '', members: '[{"handle":"ana"}]' }))).toThrow('displayName');
  expect(() => s.tx(s.reader, ctx => module.submit_kickoff(ctx, { goal: 'g', constraints: '', members }))).toThrow();
});

it('one round of questions: needs_answers, answered back to new, and a second round is refused', () => {
  const s = setup(); start(s);
  s.tx(s.orch, ctx => module.ask_kickoff_questions(ctx, { kickoffId: 1, questions: [' Which stack? ', '', 'Who demos?'] }));
  expect(s.row(1).status).toBe('needs_answers');
  expect(JSON.parse(s.row(1).questions)).toEqual(['Which stack?', 'Who demos?']);
  expect([...s.h.db.inboxData.iter()].some(m => m.agent === 'ana' && m.message.includes('question'))).toBe(true);
  expect(() => s.tx(s.ana, ctx => module.answer_kickoff(ctx, { kickoffId: 1, answers: '  ' }))).toThrow('answers first');
  s.tx(s.ana, ctx => module.answer_kickoff(ctx, { kickoffId: 1, answers: 'React; Ana demos' }));
  expect(s.row(1)).toMatchObject({ status: 'new', answers: 'React; Ana demos' });
  expect(() => s.tx(s.ana, ctx => module.answer_kickoff(ctx, { kickoffId: 1, answers: 'again' }))).toThrow('isn\'t waiting');
  s.tx(s.orch, ctx => module.start_kickoff(ctx, { kickoffId: 1 }));
  expect(() => s.tx(s.orch, ctx => module.ask_kickoff_questions(ctx, { kickoffId: 1, questions: ['more?'] }))).toThrow('one round');
});

it('publish_proposal stores the proposal and the owners file; approval changes only the row', () => {
  const s = setup(); start(s);
  expect(() => s.tx(s.orch, ctx => module.publish_proposal(ctx, { kickoffId: 1, proposalJson: 'not json', ownersJson: '{}' }))).toThrow('valid JSON');
  s.tx(s.orch, ctx => module.publish_proposal(ctx, { kickoffId: 1, proposalJson: '{"owners":[]}', ownersJson: '{"owners":[]}' }));
  expect(s.row(1)).toMatchObject({ status: 'proposed', proposal: '{"owners":[]}', ownersJson: '{"owners":[]}' });
  expect(() => s.tx(s.orch, ctx => module.publish_proposal(ctx, { kickoffId: 1, proposalJson: '{}', ownersJson: '{}' }))).toThrow('not planning');
  s.tx(s.ana, ctx => module.decide_kickoff(ctx, { kickoffId: 1, approve: true, note: 'looks right' }));
  expect(s.row(1)).toMatchObject({ status: 'approved', note: 'looks right' });
  expect(() => s.tx(s.ana, ctx => module.decide_kickoff(ctx, { kickoffId: 1, approve: false, note: '' }))).toThrow('only a proposed');
});

it('a rejection is recorded, and failing a kickoff tells the requester', () => {
  const s = setup(); start(s);
  s.tx(s.orch, ctx => module.publish_proposal(ctx, { kickoffId: 1, proposalJson: '{}', ownersJson: '{}' }));
  s.tx(s.ana, ctx => module.decide_kickoff(ctx, { kickoffId: 1, approve: false, note: 'too many cooks' }));
  expect(s.row(1)).toMatchObject({ status: 'rejected', note: 'too many cooks' });
  s.tx(s.ana, ctx => module.submit_kickoff(ctx, { goal: 'second', constraints: '', members }));
  s.tx(s.orch, ctx => module.fail_kickoff(ctx, { kickoffId: 2, reason: 'FACTORY_API_KEY is not set' }));
  expect(s.row(2)).toMatchObject({ status: 'failed', note: 'FACTORY_API_KEY is not set' });
  expect([...s.h.db.inboxData.iter()].some(m => m.agent === 'ana' && m.message.includes("couldn't propose"))).toBe(true);
  // failing a finished kickoff is a no-op
  s.tx(s.orch, ctx => module.fail_kickoff(ctx, { kickoffId: 1, reason: 'late' }));
  expect(s.row(1).status).toBe('rejected');
});

it('readers cannot mutate a kickoff and reset_all clears them', () => {
  const s = setup(); start(s);
  expect(() => s.tx(s.reader, ctx => module.start_kickoff(ctx, { kickoffId: 1 }))).toThrow();
  expect(() => s.tx(s.reader, ctx => module.decide_kickoff(ctx, { kickoffId: 1, approve: true, note: '' }))).toThrow();
  s.tx(s.owner, ctx => module.reset_all(ctx, {}));
  expect(s.h.db.kickoffData.count()).toBe(0n);
});
