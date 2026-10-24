/** WHAT IT'S FOR: Part C component tests for injected diagnosis coordination; no watcher/git/database clients. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosisRunner, type DiagnosisDependencies, type DiagnosisInput } from './index.ts';
import type { Diagnosis, DiagnosisContext } from './prompt.ts';

const answer: Diagnosis = { summary: 'Mismatch', cause: 'Unit mismatch', suggestion: 'Convert B', fact: 'lastLogin is milliseconds' };
function input(id = 1): DiagnosisInput {
  return {
    conflict: { id, pair: 'a+b', kind: 'pair', agentA: 'a', agentB: 'b', locA: 'a.ts:1', locB: 'b.ts:1', error: 'units', explanation: '', fixer: 'b', status: 'open', runKey: 'x+y', createdAt: 1, resolvedAt: 0 },
    sides: [{ agent: 'a', intent: 'intent', files: ['a.ts'], diff: 'original diff' }], failingOutput: 'original failure',
  };
}
function fixture(overrides: Partial<DiagnosisDependencies> = {}) {
  const steps: Parameters<DiagnosisDependencies['addDiagnosisStep']>[] = [];
  const explanations: Array<[number, string]> = [];
  const publications: Parameters<DiagnosisDependencies['setExplanationIfCurrent']>[] = [];
  const cleanups: number[] = [];
  let acquired = 0;
  const runner = createDiagnosisRunner({
    mode: 'claude', isCurrent: () => true,
    acquireWorktree: async ctx => { acquired++; return { path: `/tmp/diagnosis-${ctx.conflict.id}`, cleanup: async () => { cleanups.push(ctx.conflict.id); } }; },
    addDiagnosisStep: async (...args) => { steps.push(args); },
    setExplanationIfCurrent: async (...args) => { publications.push(args); explanations.push([args[0], args[4]]); },
    droid: async () => { throw new Error('Droid should not be started'); },
    claude: async () => answer,
    ...overrides,
  });
  return { runner, steps, explanations, publications, cleanups, acquired: () => acquired };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

test('Claude-only component publishes summary/cause/suggestion while returning an unverified fact separately', async () => {
  let droidCalled = false;
  const f = fixture({ droid: async () => { droidCalled = true; return answer; } });
  assert.deepEqual(await f.runner.diagnose(input()), answer);
  assert.equal(droidCalled, false);
  assert.deepEqual(f.explanations, [[1, 'Mismatch\n\nUnit mismatch\n\nConvert B']]);
  assert.deepEqual(f.publications, [[1, 'x+y', 'units', 'b', 'Mismatch\n\nUnit mismatch\n\nConvert B']]);
  assert.ok(!f.explanations[0]![1].includes(answer.fact));
  assert.ok(f.steps.every(row => row[1] === 'claude'));
  assert.deepEqual(f.cleanups, [1]);
});

test('stale input avoids worktree acquisition and model calls entirely', async () => {
  let called = false;
  const f = fixture({ isCurrent: () => false, claude: async () => { called = true; return answer; } });
  assert.equal(await f.runner.diagnose(input()), null);
  assert.equal(f.acquired(), 0);
  assert.equal(called, false);
  assert.deepEqual(f.steps, []);
  assert.deepEqual(f.explanations, []);
});

test('current-state changes during a model call suppress late final/explanation/fact but still release the lease', async () => {
  let current = true;
  const entered = deferred<void>();
  const gate = deferred<Diagnosis>();
  const f = fixture({ isCurrent: () => current, claude: async () => { entered.resolve(); return gate.promise; } });
  const pending = f.runner.diagnose(input());
  await entered.promise;
  current = false;
  gate.resolve(answer);
  assert.equal(await pending, null);
  assert.deepEqual(f.explanations, []);
  assert.ok(f.steps.every(row => row[2] !== 'final'));
  assert.deepEqual(f.cleanups, [1]);
});

test('independent conflict IDs diagnose concurrently and clean their own leases', async () => {
  const bothEntered = deferred<void>();
  const release = deferred<Diagnosis>();
  const ids: number[] = [];
  const f = fixture({ claude: async ctx => { ids.push(ctx.conflict.id); if (ids.length === 2) bothEntered.resolve(); return release.promise; } });
  const first = f.runner.diagnose(input(1));
  const second = f.runner.diagnose(input(2));
  await bothEntered.promise;
  assert.deepEqual(ids.sort(), [1, 2]);
  release.resolve(answer);
  assert.deepEqual(await Promise.all([first, second]), [answer, answer]);
  assert.deepEqual(f.cleanups.sort(), [1, 2]);
  assert.deepEqual(f.explanations.map(row => row[0]).sort(), [1, 2]);
});

test('input rows and nested sides are snapshotted before asynchronous work starts', async () => {
  let observed!: DiagnosisContext;
  const f = fixture({ claude: async ctx => { observed = structuredClone(ctx); return answer; } });
  const original = input();
  const pending = f.runner.diagnose(original);
  original.conflict.fixer = 'a'; original.conflict.error = 'mutated';
  original.sides[0]!.files.push('mutated.ts'); original.sides[0]!.diff = 'mutated diff';
  original.failingOutput = 'mutated output';
  await pending;
  assert.equal(observed.conflict.fixer, 'b');
  assert.equal(observed.conflict.error, 'units');
  assert.deepEqual(observed.sides[0]!.files, ['a.ts']);
  assert.equal(observed.sides[0]!.diff, 'original diff');
  assert.equal(observed.failingOutput, 'original failure');
  assert.equal(observed.worktree, '/tmp/diagnosis-1');
});

test('worktree acquisition rejection propagates without calling a model or publishing', async () => {
  let called = false;
  const f = fixture({ acquireWorktree: async () => { throw new Error('merge worktree failed'); }, claude: async () => { called = true; return answer; } });
  await assert.rejects(f.runner.diagnose(input()), /merge worktree failed/);
  assert.equal(called, false);
  assert.deepEqual(f.explanations, []);
  assert.deepEqual(f.cleanups, []);
});

test('explanation publication rejection still releases its lease and rejects instead of returning a fact', async () => {
  const f = fixture({ setExplanationIfCurrent: async () => { throw new Error('publication failed'); } });
  await assert.rejects(f.runner.diagnose(input()), /publication failed/);
  assert.deepEqual(f.cleanups, [1]);
});

test('lease cleanup rejection propagates to the caller even after successful publication', async () => {
  let attempts = 0;
  const f = fixture({ acquireWorktree: async () => ({ path: '/tmp/owned', cleanup: async () => { attempts++; throw new Error('cleanup failed'); } }) });
  await assert.rejects(f.runner.diagnose(input()), /cleanup failed/);
  assert.equal(attempts, 1);
  assert.equal(f.explanations.length, 1);
});

test('invalidation permits a fresh same-error attempt after prior cleanup', async () => {
  const f = fixture();
  await f.runner.diagnose(input());
  f.runner.invalidate(1);
  assert.deepEqual(await f.runner.diagnose(input()), answer);
  assert.equal(f.acquired(), 2);
  assert.deepEqual(f.cleanups, [1, 1]);
});

test('step flood is bounded at 500 writes while final explanation and cleanup still complete', async t => {
  let clock = 1_000_000;
  // Advance logical wall time between reads so this budget test never waits 100 real seconds.
  t.mock.method(Date, 'now', () => { clock += 200; return clock; });
  const f = fixture({ mode: 'droid', droid: async (_ctx, onStep) => { for (let i = 0; i < 1000; i++) onStep('tool_result', `step-${i}`); return answer; } });
  assert.deepEqual(await f.runner.diagnose(input()), answer);
  assert.equal(f.steps.length, 500);
  assert.equal(f.explanations.length, 1);
  assert.deepEqual(f.cleanups, [1]);
});

test('guarded publication carries its exact version and rejects a delayed write after supersession', async () => {
  const writeEntered = deferred<void>();
  const releaseWrite = deferred<void>();
  const database = { runKey: 'x+y', error: 'units', fixer: 'b', explanation: '' };
  const attempted: Parameters<DiagnosisDependencies['setExplanationIfCurrent']>[] = [];
  const f = fixture({
    isCurrent: ctx => ctx.conflict.runKey === database.runKey && ctx.conflict.error === database.error && ctx.conflict.fixer === database.fixer,
    setExplanationIfCurrent: async (...args) => {
      attempted.push(args);
      writeEntered.resolve();
      await releaseWrite.promise;
      // Model the reducer's atomic comparison at commit time, not before network transit.
      if (database.runKey === args[1] && database.error === args[2] && database.fixer === args[3]) database.explanation = args[4];
    },
  });
  const pending = f.runner.diagnose(input());
  await writeEntered.promise;
  database.runKey = 'superseding-run'; database.error = 'new error'; database.fixer = 'a';
  releaseWrite.resolve();
  assert.equal(await pending, null);
  assert.equal(database.explanation, '');
  assert.deepEqual(attempted, [[1, 'x+y', 'units', 'b', 'Mismatch\n\nUnit mismatch\n\nConvert B']]);
  assert.deepEqual(f.cleanups, [1]);
});

for (const stage of ['acquisition', 'step publication', 'explanation publication'] as const) {
  test(`transient ${stage} rejection permits a same-error retry without manual invalidation`, async t => {
    let clock = 1_000_000;
    t.mock.method(Date, 'now', () => { clock += 200; return clock; });
    let attempts = 0;
    let cleaned = 0;
    const overrides: Partial<DiagnosisDependencies> = stage === 'acquisition'
      ? { acquireWorktree: async () => { if (++attempts === 1) throw new Error('temporary failure'); return { path: '/tmp/retry', cleanup: async () => { cleaned++; } }; } }
      : stage === 'step publication'
        ? { addDiagnosisStep: async () => { if (++attempts === 1) throw new Error('temporary failure'); } }
        : { setExplanationIfCurrent: async () => { if (++attempts === 1) throw new Error('temporary failure'); } };
    const f = fixture(overrides);
    await assert.rejects(f.runner.diagnose(input()), /temporary failure/);
    assert.deepEqual(await f.runner.diagnose(input()), answer);
    assert.ok(attempts >= 2);
    if (stage === 'acquisition') assert.equal(cleaned, 1);
    else { assert.equal(f.acquired(), 2); assert.deepEqual(f.cleanups, [1, 1]); }
  });
}

test('provider unavailability permits a same-error retry but a successful retry remains deduplicated', async t => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => { clock += 200; return clock; });
  let calls = 0;
  const f = fixture({ claude: async () => ++calls === 1 ? null : answer });
  assert.equal(await f.runner.diagnose(input()), null);
  assert.deepEqual(await f.runner.diagnose(input()), answer);
  assert.deepEqual(await f.runner.diagnose(input()), answer);
  assert.equal(calls, 2);
  assert.equal(f.acquired(), 2);
});

test('an older failing attempt cannot invalidate a newer same-error replacement', async t => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => { clock += 200; return clock; });
  const started = deferred<void>();
  const rejectOld = deferred<void>();
  let calls = 0;
  const f = fixture({ acquireWorktree: async () => {
    if (++calls === 1) { started.resolve(); await rejectOld.promise; throw new Error('old acquisition failed'); }
    return { path: '/tmp/replacement', cleanup: async () => {} };
  } });
  const old = f.runner.diagnose(input());
  const oldRejected = assert.rejects(old, /old acquisition failed/);
  await started.promise;
  f.runner.invalidate(1);
  const replacement = f.runner.diagnose(input());
  rejectOld.resolve();
  await oldRejected;
  assert.deepEqual(await replacement, answer);
  assert.deepEqual(await f.runner.diagnose(input()), answer);
  assert.equal(calls, 2, 'new successful entry must remain deduplicated');
});
