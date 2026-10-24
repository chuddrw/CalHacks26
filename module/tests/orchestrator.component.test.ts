/**
 * WHAT IT'S FOR: the orchestrator's reducers (branch feat/orchestrator) on the real in-memory
 * datastore: a request becomes a plan in one transaction, reviews hold its tasks, conflict threads
 * resolve only when both agents agree on a current green check, and stuck threads go to both humans.
 */
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import db, * as module from '../src/index';
import { seedRedConflict } from './state-fixture';

type Ctx = Parameters<typeof module.post_snapshot>[0];
function caller(subject: string, connection: bigint) {
  return TestAuth.fromJwtPayload(JSON.stringify({ iss: 'cowork-orchestrator-test', sub: subject }), new ConnectionId(connection));
}
const lastLoginTask = { agent: 'a', title: 'Store lastLogin in milliseconds', details: 'Change the contract and users module.', files: ['src/contracts/user.ts', 'src/users/user.ts'], major: true };
const sessionsTask = { agent: 'b', title: 'Read lastLogin as milliseconds in sessions', details: 'session.ts and idle.ts', files: ['src/sessions/session.ts'], major: false };
const overlap = { agentA: 'a', agentB: 'b', topic: 'lastLogin unit', details: "b's in-progress idle.ts assumes seconds", suggested: 'b' };

function setup() {
  const h = createModuleTestHarness(db, module);
  h.clock.set(new Timestamp(1_700_000_000_123_000n));
  const owner = caller('owner', 1n);
  const editor = caller('editor', 2n);
  const identity = (who: TestAuth) => h.viewContext(who).sender;
  const ownerHex = identity(owner).toHexString();
  const env = { ACCESS_OWNER_IDENTITY: ownerHex, get: (() => ownerHex) as Ctx['env']['get'] };
  const tx = <T>(who: TestAuth, body: (ctx: Ctx) => T) => h.withReducerTx(who, ctx => body({
    ...ctx, databaseIdentity: ctx.databaseIdentity, identity: ctx.identity, senderAuth: ctx.senderAuth, env,
  }));
  tx(owner, ctx => module.grant_access(ctx, { identity: identity(editor).toHexString(), role: 'editor' }));
  const as = <T>(body: (ctx: Ctx) => T) => tx(editor, body);
  /** a's human asks; the orchestrator plans it; returns the request id. */
  const ask = (plan: object, body = 'The frontend needs lastLogin in milliseconds') => {
    as(ctx => module.submit_request(ctx, { agent: 'a', body }));
    const id = Math.max(...[...h.db.requestData.iter()].map(row => row.id));
    as(ctx => {
      module.start_request(ctx, { requestId: id });
      module.publish_plan(ctx, { requestId: id, summary: 'a changes the unit, b adapts sessions', plan: JSON.stringify(plan) });
    });
    return id;
  };
  const inbox = (agent: string) => [...h.db.inboxData.iter()].filter(row => row.agent === agent);
  const tasks = () => [...h.db.taskData.iter()];
  const conflicts = () => [...h.db.conflictData.iter()];
  const thread = (id: number) => [...h.db.messageData.iter()].filter(row => row.conflictId === id).map(row => [row.author, row.kind]);
  const say = (conflictId: number, agent: string, kind: 'message' | 'agree' | 'escalate', body: string) =>
    as(ctx => module.post_message(ctx, { conflictId, agent, kind, body }));
  /** Both agents' latest snapshots, with a current green check covering them. */
  const green = (shas: Record<string, string>) => as(ctx => {
    for (const [agent, sha] of Object.entries(shas)) module.post_snapshot(ctx, { agent, sha, baseSha: 'base', files: [], diff: '' });
    module.report_check(ctx, { runKey: Object.values(shas).sort().join('+'), agents: Object.keys(shas), result: 'green', log: 'ok' });
  });
  return { h, as, tx, owner, ask, inbox, tasks, conflicts, thread, say, green };
}

