/**
 * adapters/core/core.test.ts
 *
 * WHAT IT'S FOR
 *   Unit tests for the adapter-agnostic core: publication retry and reset recovery, the quiet-period
 *   Done rule, lock recovery, CLI argument validation, install helpers, and the CLI's error contract
 *   (non-zero exit, generic stderr, nothing on stdout). No network: side effects are injected, and
 *   subprocess tests run with publishing disabled in throwaway Git repos.
 * RUN: node --import tsx --test adapters/core/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from '../../shared/src/git.ts';
import type { Snapshot } from '../../hooks/src/lib/snapshot.ts';
import { defaultIntent, publishWork, quietStep, type Publication, type PublicationDeps, type QuietState } from './publication.ts';
import { acquireLock, adapterFrom, doneSummary, markDone, UsageError } from './runtime.ts';
import { claimPidFile, parseCli } from './cli.ts';
import { excludePatterns, hookCommand, mcpServerEntry, readJsonFile, withMcpServer } from './install.ts';
import { parseClaudeOutput } from './hook-bridge.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const snapshot: Snapshot = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), files: ['game/server.ts'], diff: '+hello' };

function setup(next: Snapshot | null = snapshot) {
  let stored: Publication = {};
  const snapshots: string[] = [];
  const intents: string[] = [];
  const deps: PublicationDeps = {
    snapshot: async () => { const value = next; next = null; return value; },
    read: () => structuredClone(stored),
    write: state => { stored = structuredClone(state); },
    reportSnapshot: async value => { snapshots.push(value.sha); },
    reportIntent: async summary => { intents.push(summary); },
  };
  return { deps, snapshots, intents, stored: () => stored };
}

async function tempDir(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orkio-core-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('publishes once with the adapter label as default intent, then skips unchanged work', async () => {
  const s = setup();
  assert.deepEqual(await publishWork(s.deps, 'Cursor'), { published: true, sha: snapshot.sha });
  assert.deepEqual(s.intents, ['Cursor editing game/server.ts']);
  assert.deepEqual(await publishWork(s.deps, 'Cursor'), { published: false, sha: snapshot.sha });
  assert.equal(s.snapshots.length, 1);
});

test('sha is null (not undefined) before anything was published', async () => {
  assert.deepEqual(await publishWork(setup(null).deps, 'Gemini CLI'), { published: false, sha: null });
});

test('default intent names at most four files', () => {
  assert.equal(defaultIntent('Gemini CLI', ['a', 'b', 'c', 'd', 'e', 'f']), 'Gemini CLI editing a, b, c, d and 2 more files');
});

test('a database failure after Git push leaves a durable pending snapshot that is retried', async () => {
  const s = setup();
  const original = s.deps.reportSnapshot;
  s.deps.reportSnapshot = async () => { throw new Error('offline'); };
  await assert.rejects(publishWork(s.deps, 'Cursor'), /offline/);
  assert.equal(s.stored().pending?.snapshot.sha, snapshot.sha);
  s.deps.reportSnapshot = original;
  assert.equal((await publishWork(s.deps, 'Cursor')).published, true);
  assert.deepEqual(s.snapshots, [snapshot.sha]);
  assert.equal(s.intents.length, 1);
  assert.equal(s.stored().pending, undefined);
});

test('an intent failure retries only the intent, not the snapshot row', async () => {
  const s = setup();
  const original = s.deps.reportIntent;
  s.deps.reportIntent = async () => { throw new Error('offline'); };
  await assert.rejects(publishWork(s.deps, 'Cursor'), /offline/);
  assert.equal(s.stored().pending?.snapshotReported, true);
  s.deps.reportIntent = original;
  await publishWork(s.deps, 'Cursor');
  assert.equal(s.snapshots.length, 1);
  assert.equal(s.intents.length, 1);
});

test('database reset recovery republishes the last snapshot without a new Git snapshot', async () => {
  const s = setup();
  await publishWork(s.deps, 'Cursor');
  await publishWork(s.deps, 'Cursor', undefined, true);
  assert.deepEqual(s.snapshots, [snapshot.sha, snapshot.sha]);
  assert.equal(s.intents.length, 2);
});

test('a changed intent alone re-reports the intent but not the snapshot', async () => {
  const s = setup();
  await publishWork(s.deps, 'Cursor');
  await publishWork(s.deps, 'Cursor', 'Build the scoreboard');
  assert.equal(s.snapshots.length, 1);
  assert.deepEqual(s.intents.at(-1), 'Build the scoreboard');
});

test('quiet rule marks Done once after N unchanged cycles; a new sha resets it; busy cycles are ignored', () => {
  let state: QuietState = { quietCycles: 0 };
  const done: string[] = [];
  const cycle = (result: Parameters<typeof quietStep>[1]) => {
    const step = quietStep(state, result, 3);
    if (step.done) done.push(step.done);
    state = step.state;
  };
  cycle({ published: true, sha: 'x' });
  cycle({ published: false, sha: null, busy: true });
  for (let i = 0; i < 5; i++) cycle({ published: false, sha: 'x' });
  assert.deepEqual(done, ['x']);
  cycle({ published: true, sha: 'y' });
  cycle({ published: false, sha: 'y' });
  cycle({ published: false, sha: 'y' });
  assert.deepEqual(done, ['x']);
  cycle({ published: false, sha: 'y' });
  assert.deepEqual(done, ['x', 'y']);
});

test('quiet rule retries Done when the caller does not commit the state (markDone failed)', () => {
  let state: QuietState = { observedSha: 'x', quietCycles: 0 };
  for (let i = 0; i < 2; i++) state = quietStep(state, { published: false, sha: 'x' }, 3).state;
  assert.equal(quietStep(state, { published: false, sha: 'x' }, 3).done, 'x');
  assert.equal(quietStep(state, { published: false, sha: 'x' }, 3).done, 'x');
});

test('lock: a live owner is respected, a dead owner is recovered, garbage counts as busy', async t => {
  const lock = path.join(await tempDir(t), 'state.json.lock');
  assert.equal(acquireLock(lock), true);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  assert.equal(acquireLock(lock, () => true), false);
  assert.equal(acquireLock(lock, () => 'unknown'), false);
  assert.equal(acquireLock(lock, () => false), true);
  await writeFile(lock, 'not-a-pid');
  assert.equal(acquireLock(lock, () => false), false);
});

test('CLI arguments: contract options parse; bad ids, commands and options are rejected', () => {
  const args = parseCli(['sync', '--adapter', 'cursor', '--cwd', 'x', '--intent', 'hi', '--force-report'], '/base');
  assert.deepEqual(args, { command: 'sync', adapter: { id: 'cursor', label: 'Cursor' }, cwd: '/base/x', intent: 'hi',
    forceReport: true, allowPublish: false, allowAutomatic: false });
  assert.equal(parseCli(['enable', '--adapter', 'vs-code', '--allow-publish', '--allow-automatic']).allowAutomatic, true);
  assert.equal(parseCli(['status', '--adapter', 'gemini', '--label', 'Gemini CLI']).adapter.label, 'Gemini CLI');
  assert.equal(parseCli(['publish', '--adapter', 'cursor']).command, 'publish');
  assert.throws(() => parseCli(['watch', '--adapter', 'cursor']), UsageError, 'old command name is gone');
  assert.equal(parseCli(['status', '--adapter', 'vs-code']).adapter.label, 'Vs Code');
  for (const bad of [[], ['sync'], ['sync', '--adapter', 'Cursor'], ['sync', '--adapter', '../x'], ['bogus', '--adapter', 'x'],
    ['sync', 'extra', '--adapter', 'x'], ['sync', '--adapter', 'x', '--token', 'y'], ['sync', '--adapter', 'a'.repeat(41)]]) {
    assert.throws(() => parseCli(bad), UsageError, JSON.stringify(bad));
  }
});

test('labels are stripped of control characters and capped', () => {
  assert.equal(adapterFrom('x', 'Evil\nLabel\u0007').label, 'EvilLabel');
  assert.equal(adapterFrom('x', 'L'.repeat(80)).label.length, 40);
});

test('exclude: appends once, is idempotent, and refuses adapter source', () => {
  const once = excludePatterns('# existing\n/.codex/hooks.json', ['/.cursor/mcp.json', '/.cursor/hooks.json'], 'Orkio');
  assert.equal(once, '# existing\n/.codex/hooks.json\n# Orkio\n/.cursor/mcp.json\n/.cursor/hooks.json\n');
  assert.equal(excludePatterns(once, ['/.cursor/mcp.json'], 'Orkio'), once);
  assert.equal(excludePatterns('', ['/a'], 'H'), '# H\n/a\n');
  assert.throws(() => excludePatterns('', ['/adapters/cursor/'], 'H'), UsageError);
  assert.throws(() => excludePatterns('', ['adapters'], 'H'), UsageError);
});

test('MCP entry is exec form with absolute paths; merging keeps other servers', () => {
  const entry = mcpServerEntry('/orkio', '/work space', '/usr/bin/node', '/orkio/node_modules/tsx/dist/cli.mjs');
  assert.deepEqual(entry, { command: '/usr/bin/node',
    args: ['/orkio/node_modules/tsx/dist/cli.mjs', '/orkio/adapters/core/mcp-launch.ts', '/work space'] });
  const merged = withMcpServer({ keep: 1, mcpServers: { other: { command: 'x' }, cowork: { command: 'old' } } }, 'cowork', entry);
  assert.deepEqual(merged, { keep: 1, mcpServers: { other: { command: 'x' }, cowork: entry } });
  assert.deepEqual(withMcpServer(merged, 'cowork', entry), merged);
});

test('hook commands single-quote every part, including quotes inside paths', () => {
  assert.equal(hookCommand('/n', "/it's", '/h.ts'), `'/n' '/it'\\''s' '/h.ts'`);
});

test('invalid JSON config files are refused rather than overwritten', async t => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, 'bad.json'), '{ nope');
  await writeFile(path.join(dir, 'list.json'), '[]');
  assert.deepEqual(readJsonFile(path.join(dir, 'missing.json')), {});
  assert.throws(() => readJsonFile(path.join(dir, 'bad.json')), UsageError);
  assert.throws(() => readJsonFile(path.join(dir, 'list.json')), UsageError);
});

test('Claude hook output parsing keeps only context and Stop blocks', () => {
  assert.deepEqual(parseClaudeOutput('{"hookSpecificOutput":{"hookEventName":"X","additionalContext":"notes"}}'), { context: 'notes' });
  assert.deepEqual(parseClaudeOutput('{"decision":"block","reason":"reply to b"}'), { block: 'reply to b' });
  for (const junk of ['', 'not json', 'null', '[]', '{"decision":"approve"}', '{"hookSpecificOutput":{"additionalContext":5}}']) {
    assert.deepEqual(parseClaudeOutput(junk), {}, junk);
  }
});

function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'adapters/core/cli.ts'), ...args, '--cwd', cwd], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, COWORK_NAME: 'core-test', STDB_DB: 'core-test-db', STDB_HOST: 'http://127.0.0.1:9',
      STDB_TOKEN: 'secret-test-token', ...env },
  });
}

test('CLI errors exit non-zero with a short stderr message and no secrets; consent gates hold', async t => {
  const repo = await tempDir(t);
  await git(repo, ['init']);
  const checks: Array<[string[], RegExp]> = [
    [['bogus', '--adapter', 'cursor'], /Usage/],
    [['sync', '--adapter', 'Bad_Id'], /--adapter must be/],
    [['sync', '--adapter', 'cursor'], /Publishing is disabled/],
    [['done', '--adapter', 'cursor'], /Publishing is disabled/],
    [['enable', '--adapter', 'cursor'], /--allow-publish/],
  ];
  for (const [args, message] of checks) {
    const result = cli(args, repo);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
    assert.ok(!result.stderr.includes('secret-test-token'));
  }
  // Manual consent allows sync but not the publisher.
  const enabled = cli(['enable', '--adapter', 'cursor', '--allow-publish'], repo);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.ok(existsSync(path.join(repo, '.git', 'cowork-cursor-publish-enabled.json')));
  const start = cli(['start', '--adapter', 'cursor'], repo);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /Automatic publishing is disabled/);
  // Consent is per adapter id.
  assert.match(cli(['sync', '--adapter', 'gemini'], repo).stderr, /Publishing is disabled/);
  // A different agent name invalidates consent.
  assert.match(cli(['sync', '--adapter', 'cursor'], repo, { COWORK_NAME: 'someone-else' }).stderr, /Publishing is disabled/);
  // Unreachable database after consent: a generic message, never the token or server output.
  const done = cli(['done', '--adapter', 'cursor'], repo);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /^Orkio adapter failed\./);
  assert.ok(!done.stderr.includes('secret-test-token'));
});

test('publisher PID file: a live owner is never displaced; a stale file is replaced; concurrent claims yield one winner', async t => {
  const dir = await tempDir(t);
  const adapter = adapterFrom('cursor');
  const file = path.join(dir, 'publisher.json');
  await writeFile(file, JSON.stringify({ adapter: 'orkio-cursor', pid: 999999 }));
  assert.equal(claimPidFile(file, adapter, () => 999999), false, 'live owner kept');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 999999);
  assert.equal(claimPidFile(file, adapter, () => undefined), true, 'stale file replaced');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
  // Second starter while the first (this process) holds the file and is live: it must back off.
  const owner = () => JSON.parse(readFileSync(file, 'utf8')).pid;
  assert.equal(claimPidFile(file, adapter, () => owner() === process.pid ? 4242 : undefined), false);
  assert.equal(owner(), process.pid, 'first claim survives');
  // Fresh file: exactly one of two back-to-back claims wins.
  const fresh = path.join(dir, 'fresh.json');
  const live = () => 4242;
  assert.deepEqual([claimPidFile(fresh, adapter, live), claimPidFile(fresh, adapter, live)], [true, false]);
});

test('Done summaries say they were not verified by a check', () => {
  assert.match(doneSummary('a'.repeat(40)), /^Done \(not verified by check_with_team\): snapshot aaaaaaaa/);
  assert.match(doneSummary('a'.repeat(40), true), /^Done \(idle; not verified by check_with_team\): /);
});

test('done (explicit and idle) posts only an intent and never calls report_check', async () => {
  for (const idle of [false, true]) {
    const calls: string[] = [];
    const summary = await markDone('c'.repeat(40), idle, async reducer => { calls.push(reducer); });
    assert.deepEqual(calls, ['post_intent']);
    assert.match(summary, /not verified by check_with_team/);
  }
  await assert.rejects(markDone('short', false, async () => assert.fail('must not post')), UsageError);
});

test('the CLI never reports a check on its own (green comes only from check_with_team)', () => {
  const sources = ['cli.ts', 'runtime.ts', 'publication.ts'].map(f => readFileSync(path.join(import.meta.dirname, f), 'utf8'));
  for (const source of sources) assert.ok(!/callReducer\(\s*'report_check'/.test(source));
});

test('CLI accepts --option=value forms', () => {
  const args = parseCli(['sync', '--adapter=python', '--intent=Fix = signs', '--label=Py Tool', '--cwd=/r']);
  assert.equal(args.adapter.id, 'python');
  assert.equal(args.adapter.label, 'Py Tool');
  assert.equal(args.intent, 'Fix = signs');
  assert.equal(args.cwd, '/r');
});
