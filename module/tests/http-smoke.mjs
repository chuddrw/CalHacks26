/** WHAT IT'S FOR: exercise Part C through the unchanged shared HTTP interface on an isolated local test server.
 * Requires a freshly published cowork-part-c-check database on localhost:4301; clears that test database.
 */
import assert from 'node:assert/strict';
const host = 'http://127.0.0.1:4301';
const identity = await fetch(host + '/v1/identity', { method: 'POST' });
assert.ok(identity.ok, 'temporary identity');
const { token } = await identity.json();
process.env.STDB_HOST = host;
process.env.STDB_DB = 'cowork-part-c-check';
process.env.STDB_TOKEN = token;
const { callReducer: call, selectRows: rows } = await import('../../shared/src/stdb-http.ts');
await call('reset_all', []);
await call('post_snapshot', ['a', 'aaa', 'base', ['src/user.ts'], 'diff a']);
await call('post_snapshot', ['b', 'bbb', 'base', ['src/idle.ts'], 'diff b']);
await call('post_intent', ['a', 'Store milliseconds', ['src/user.ts'], ['User.lastLogin']]);
await call('report_check', ['aaa+bbb', ['a', 'b'], 'red', 'unit mismatch']);
await call('report_conflict', ['pair', 'a', 'b', 'src/user.ts:1', 'src/idle.test.ts:5', 'unit mismatch', 'b', 'aaa+bbb']);
const [conflict] = await rows('conflict');
assert.equal(typeof conflict.id, 'number');
assert.equal(typeof conflict.createdAt, 'number');
assert.equal(conflict.fixer, 'b');
await call('add_diagnosis_step', [conflict.id, 'droid', 'status', 'test']);
await call('mark_delivered', [[(await rows('inbox', "agent = 'b' AND kind = 'conflict' AND delivered = false"))[0].id]]);
await call('set_explanation', [conflict.id, 'lastLogin uses milliseconds']);
assert.equal((await rows('inbox', "agent = 'b' AND kind = 'info'")).length, 1);
await call('report_check', ['aaa+fixed', ['a', 'b'], 'green', 'passed']);
assert.ok((await rows('agent')).every(row => row.status === 'red'));
await call('resolve_conflict', [conflict.id, 'User.lastLogin is milliseconds']);
assert.ok((await rows('agent')).every(row => row.status === 'green'));
assert.equal((await rows('intent', 'verified = true')).length, 1);
for (const table of ['agent', 'snapshot', 'intent', 'check_run', 'conflict', 'inbox', 'diagnosis_step']) {
  const result = await rows(table);
  assert.ok(result.length > 0, table);
}
assert.equal((await rows('agent', 'lastSnapshotAt > 0')).length, 2);
await call('reset_all', []);
assert.equal((await rows('agent')).length, 0);
console.log('PASS: real SpacetimeDB 2.13 HTTP reducers, all seven tables, numeric fields, camelCase WHERE clauses, explanation delivery, green resolution and reset');