describe('requests and plans', () => {
  it('a plan without reviews assigns every task, wakes each assignee and opens the flagged conflict for both agents', () => {
    const s = setup();
    const id = s.ask({ tasks: [lastLoginTask, sessionsTask], reviews: [], conflicts: [overlap] });
    expect(s.h.db.requestData.id.find(id)).toMatchObject({ status: 'assigned', summary: 'a changes the unit, b adapts sessions' });
    expect(s.tasks().map(task => [task.agent, task.status])).toEqual([['a', 'assigned'], ['b', 'assigned']]);
    for (const task of s.tasks()) {
      expect(s.inbox(task.agent).filter(row => row.kind === 'task')).toMatchObject([{ conflictId: task.id, delivered: false }]);
    }
    const [conflict] = s.conflicts();
    expect(conflict).toMatchObject({ kind: 'potential', pair: 'a+b', fixer: 'b', status: 'open', runKey: '' });
    for (const agent of ['a', 'b']) expect(s.inbox(agent).filter(row => row.kind === 'conflict')).toMatchObject([{ conflictId: conflict!.id }]);
    expect(s.thread(conflict!.id)).toEqual([['orchestrator', 'message']]);
    expect(s.h.db.escalation_timer.count()).toBe(1n);
    // A prediction is not a failed check: nobody turns red.
    expect([...s.h.db.agentData.iter()].map(agent => agent.status)).toEqual(['green', 'green']);
    expect(s.inbox('a').some(row => row.kind === 'info' && row.message.includes('planned your request'))).toBe(true);
  });

  it('a review holds the tasks and conflicts until approved, then releases them all at once', () => {
    const s = setup();
    const id = s.ask({ tasks: [lastLoginTask, sessionsTask], reviews: [{ reviewer: 'b', summary: 'Sessions read lastLogin' }], conflicts: [overlap] });
    expect(s.h.db.requestData.id.find(id)?.status).toBe('waiting_review');
    expect(s.tasks().map(task => task.status)).toEqual(['waiting_review', 'waiting_review']);
    expect([...s.h.db.inboxData.iter()].filter(row => row.kind === 'task' || row.kind === 'conflict')).toEqual([]);
    expect(s.conflicts()).toEqual([]);
    expect(s.inbox('b').filter(row => row.kind === 'info')[0]!.message).toContain('your human reviews it on the dashboard');
    const review = [...s.h.db.reviewData.iter()][0]!;
    s.as(ctx => module.decide_review(ctx, { reviewId: review.id, approve: true, answer: 'fine by sessions' }));
    expect(s.h.db.reviewData.id.find(review.id)).toMatchObject({ status: 'approved', answer: 'fine by sessions', decidedAt: 1_700_000_000_123 });
    expect(s.h.db.requestData.id.find(id)?.status).toBe('assigned');
    expect(s.tasks().map(task => task.status)).toEqual(['assigned', 'assigned']);
    expect([...s.h.db.inboxData.iter()].filter(row => row.kind === 'task').map(row => row.agent).sort()).toEqual(['a', 'b']);
    expect(s.conflicts()).toMatchObject([{ kind: 'potential', status: 'open' }]);
    expect(() => s.as(ctx => module.decide_review(ctx, { reviewId: review.id, approve: true, answer: '' }))).toThrow(/already approved/);
  });

  it('every review must approve; one send back cancels the held tasks and the other reviews', () => {
    const s = setup();
    const id = s.ask({ tasks: [lastLoginTask], reviews: [{ reviewer: 'b', summary: 'sessions' }, { reviewer: 'd', summary: 'api' }], conflicts: [] });
    const [first, second] = [...s.h.db.reviewData.iter()];
    s.as(ctx => module.decide_review(ctx, { reviewId: first!.id, approve: true, answer: '' }));
    expect(s.tasks()[0]!.status).toBe('waiting_review');
    s.as(ctx => module.decide_review(ctx, { reviewId: second!.id, approve: false, answer: 'the frontend still parses seconds' }));
    expect(s.h.db.requestData.id.find(id)?.status).toBe('rejected');
    expect(s.tasks()[0]).toMatchObject({ status: 'cancelled', note: "Sent back by d's human (the frontend still parses seconds)" });
    expect(s.inbox('a').at(-1)!.message).toContain('the frontend still parses seconds');
    expect([...s.h.db.inboxData.iter()].filter(row => row.kind === 'task')).toEqual([]);

    const again = s.ask({ tasks: [lastLoginTask], reviews: [{ reviewer: 'b', summary: 'x' }, { reviewer: 'd', summary: 'y' }], conflicts: [] });
    const [, , third, fourth] = [...s.h.db.reviewData.iter()];
    s.as(ctx => module.decide_review(ctx, { reviewId: third!.id, approve: false, answer: '' }));
    expect(s.h.db.reviewData.id.find(fourth!.id)?.status).toBe('cancelled');
    expect(s.h.db.requestData.id.find(again)?.status).toBe('rejected');
  });

  it('rejects an invalid plan without writing anything, and publishes a request only once', () => {
    const s = setup();
    s.as(ctx => module.submit_request(ctx, { agent: 'a', body: 'do it' }));
    const before = { tasks: s.tasks(), inbox: [...s.h.db.inboxData.iter()] };
    for (const plan of ['not json', '[]', JSON.stringify({ tasks: [{ agent: '../a', title: 'x' }] }),
      JSON.stringify({ tasks: [lastLoginTask], conflicts: [{ ...overlap, agentB: 'a' }] }),
      JSON.stringify({ tasks: [{ ...lastLoginTask, title: ' ' }] })]) {
      expect(() => s.as(ctx => module.publish_plan(ctx, { requestId: 1, summary: 's', plan })), plan).toThrow();
    }
    expect(s.tasks()).toEqual(before.tasks);
    expect([...s.h.db.inboxData.iter()]).toEqual(before.inbox);
    s.as(ctx => module.publish_plan(ctx, { requestId: 1, summary: 'nothing to do', plan: '{}' }));
    expect(s.h.db.requestData.id.find(1)?.status).toBe('done');
    expect(() => s.as(ctx => module.publish_plan(ctx, { requestId: 1, summary: 'again', plan: '{}' }))).toThrow(/already done/);
    expect(() => s.as(ctx => module.submit_request(ctx, { agent: 'a', body: '   ' }))).toThrow();
  });

  it('a failed plan tells the requester once; plan steps need a real request', () => {
    const s = setup();
    s.as(ctx => {
      module.submit_request(ctx, { agent: 'a', body: 'do it' });
      module.start_request(ctx, { requestId: 1 });
      module.start_request(ctx, { requestId: 1 });
      module.add_plan_step(ctx, { requestId: 1, kind: 'tool_call', detail: 'team_status {}' });
      module.fail_request(ctx, { requestId: 1, reason: 'Droid timed out' });
      module.fail_request(ctx, { requestId: 1, reason: 'again' });
    });
    expect(s.h.db.requestData.id.find(1)).toMatchObject({ status: 'failed', summary: 'Droid timed out' });
    expect(s.inbox('a').filter(row => row.message.includes("couldn't plan"))).toHaveLength(1);
    expect(s.h.db.planStepData.count()).toBe(1n);
    expect(() => s.as(ctx => module.add_plan_step(ctx, { requestId: 9, kind: 'status', detail: 'orphan' }))).toThrow('Unknown request #9');
    expect(() => s.as(ctx => module.start_request(ctx, { requestId: 1 }))).toThrow(/already failed/);
  });
});

