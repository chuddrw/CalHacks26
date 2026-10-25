/** WHAT IT'S FOR: Part C Claude adapter subcomponent checks with an entirely mocked SDK/config.
 * No API requests, real credentials, watcher orchestration or other teammates' components are used.
 */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { DiagnosisContext } from '../../orchestrator/src/diagnose/prompt.ts';

const diagnosis = { summary: 'Unit mismatch', cause: 'Milliseconds meets seconds', suggestion: 'Convert B', fact: 'lastLogin is milliseconds' };
const context: DiagnosisContext = {
  conflict: { id: 1, pair: 'a+b', kind: 'pair', agentA: 'a', agentB: 'b', locA: 'a.ts:1', locB: 'b.ts:1', error: 'units', explanation: '', fixer: 'b', status: 'open', runKey: 'x+y', createdAt: 1, resolvedAt: 0 },
  sides: [], failingOutput: 'expected 2, got 2000', worktree: '/tmp/mock-claude',
};
const parse = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const constructed = vi.fn();
class FakeAPIError extends Error {}
class FakeAnthropic {
  static APIError = FakeAPIError;
  beta = { messages: { parse } };
  constructor(options: unknown) { constructed(options); }
}
let settings: { anthropicApiKey: string; claudeModel: string };

beforeEach(() => {
  vi.resetModules();
  parse.mockReset();
  constructed.mockReset();
  parse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: diagnosis });
  settings = { anthropicApiKey: 'synthetic-test-key-not-used-for-network', claudeModel: 'fixture-model' };
  vi.doMock('@anthropic-ai/sdk', () => ({ default: FakeAnthropic }));
  vi.doMock('../../shared/src/config.ts', () => ({ config: settings }));
});
afterEach(() => {
  vi.doUnmock('@anthropic-ai/sdk');
  vi.doUnmock('../../shared/src/config.ts');
});
async function adapter() {
  return (await import('../../orchestrator/src/diagnose/claude.ts')).diagnoseWithClaude;
}

it('missing credentials return unavailable without constructing an SDK client', async () => {
  settings.anthropicApiKey = '';
  expect(await (await adapter())(context)).toBeNull();
  expect(constructed).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
});

it('sends configured model, structured diagnosis schema and bounded request settings', async () => {
  const diagnose = await adapter();
  expect(await diagnose(context)).toEqual(diagnosis);
  expect(constructed).toHaveBeenCalledWith({ apiKey: settings.anthropicApiKey, timeout: 20_000, maxRetries: 0 });
  expect(parse).toHaveBeenCalledWith(expect.objectContaining({
    model: 'fixture-model', max_tokens: 2048,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: expect.objectContaining({ effort: 'low', format: expect.objectContaining({ type: 'json_schema' }) }),
    messages: [expect.objectContaining({ role: 'user', content: expect.stringContaining('expected 2, got 2000') })],
  }));
  const request = parse.mock.calls[0]![0] as { output_config: { format: { schema: { properties: object; required: string[] } } }; messages: unknown[] };
  expect(Object.keys(request.output_config.format.schema.properties).sort()).toEqual(['cause', 'fact', 'suggestion', 'summary']);
  expect(request.output_config.format.schema.required.sort()).toEqual(['cause', 'fact', 'suggestion', 'summary']);
  expect(request.messages).toHaveLength(1);
});

it.each(['refusal', 'max_tokens'])('returns unavailable for %s even when partial parsed content exists', async reason => {
  parse.mockResolvedValue({ stop_reason: reason, parsed_output: diagnosis });
  expect(await (await adapter())(context)).toBeNull();
});

it.each([null, undefined])('returns unavailable when SDK has no parsed output (%s)', async parsed => {
  parse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: parsed });
  expect(await (await adapter())(context)).toBeNull();
});

it.each([new FakeAPIError('rate limit/transport/API failure'), new SyntaxError('bad JSON')])('returns unavailable for expected provider/parse errors', async error => {
  parse.mockRejectedValue(error);
  expect(await (await adapter())(context)).toBeNull();
});

it('propagates unexpected programming errors rather than misreporting provider unavailability', async () => {
  const error = new TypeError('unexpected implementation bug');
  parse.mockRejectedValue(error);
  await expect((await adapter())(context)).rejects.toBe(error);
});

it('reuses one SDK client across successful calls while issuing a new request per diagnosis', async () => {
  const diagnose = await adapter();
  expect(await diagnose(context)).toEqual(diagnosis);
  expect(await diagnose({ ...context, failingOutput: 'second failure' })).toEqual(diagnosis);
  expect(constructed).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledTimes(2);
  expect(parse.mock.calls[1]![0]).toMatchObject({ messages: [{ content: expect.stringContaining('second failure') }] });
});

it('handles expected SDK construction failures and retries construction on the next call', async () => {
  const diagnose = await adapter();
  constructed.mockImplementationOnce(() => { throw new FakeAPIError('construction failed'); });
  expect(await diagnose(context)).toBeNull();
  expect(parse).not.toHaveBeenCalled();
  expect(await diagnose(context)).toEqual(diagnosis);
  expect(constructed).toHaveBeenCalledTimes(2);
  expect(parse).toHaveBeenCalledTimes(1);
});
