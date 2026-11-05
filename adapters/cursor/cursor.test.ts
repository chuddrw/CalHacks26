/**
 * adapters/cursor/cursor.test.ts
 *
 * WHAT IT'S FOR
 *   Tests for the Cursor adapter: hooks.json / mcp.json merging (idempotent, keeps unrelated entries,
 *   never duplicates ours), the Cursor output translation, and the hook process always printing one
 *   valid JSON object without echoing its input. No network: hooks run with publishing disabled.
 * RUN: node --import tsx --test adapters/cursor/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CURSOR_EVENTS, mergeCursorHooks } from './install.ts';
import { cursorResponse, minimalResponse, stopHookActive, workspaceOf } from './hook.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OURS = `'/usr/bin/node' '/o/node_modules/tsx/dist/cli.mjs' '/o/adapters/cursor/hook.ts'`;

test('hooks.json merge keeps unrelated entries and keys, and is idempotent', () => {
  const existing = { version: 1, extra: true, hooks: {
    stop: [{ command: './audit.sh' }],
    beforeShellExecution: [{ command: 'guard', matcher: 'rm' }],
  } };
  const once = mergeCursorHooks(existing, OURS);
  assert.equal(once.extra, true);
  assert.equal(once.version, 1);
  assert.deepEqual(once.hooks.beforeShellExecution, [{ command: 'guard', matcher: 'rm' }]);
  assert.deepEqual(once.hooks.stop, [{ command: './audit.sh' }, { command: OURS, timeout: 45 }]);
  assert.deepEqual(Object.keys(once.hooks).sort(), [...Object.keys(CURSOR_EVENTS), 'beforeShellExecution'].sort());
  assert.deepEqual(mergeCursorHooks(once, OURS), once);
});

test('hooks.json merge replaces entries from an older install path instead of duplicating', () => {
  const old = mergeCursorHooks({}, `'/old/node' 'C:\\old\\adapters\\cursor\\hook.ts'`);
  const moved = mergeCursorHooks(old, OURS);
  for (const event of Object.keys(CURSOR_EVENTS)) assert.deepEqual(moved.hooks[event].map((e: any) => e.command), [OURS]);
});

test('hooks.json from scratch gets version 1', () => {
  assert.equal(mergeCursorHooks({}, OURS).version, 1);
});

test('Cursor responses use only fields Cursor documents for each event', () => {
  assert.deepEqual(cursorResponse('sessionStart', { context: 'team' }), { additional_context: 'team' });
  assert.deepEqual(cursorResponse('postToolUse', { context: 'notes' }), { additional_context: 'notes' });
  assert.deepEqual(cursorResponse('stop', { block: 'reply to b' }), { followup_message: 'reply to b' });
  assert.deepEqual(cursorResponse('beforeSubmitPrompt', { context: 'x', block: 'y' }), { continue: true });
  assert.deepEqual(cursorResponse('afterFileEdit', { context: 'x' }), {});
  assert.deepEqual(cursorResponse('stop', {}), {});
  assert.deepEqual(minimalResponse(undefined), {});
});

test('stop follow-ups only after a completed turn that is not already a follow-up', () => {
  assert.equal(stopHookActive({ status: 'completed', loop_count: 0 }), false);
  assert.equal(stopHookActive({ status: 'completed', loop_count: 1 }), true);
  assert.equal(stopHookActive({ status: 'aborted', loop_count: 0 }), true);
  assert.equal(stopHookActive({}), true);
});

test('workspace comes from cwd, then workspace_roots', () => {
  assert.equal(workspaceOf({ cwd: '/a', workspace_roots: ['/b'] }), '/a');
  assert.equal(workspaceOf({ workspace_roots: [5, '/b'] }), '/b');
});

test('hook process prints exactly one valid JSON object for every event and bad input, never echoing it', () => {
  const inputs = ['', 'not json', '[]',
    ...['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'afterFileEdit', 'afterShellExecution', 'stop', 'unknownEvent']
      .map(event => JSON.stringify({ hook_event_name: event, workspace_roots: [ROOT], prompt: 'private-test-value', status: 'completed' }))];
  for (const input of inputs) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'adapters/cursor/hook.ts'], {
      cwd: ROOT, encoding: 'utf8', input, timeout: 30000, env: { ...process.env, COWORK_NAME: '', STDB_DB: '' },
    });
    assert.equal(result.status, 0, input);
    const output = JSON.parse(result.stdout);
    assert.equal(typeof output, 'object');
    assert.ok(!result.stdout.includes('private-test-value'));
    if (input.includes('beforeSubmitPrompt')) assert.deepEqual(output, { continue: true });
    else assert.deepEqual(output, {});
  }
});
