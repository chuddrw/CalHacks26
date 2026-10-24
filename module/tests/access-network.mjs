/** WHAT IT'S FOR: local-only HTTP/WebSocket permission and revocation integration proof.
 * Requires an isolated server at 127.0.0.1:4301. Creates its own development identities in memory,
 * publishes only cowork-access-check locally, and never reads or prints user credentials.
 * Run via `npm run test:access-network --prefix module` with SPACETIME_CLI set if needed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const host = 'http://127.0.0.1:4301';
const database = 'cowork-access-check';
const modulePath = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'cowork-access-client-'));
const sockets = [];
async function identity() {
  const response = await fetch(host + '/v1/identity', { method: 'POST' });
  assert.ok(response.ok);
  return response.json();
}
async function call(user, reducer, args) {
  return fetch(`${host}/v1/database/${database}/call/${reducer}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    body: JSON.stringify(args), signal: AbortSignal.timeout(5000),
  });
}
async function ok(user, reducer, args) {
  const response = await call(user, reducer, args);
  assert.ok(response.ok, `${reducer} should succeed; status ${response.status}: ${await response.text()}`);
}
async function sql(user, query) {
  return fetch(`${host}/v1/database/${database}/sql`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    body: query, signal: AbortSignal.timeout(5000),
  });
}
async function until(check, message) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
try {
  const [owner, reader, editor, outsider] = await Promise.all([identity(), identity(), identity(), identity()]);
  const publish = spawnSync(process.env.SPACETIME_CLI || 'spacetime', [
    'publish', database, '--module-path', modulePath, '--server', host, '--anonymous',
    '--delete-data=never', '--yes=remote,skip-login,break-clients',
  ], { encoding: 'utf8', env: { ...process.env, ACCESS_OWNER_IDENTITY: owner.identity }, timeout: 30000 });
  assert.equal(publish.status, 0, `Local publish failed: ${publish.stderr}`);
  await ok(owner, 'reset_all', []);
  await ok(owner, 'grant_access', [reader.identity, 'reader']);
  await ok(owner, 'grant_access', [editor.identity, 'editor']);
  await ok(editor, 'post_snapshot', ['a', 'local-sha', 'local-base', ['src/a.ts'], 'private fixture diff']);
  for (const user of [null, outsider]) {
    assert.ok(!(await sql(user, 'SELECT * FROM snapshot')).ok, 'unapproved HTTP read must fail');
    assert.ok(!(await call(user, 'post_intent', ['a', 'not allowed', [], []])).ok, 'unapproved HTTP write must fail');
  }
  const read = await sql(reader, 'SELECT * FROM snapshot');
  assert.ok(read.ok, 'Reader HTTP query');
  assert.equal((await read.json())[0].rows.length, 1);
  assert.ok(!(await sql(reader, 'SELECT * FROM snapshot_data')).ok, 'Reader cannot query private backing table');
  assert.ok(!(await call(reader, 'post_intent', ['a', 'not allowed', [], []])).ok, 'Reader cannot mutate');
  assert.ok(!(await call(editor, 'grant_access', [outsider.identity, 'editor'])).ok, 'Editor cannot approve membership');
  assert.ok(!(await call(editor, 'reset_all', [])).ok, 'Editor cannot reset');

  cpSync(fileURLToPath(new URL('../../shared/module_bindings', import.meta.url)), path.join(temporary, 'bindings'), { recursive: true });
  symlinkSync(path.join(modulePath, 'node_modules'), path.join(temporary, 'node_modules'), 'dir');
  const { DbConnection } = await import(pathToFileURL(path.join(temporary, 'bindings/index.ts')).href);
  async function connect(user, expectDenied = false) {
    let connection;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection?.disconnect(); reject(new Error('WebSocket connection timed out')); }, 8000);
      connection = DbConnection.builder().withUri(host).withDatabaseName(database).withToken(user?.token)
        .onConnect(conn => { clearTimeout(timer); expectDenied ? reject(new Error('Unapproved WebSocket was accepted')) : resolve(conn); })
        .onConnectError(() => { clearTimeout(timer); expectDenied ? resolve(null) : reject(new Error('Approved WebSocket rejected')); })
        .build();
      sockets.push(connection);
    });
  }
  await connect(outsider, true);
  const connection = await connect(reader);
  await new Promise((resolve, reject) => {
    connection.subscriptionBuilder().onApplied(resolve).onError(() => reject(new Error('Reader subscription failed'))).subscribe(['SELECT * FROM snapshot']);
  });
  assert.equal([...connection.db.snapshot.iter()].length, 1);
  await assert.rejects(connection.reducers.postIntent({agent:'a',summary:'reader denied',files:[],symbols:[]}));
  await ok(owner, 'grant_access', [reader.identity, 'editor']);
  await connection.reducers.postIntent({agent:'a',summary:'promoted editor',files:[],symbols:[]});
  await ok(owner, 'grant_access', [reader.identity, 'reader']);
  await assert.rejects(connection.reducers.postIntent({agent:'a',summary:'downgraded denied',files:[],symbols:[]}));
  await ok(owner, 'revoke_access', [reader.identity]);
  await until(() => [...connection.db.snapshot.iter()].length === 0, 'revocation must delete rows from an existing subscription');
  await assert.rejects(connection.reducers.postIntent({agent:'a',summary:'revoked denied',files:[],symbols:[]}));
  assert.ok(!(await sql(reader, 'SELECT * FROM snapshot')).ok, 'revoked fresh HTTP read denied');
  await ok(owner, 'reset_all', []);
  await ok(editor, 'post_intent', ['a', 'membership survives reset', [], []]);
  await ok(owner, 'reset_all', []);
  await ok(owner, 'revoke_access', [editor.identity]);
  console.log('PASS: real HTTP and WebSocket Reader/Editor/Owner guards, private backing data, owner-only approvals, live promotion/downgrade/revocation, and preserved reset membership.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local access integration test failed');
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.disconnect();
  rmSync(temporary, { recursive: true, force: true });
}
