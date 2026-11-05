/**
 * adapters/gemini/gemini.test.ts
 *
 * WHAT IT'S FOR
 *   Tests for the Gemini CLI adapter: settings.json merging (idempotent, keeps unrelated settings,
 *   servers and hooks, never duplicates ours), output translation to Gemini's hook schema, and the
 *   hook process always printing one valid JSON object without echoing its input. No network.
 * RUN: node --import tsx --test adapters/gemini/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GEMINI_EVENTS, mergeGeminiSettings } from './install.ts';
import { geminiResponse, workspaceOf } from './hook.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MCP = { command: '/usr/bin/node', args: ['/o/node_modules/tsx/dist/cli.mjs', '/o/adapters/core/mcp-launch.ts', '/w'] };
const OURS = `'/usr/bin/node' '/o/node_modules/tsx/dist/cli.mjs' '/o/adapters/gemini/hook.ts'`;

test('settings merge keeps unrelated settings, servers and hooks, and is idempotent', () => {
  const existing = {
    theme: 'dark', hooksConfig: { enabled: true },
    mcpServers: { github: { command: 'gh-mcp' } },
    hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'guard.sh' }] }],
      AfterAgent: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }] },
  };
  const once = mergeGeminiSettings(existing, MCP, '/w', OURS);
  assert.equal(once.theme, 'dark');
  assert.deepEqual(once.hooksConfig, { enabled: true });
  assert.deepEqual(once.mcpServers.github, { command: 'gh-mcp' });
  assert.deepEqual(once.mcpServers.cowork, { ...MCP, cwd: '/w' });
  assert.deepEqual(once.hooks.BeforeTool, existing.hooks.BeforeTool);
  assert.equal(once.hooks.AfterAgent.length, 2);
  assert.equal(once.hooks.AfterAgent[0].hooks[0].command, 'notify.sh');
  assert.deepEqual(once.hooks.AfterTool, [{ matcher: '*', hooks: [{ name: 'orkio-AfterTool', type: 'command', command: OURS,
    timeout: 10000, description: 'Orkio team coordination' }] }]);
  assert.deepEqual(mergeGeminiSettings(once, MCP, '/w', OURS), once);
});

test('a re-install from a moved repo replaces our hooks instead of duplicating them', () => {
  const old = mergeGeminiSettings({}, MCP, '/w', `'/old/node' '/old/adapters/gemini/hook.ts'`);
  const moved = mergeGeminiSettings(old, MCP, '/w', OURS);
  for (const event of Object.keys(GEMINI_EVENTS)) {
    assert.deepEqual(moved.hooks[event].flatMap((g: any) => g.hooks.map((h: any) => h.command)), [OURS]);
  }
});

test('a group mixing our hook with a user hook keeps the user hook', () => {
  const mixed = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'mine.sh' }, { type: 'command', command: OURS }] }] } };
  const merged = mergeGeminiSettings(mixed, MCP, '/w', OURS);
  assert.deepEqual(merged.hooks.SessionStart.map((g: any) => g.hooks.map((h: any) => h.command)), [['mine.sh'], [OURS]]);
});

test('Gemini responses follow its hook schema', () => {
  for (const event of ['SessionStart', 'BeforeAgent', 'AfterTool']) {
    assert.deepEqual(geminiResponse(event, { context: 'notes' }), { hookSpecificOutput: { hookEventName: event, additionalContext: 'notes' } });
  }
  assert.deepEqual(geminiResponse('AfterAgent', { block: 'reply to b' }), { decision: 'deny', reason: 'reply to b' });
  assert.deepEqual(geminiResponse('AfterAgent', { context: 'x' }), {});
  assert.deepEqual(geminiResponse('BeforeTool', { context: 'x', block: 'y' }), {});
  assert.deepEqual(geminiResponse(undefined, {}), {});
});

test('workspace comes from the hook input cwd', () => {
  assert.equal(workspaceOf({ cwd: '/a' }), '/a');
});

test('hook process prints exactly one valid JSON object for every event and bad input, never echoing it', () => {
  const inputs = ['', 'not json', '[]',
    ...['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent', 'UnknownEvent']
      .map(event => JSON.stringify({ hook_event_name: event, cwd: ROOT, prompt: 'private-test-value', tool_name: 'write_file' }))];
  for (const input of inputs) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'adapters/gemini/hook.ts'], {
      cwd: ROOT, encoding: 'utf8', input, timeout: 30000, env: { ...process.env, COWORK_NAME: '', STDB_DB: '' },
    });
    assert.equal(result.status, 0, input);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.ok(!result.stdout.includes('private-test-value'));
  }
});
