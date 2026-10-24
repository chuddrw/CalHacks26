/** WHAT IT'S FOR: Part C adapter subcomponent tests using an injected SDK session, never a live model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomyLevel, ToolConfirmationOutcome, ToolConfirmationType, type CreateSessionOptions, type DroidStreamMessage, type createSession } from '@factory/droid-sdk/node';
import { createDroidDiagnoser } from './droid.ts';
import type { DiagnosisContext } from './prompt.ts';

const answer = { summary: 'Mismatch', cause: 'Milliseconds vs seconds', suggestion: 'Convert B', fact: 'lastLogin is milliseconds' };
const context: DiagnosisContext = {
  conflict: { id: 9, pair: 'a+b', kind: 'pair', agentA: 'a', agentB: 'b', locA: 'a.ts:1', locB: 'b.ts:1', error: 'units', explanation: '', fixer: 'b', status: 'open', runKey: 'x+y', createdAt: 1, resolvedAt: 0 },
  sides: [], failingOutput: 'failed', worktree: '/tmp/owned-droid-test',
};
function fakeSdk(options: { messages?: unknown[]; listError?: Error; streamError?: Error; closeError?: Error; createError?: Error } = {}) {
  let captured!: CreateSessionOptions;
  let closed = 0;
  let streamed = 0;
  let prompt = '';
  let disabled: string[] = [];
  const create = (async (input: CreateSessionOptions) => {
    captured = input;
    if (options.createError) throw options.createError;
    return {
      listTools: async () => {
        if (options.listError) throw options.listError;
        return ['Read', 'Grep', 'Glob', 'LS', 'Execute', 'Edit', 'Create', 'ApplyPatch', 'Task', 'UnknownConnector'].map(id => ({ id }));
      },
      updateSettings: async (settings: { disabledToolIds: string[] }) => { disabled = settings.disabledToolIds; },
      stream: async function* (inputPrompt: string) {
        streamed++; prompt = inputPrompt;
        if (options.streamError) throw options.streamError;
        for (const message of options.messages ?? []) yield message as DroidStreamMessage;
      },
      close: async () => { closed++; if (options.closeError) throw options.closeError; },
    };
  }) as unknown as typeof createSession;
  const run = createDroidDiagnoser({ create, apiKey: 'synthetic-test-key-never-sent', timeoutMs: 1000 });
  return { run, create, captured: () => captured, counts: () => ({ closed, streamed }), disabled: () => disabled, prompt: () => prompt };
}
const success = { type: 'result', success: true, text: JSON.stringify(answer) };

test('Droid adapter configures owned cwd, low autonomy and no write/connector tools before streaming', async () => {
  const sdk = fakeSdk({ messages: [success] });
  assert.deepEqual(await sdk.run(context, () => {}), answer);
  assert.equal(sdk.captured().cwd, context.worktree);
  assert.equal(sdk.captured().autonomyLevel, AutonomyLevel.Off);
  assert.equal(sdk.captured().disableBuiltinSkills, true);
  assert.ok(sdk.captured().abortSignal instanceof AbortSignal);
  assert.deepEqual(sdk.disabled(), ['Edit', 'Create', 'ApplyPatch', 'Task', 'UnknownConnector']);
  assert.match(sdk.prompt(), /Never change files/);
  assert.match(sdk.prompt(), /picked b to fix/);
  assert.deepEqual(sdk.counts(), { closed: 1, streamed: 1 });
});

test('Droid adapter translates streamed steps into bounded UI events and returns only terminal diagnosis', async () => {
  const sdk = fakeSdk({ messages: [
    { type: 'assistant', text: '🙂'.repeat(1000) },
    { type: 'tool_call', name: 'Read', input: { path: 'a.ts' } },
    { type: 'tool_result', content: 'x'.repeat(1000) },
    { type: 'error', message: 'recoverable read error' }, success,
  ] });
  const steps: Array<[string, string]> = [];
  assert.deepEqual(await sdk.run(context, (kind, detail) => { steps.push([kind, detail]); }), answer);
  assert.deepEqual(steps.map(step => step[0]), ['thought', 'tool_call', 'tool_result', 'error', 'final']);
  assert.match(steps[1]![1], /Read.*a.ts/);
  assert.ok(Buffer.byteLength(steps[0]![1]) <= 2048);
  assert.ok(!steps[0]![1].includes('�'));
  assert.ok(steps[2]![1].length <= 300);
  assert.equal(sdk.counts().closed, 1);
});

test('failed terminal results and empty streams return unavailable and close once', async () => {
  for (const messages of [[], [{ type: 'assistant', text: 'partial advice without completed turn' }], [{ type: 'result', success: false, text: 'failed advice' }]]) {
    const sdk = fakeSdk({ messages });
    assert.equal(await sdk.run(context, () => {}), null);
    assert.equal(sdk.counts().closed, 1);
  }
});

test('session discovery and stream exceptions close the acquired session; startup failures have no lease to close', async () => {
  for (const options of [{ listError: new Error('discovery failed') }, { streamError: new Error('transport failed') }, { createError: new Error('startup failed') }]) {
    const sdk = fakeSdk(options);
    const errors: string[] = [];
    assert.equal(await sdk.run(context, (kind, detail) => { if (kind === 'error') errors.push(detail); }), null);
    assert.equal(sdk.counts().closed, 'createError' in options ? 0 : 1);
    assert.deepEqual(errors, ['Droid diagnosis unavailable']);
  }
});

test('missing explicit credentials skip SDK startup and session close failures propagate', async () => {
  const sdk = fakeSdk();
  const noKey = createDroidDiagnoser({ create: sdk.create, apiKey: '' });
  assert.equal(await noKey(context, () => {}), null);
  assert.deepEqual(sdk.counts(), { closed: 0, streamed: 0 });
  const brokenCleanup = fakeSdk({ messages: [success], closeError: new Error('close failed') });
  await assert.rejects(brokenCleanup.run(context, () => {}), /close failed/);
  assert.equal(brokenCleanup.counts().closed, 1);
});

test('permission handler permits one safe check only when ProceedOnce is an offered choice', async () => {
  const sdk = fakeSdk({ messages: [success] });
  await sdk.run(context, () => {});
  const handler = sdk.captured().permissionHandler!;
  type Request = Parameters<typeof handler>[0];
  const execute = (command: string, fullCommand = command) => ({ toolUse: { name: 'Execute', input: {} }, details: { type: ToolConfirmationType.Execute, command, fullCommand } });
  const request = (toolUses: unknown[], offered = [ToolConfirmationOutcome.ProceedOnce, ToolConfirmationOutcome.Cancel]) => ({ toolUses, options: offered.map(value => ({ label: value, value })) }) as Request;
  assert.equal(await handler(request([execute('./node_modules/.bin/vitest run')])), ToolConfirmationOutcome.ProceedOnce);
  assert.equal(await handler(request([execute('git diff --no-ext-diff --no-textconv')])), ToolConfirmationOutcome.ProceedOnce);
  assert.equal(await handler(request([execute('cat a.ts')], [ToolConfirmationOutcome.Cancel])), ToolConfirmationOutcome.Cancel);
  for (const tools of [[], [execute('git push')], [execute('cat a.ts', 'cat a.ts; git push')], [execute('cat a.ts'), execute('rm a.ts')], [{ toolUse: { name: 'Edit' }, details: { type: ToolConfirmationType.Edit } }], [{ toolUse: { name: 'Read' }, details: { type: ToolConfirmationType.SandboxViolation } }], [{ toolUse: { name: 'UnknownConnector' }, details: { type: ToolConfirmationType.McpTool } }]]) {
    assert.equal(await handler(request(tools)), ToolConfirmationOutcome.Cancel);
  }
});