describe('tasks', () => {
  it('only the assignee completes an assigned task, and only on a current green check that includes it', () => {
    const s = setup();
    const id = s.ask({ tasks: [lastLoginTask, sessionsTask], reviews: [], conflicts: [] });
    const [mine, theirs] = s.tasks();
    expect(() => s.as(ctx => module.complete_task(ctx, { taskId: mine!.id, agent: 'b', summary: 'x' }))).toThrow(/belongs to a/);
    s.as(ctx => module.post_snapshot(ctx, { agent: 'a', sha: 'a1', baseSha: 'base', files: ['src/users/user.ts'], diff: 'd' }));
    expect(() => s.as(ctx => module.complete_task(ctx, { taskId: mine!.id, agent: 'a', summary: 'x' }))).toThrow(/check_with_team/);
    s.as(ctx => module.report_check(ctx, { runKey: 'a1', agents: ['a'], result: 'green', log: 'ok' }));
    s.as(ctx => module.complete_task(ctx, { taskId: mine!.id, agent: 'a', summary: 'lastLogin is ms now' }));
    expect(s.h.db.taskData.id.find(mine!.id)).toMatchObject({ status: 'done', note: 'lastLogin is ms now' });
    expect(() => s.as(ctx => module.complete_task(ctx, { taskId: mine!.id, agent: 'a', summary: 'x' }))).toThrow(/is done/);
    expect(s.h.db.requestData.id.find(id)?.status).toBe('assigned');
    // b never changed anything, so there is nothing a check could cover.
    s.as(ctx => module.complete_task(ctx, { taskId: theirs!.id, agent: 'b', summary: 'nothing to change' }));
    expect(s.h.db.requestData.id.find(id)?.status).toBe('done');
    expect(s.inbox('a').map(row => row.message).filter(text => text.includes('finished task') || text.includes('is done'))).toHaveLength(2);
  });
});

