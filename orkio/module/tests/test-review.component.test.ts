/**
 * WHAT IT'S FOR: review_test_change, a person's answer to a needs_human conflict (the fix changed
 * existing tests). Approve resolves only on a current green check; reject reopens the conflict,
 * wakes the fixer, and blocks every resolution until the fixer posts a newer snapshot.
 */
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import db, * as module from '../src/index';
import { seedRedConflict, reportCurrentGreen } from './state-fixture';

type Ctx = Parameters<typeof module.post_snapshot>[0];
const pair = {
  kind: 'pair', agentA: 'a', agentB: 'b', locA: 'src/user.ts:4', locB: 'src/idle.ts:8',
  error: 'expected elapsed minutes, received milliseconds', fixer: 'b', runKey: 'a1+b1',
};
function caller(subject: string, connection: bigint) {
  return TestAuth.fromJwtPayload(JSON.stringify({ iss: 'cowork-test-review', sub: subject }), new ConnectionId(connection));
}
function setup() {
  const h = createModuleTestHarness(db, module);
  h.clock.set(new Timestamp(1_700_000_000_123_000n));
  const owner = caller('owner', 1n);
  const editor = caller('editor', 2n);
  const reader = caller('reader', 3n);
  const identity = (who: TestAuth) => h.viewContext(who).sender;
  const ownerHex = identity(owner).toHexString();
  const env = { ACCESS_OWNER_IDENTITY: ownerHex, get: (() => ownerHex) as Ctx['env']['get'] };
  const tx = <T>(who: TestAuth, body: (ctx: Ctx) => T) => h.withReducerTx(who, ctx => body({
    ...ctx, databaseIdentity: ctx.databaseIdentity, identity: ctx.identity, senderAuth: ctx.senderAuth, env,
  }));
  tx(owner, ctx => {
    module.grant_access(ctx, { identity: identity(editor).toHexString(), role: 'editor' });
    module.grant_access(ctx, { identity: identity(reader).toHexString(), role: 'reader' });
  });
  /** A conflict whose fixer b then changed tests (snapshot b2) and got flagged; b2 checks green. */
  const flagged = () => {
    tx(editor, ctx => seedRedConflict(ctx, pair));
    const conflict = [...h.db.conflictData.iter()][0]!;
    tx(editor, ctx => {
      module.post_snapshot(ctx, { agent: 'b', sha: 'b2', baseSha: 'base', files: ['src/idle.test.ts'], diff: 'test edit' });
      module.flag_needs_human(ctx, { conflictId: conflict.id, reason: 'The fix changed tests: src/idle.test.ts' });
      reportCurrentGreen(ctx, conflict.id);
    });
    return conflict.id;
  };
  const status = (id: number) => h.db.conflictData.id.find(id)?.status;
  const notesFor = (agent: string) => [...h.db.inboxData.iter()].filter(row => row.agent === agent);
  return { h, owner, editor, reader, tx, flagged, status, notesFor };
}