describe('conflict threads', () => {
  const open = (s: ReturnType<typeof setup>) => { s.ask({ tasks: [lastLoginTask], reviews: [], conflicts: [overlap] }); return s.conflicts()[0]!.id; };

  it('a message wakes the other agent; outsiders and closed threads are refused', () => {
    const s = setup(); const id = open(s);
    s.say(id, 'b', 'message', 'My idle.ts divides by 1000. Tell me when your change is pushed.');
    expect(s.inbox('a').filter(row => row.kind === 'message')).toMatchObject([{ conflictId: id, delivered: false }]);
    expect(s.inbox('a').at(-1)!.message).toContain('b says in conflict');
    expect(() => s.say(id, 'c', 'message', 'hi')).toThrow(/isn't part of/);
    expect(() => s.say(id, 'a', 'message', '  ')).toThrow(/empty/);
  });

  it('both agreeing on a current green check resolves it and publishes the last agreement as a fact', () => {
    const s = setup(); const id = open(s);
    s.green({ a: 'a1', b: 'b1' });
    s.say(id, 'b', 'agree', 'idle.ts now uses milliseconds');
    expect(s.h.db.conflictData.id.find(id)?.status).toBe('open');
    s.say(id, 'a', 'agree', 'User.lastLogin is milliseconds since the Unix epoch');
    expect(s.h.db.conflictData.id.find(id)).toMatchObject({ status: 'resolved', resolvedAt: 1_700_000_000_123 });
    expect([...s.h.db.intentData.iter()]).toMatchObject([{ agent: 'orchestrator', verified: true, summary: 'User.lastLogin is milliseconds since the Unix epoch' }]);
    expect(s.h.db.escalation_timer.count()).toBe(0n);
    expect(() => s.say(id, 'a', 'message', 'one more thing')).toThrow(/already resolved/);
  });

  it('agreement without a current green check keeps it open and says why', () => {
    const s = setup(); const id = open(s);
    s.as(ctx => {
      module.post_snapshot(ctx, { agent: 'a', sha: 'a1', baseSha: 'base', files: [], diff: '' });
      module.post_snapshot(ctx, { agent: 'b', sha: 'b1', baseSha: 'base', files: [], diff: '' });
    });
    s.say(id, 'a', 'agree', 'done');
    s.say(id, 'b', 'agree', 'done too');
    expect(s.h.db.conflictData.id.find(id)?.status).toBe('open');
    expect(s.inbox('a').at(-1)!.message).toContain('no current green check');
    // An agreement followed by another message no longer counts.
    s.green({ a: 'a2', b: 'b2' });
    s.say(id, 'a', 'message', 'wait, one more change');
    s.say(id, 'b', 'agree', 'done');
    expect(s.h.db.conflictData.id.find(id)?.status).toBe('open');
    s.say(id, 'a', 'agree', 'User.lastLogin is milliseconds');
    expect(s.h.db.conflictData.id.find(id)?.status).toBe('resolved');
  });

  it('two agents that never changed anything can settle by agreeing', () => {
    const s = setup(); const id = open(s);
    s.say(id, 'a', 'agree', 'Keep seconds; a drops the change');
    s.say(id, 'b', 'agree', 'User.lastLogin stays in seconds');
    expect(s.h.db.conflictData.id.find(id)?.status).toBe('resolved');
  });

  it('escalate hands it to both humans; their decision reopens it, wakes both, and needs fresh agreement', () => {
    const s = setup(); const id = open(s);
    s.green({ a: 'a1', b: 'b1' });
    s.say(id, 'a', 'agree', 'use ms');
    s.say(id, 'b', 'escalate', "Sessions must stay in seconds for the session store; I can't accept milliseconds.");
    expect(s.h.db.conflictData.id.find(id)?.status).toBe('escalated');
    expect(s.h.db.escalation_timer.count()).toBe(0n);
    for (const agent of ['a', 'b']) expect(s.inbox(agent).at(-1)!.message).toContain('went to both humans');
    expect([...s.h.db.inboxData.iter()].filter(row => (row.kind === 'message' || row.kind === 'conflict') && !row.delivered)).toEqual([]);
    expect(() => s.say(id, 'a', 'message', 'please?')).toThrow(/wait for their decision/);
    expect(() => s.as(ctx => module.decide_conflict(ctx, { conflictId: id, decision: ' ' }))).toThrow();
    s.as(ctx => module.decide_conflict(ctx, { conflictId: id, decision: 'Use milliseconds; b converts at the session store.' }));
    expect(s.h.db.conflictData.id.find(id)?.status).toBe('open');
    expect(s.thread(id).at(-1)).toEqual(['human', 'decision']);
    for (const agent of ['a', 'b']) expect(s.inbox(agent).at(-1)).toMatchObject({ kind: 'message', delivered: false });
    // a's agreement from before the decision doesn't count any more.
    s.say(id, 'b', 'agree', 'converted at the store');
    expect(s.h.db.conflictData.id.find(id)?.status).toBe('open');
    s.say(id, 'a', 'agree', 'User.lastLogin is milliseconds; the session store keeps seconds');
    expect(s.h.db.conflictData.id.find(id)?.status).toBe('resolved');
  });

  it('twelve messages without agreement, or the timer, escalate to both humans', () => {
    const s = setup(); const id = open(s);
    for (let index = 0; index < 12; index++) s.say(id, index % 2 ? 'a' : 'b', 'message', `round ${index}`);
    expect(s.h.db.conflictData.id.find(id)?.status).toBe('escalated');
    expect(s.thread(id).at(-1)).toEqual(['orchestrator', 'escalate']);

    const t = setup(); const other = open(t);
    const timer = [...t.h.db.escalation_timer.iter()][0]!;
    t.tx(TestAuth.internal(), ctx => module.escalate(ctx, { arg: timer }));
    expect(t.h.db.conflictData.id.find(other)?.status).toBe('escalated');
    expect(t.inbox('b').at(-1)!.message).toContain('Still open after 5 minutes');
  });

  it('a red check on a flagged pair turns the potential conflict into a real one', () => {
    const s = setup(); const id = open(s);
    s.as(ctx => seedRedConflict(ctx, { kind: 'pair', agentA: 'a', agentB: 'b', locA: 'src/users/user.ts:14',
      locB: 'src/sessions/idle.ts:7', error: 'expected -29850839249 to be 31', fixer: 'b', runKey: 'a1+b1' }));
    expect(s.conflicts()).toHaveLength(1);
    expect(s.h.db.conflictData.id.find(id)).toMatchObject({ kind: 'pair', status: 'open', runKey: 'a1+b1' });
    expect(s.inbox('b').filter(row => row.kind === 'conflict' && !row.delivered).at(-1)!.message).toContain('The combined check now fails');
    expect(s.h.db.agentData.name.find('b')?.status).toBe('red');
  });

  it('a second request flagging the same pair adds to the open thread instead of opening another', () => {
    const s = setup(); const id = open(s);
    s.ask({ tasks: [sessionsTask], reviews: [], conflicts: [{ ...overlap, topic: 'session timeout unit' }] });
    expect(s.conflicts()).toHaveLength(1);
    expect(s.thread(id)).toEqual([['orchestrator', 'message'], ['orchestrator', 'message']]);
    for (const agent of ['a', 'b']) expect(s.inbox(agent).filter(row => row.kind === 'message')).toMatchObject([{ conflictId: id, delivered: false }]);
  });

  it('reset clears requests, tasks, reviews, messages and plan steps', () => {
    const s = setup(); open(s);
    s.ask({ tasks: [lastLoginTask], reviews: [{ reviewer: 'b', summary: 'x' }], conflicts: [] });
    s.as(ctx => module.add_plan_step(ctx, { requestId: 1, kind: 'status', detail: 'x' }));
    s.tx(s.owner, ctx => module.reset_all(ctx, {}));
    for (const table of [s.h.db.requestData, s.h.db.taskData, s.h.db.reviewData, s.h.db.messageData, s.h.db.planStepData]) {
      expect(table.count()).toBe(0n);
    }
  });
});