describe('review_test_change', () => {
  it('approve resolves a flagged conflict on a current green check, tells both agents, and publishes no fact', () => {
    const s = setup(); const id = s.flagged();
    const factsBefore = [...s.h.db.intentData.iter()].filter(row => row.verified).length;
    s.tx(s.editor, ctx => module.review_test_change(ctx, { conflictId: id, approve: true, comment: 'the old test assumed seconds' }));
    expect(s.status(id)).toBe('resolved');
    for (const agent of ['a', 'b']) {
      const last = s.notesFor(agent).at(-1)!;
      expect(last).toMatchObject({ kind: 'info', conflictId: id, delivered: false });
      expect(last.message).toContain('approved the test change');
      expect(last.message).toContain('the old test assumed seconds');
    }
    expect([...s.h.db.intentData.iter()].filter(row => row.verified)).toHaveLength(factsBefore);
    expect(s.h.db.escalation_timer.count()).toBe(0n);
    expect(s.h.db.agentData.name.find('b')?.status).toBe('green');
  });

  it('approve refuses while the combined check is red, and changes nothing', () => {
    const s = setup(); const id = s.flagged();
    s.tx(s.editor, ctx => module.post_snapshot(ctx, { agent: 'b', sha: 'b3', baseSha: 'base', files: [], diff: '' }));
    const inboxBefore = [...s.h.db.inboxData.iter()];
    expect(() => s.tx(s.editor, ctx => module.review_test_change(ctx, { conflictId: id, approve: true, comment: '' }))).toThrow(/still red/);
    expect(s.status(id)).toBe('needs_human');
    expect([...s.h.db.inboxData.iter()]).toEqual(inboxBefore);
  });

  it('reject reopens the conflict and wakes the fixer with the reason', () => {
    const s = setup(); const id = s.flagged();
    s.tx(s.editor, ctx => module.review_test_change(ctx, { conflictId: id, approve: false, comment: 'keep the 31-minute test' }));
    expect(s.status(id)).toBe('open');
    const wake = s.notesFor('b').at(-1)!;
    expect(wake).toMatchObject({ kind: 'conflict', conflictId: id, delivered: false });
    expect(wake.message).toContain('sent your fix for conflict');
    expect(wake.message).toContain('keep the 31-minute test');
    expect(s.notesFor('a').at(-1)!.message).toContain("b's test change back");
    expect(s.h.db.testReview.conflictId.find(id)?.snapshotId).toBe([...s.h.db.snapshotData.iter()].at(-1)!.id);
    expect([...s.h.db.escalation_timer.iter()].filter(timer => timer.conflictId === id)).toHaveLength(1);
  });

  it('after reject, the old green check resolves nothing until the fixer posts a newer snapshot', () => {
    const s = setup(); const id = s.flagged();
    s.tx(s.editor, ctx => module.review_test_change(ctx, { conflictId: id, approve: false, comment: '' }));
    const row = s.h.db.conflictData.id.find(id)!;
    s.tx(s.editor, ctx => {
      const green = reportCurrentGreen(ctx, id);
      module.resolve_conflict(ctx, { conflictId: id, verifiedFact: '' });
      module.resolve_conflict_if_current(ctx, { conflictId: id, expectedRunKey: row.runKey, expectedError: row.error,
        expectedFixer: row.fixer, verifiedRunKey: green, verifiedFact: '' });
    });
    expect(s.status(id)).toBe('open');

    s.tx(s.editor, ctx => {
      module.post_snapshot(ctx, { agent: 'b', sha: 'b4', baseSha: 'base', files: ['src/idle.ts'], diff: 'real fix' });
      const green = reportCurrentGreen(ctx, id);
      module.resolve_conflict_if_current(ctx, { conflictId: id, expectedRunKey: row.runKey, expectedError: row.error,
        expectedFixer: row.fixer, verifiedRunKey: green, verifiedFact: 'User.lastLogin is milliseconds' });
    });
    expect(s.status(id)).toBe('resolved');
    expect(s.h.db.testReview.count()).toBe(0n);
  });

  it('only a needs_human conflict can be reviewed, and only by an editor', () => {
    const s = setup();
    s.tx(s.editor, ctx => seedRedConflict(ctx, pair));
    const id = [...s.h.db.conflictData.iter()][0]!.id;
    expect(() => s.tx(s.editor, ctx => module.review_test_change(ctx, { conflictId: id, approve: false, comment: '' }))).toThrow(/not waiting/);
    expect(() => s.tx(s.editor, ctx => module.review_test_change(ctx, { conflictId: 999, approve: true, comment: '' }))).toThrow(/Unknown conflict/);
    const flaggedId = (() => {
      s.tx(s.editor, ctx => module.flag_needs_human(ctx, { conflictId: id, reason: 'tests changed' }));
      return id;
    })();
    expect(() => s.tx(s.reader, ctx => module.review_test_change(ctx, { conflictId: flaggedId, approve: false, comment: '' }))).toThrow(/Editor access/);
    expect(s.status(flaggedId)).toBe('needs_human');
  });

  it('reset_all clears stored reviews', () => {
    const s = setup(); const id = s.flagged();
    s.tx(s.editor, ctx => module.review_test_change(ctx, { conflictId: id, approve: false, comment: '' }));
    expect(s.h.db.testReview.count()).toBe(1n);
    s.tx(s.owner, ctx => module.reset_all(ctx, {}));
    expect(s.h.db.testReview.count()).toBe(0n);
  });
});
