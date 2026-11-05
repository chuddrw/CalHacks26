/**
 * adapters/gemini/hook.ts
 *
 * WHAT IT'S FOR
 *   The single entry point for every Gemini CLI hook that adapters/gemini/install.ts registers. Gemini's
 *   hook I/O is close to Claude Code's (hookSpecificOutput.additionalContext, decision + reason), so
 *   the existing hooks/src scripts are reused and their output is normalized to Gemini's schema.
 *
 * EVENT MAP (https://geminicli.com/docs/hooks/reference/, checked 2026-10-31)
 *   SessionStart  start publisher; session-start.ts -> hookSpecificOutput.additionalContext
 *   BeforeAgent   inject-context.ts (team notes)   -> hookSpecificOutput.additionalContext (this turn only)
 *   AfterTool     ensure the publisher runs (it publishes within ~2 s); inject-context.ts -> additionalContext
 *   AfterAgent    sync now; stop.ts                -> { decision: "deny", reason } when a task/conflict waits
 *                 (Gemini sends `reason` back to the agent as a new prompt, like Claude's Stop block)
 *
 * FAIL OPEN
 *   Without automatic consent, on any error, or for an unknown event: prints {} and exits 0.
 *   stdout carries exactly one JSON object (Gemini treats anything else as a parse failure).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, runClaudeScript, writeHookJson, type HookIntent } from '../core/hook-bridge.ts';
import { adapterFrom, reportingEnabled, syncWork } from '../core/runtime.ts';
import { startPublisher } from '../core/cli.ts';

export const ADAPTER = adapterFrom('gemini', 'Gemini CLI');
const CONTEXT_EVENTS = new Set(['SessionStart', 'BeforeAgent', 'AfterTool']);

/** Gemini's response for `event`, given what the Claude-format script asked for. */
export function geminiResponse(event: unknown, intent: HookIntent): Record<string, unknown> {
  if (typeof event === 'string' && CONTEXT_EVENTS.has(event) && intent.context) {
    return { hookSpecificOutput: { hookEventName: event, additionalContext: intent.context } };
  }
  if (event === 'AfterAgent' && intent.block) return { decision: 'deny', reason: intent.block };
  return {};
}

export function workspaceOf(input: Record<string, any>): string {
  return path.resolve(typeof input.cwd === 'string' && input.cwd ? input.cwd
    : process.env.GEMINI_PROJECT_DIR || process.env.GEMINI_CWD || process.cwd());
}

export async function handle(input: Record<string, any>): Promise<Record<string, unknown>> {
  const event = input.hook_event_name;
  const cwd = workspaceOf(input);
  if (!await reportingEnabled(ADAPTER, cwd, true)) return {};
  switch (event) {
    case 'SessionStart':
      await startPublisher(ADAPTER, cwd);
      return geminiResponse(event, runClaudeScript('session-start.ts', { hook_event_name: 'SessionStart', cwd }));
    case 'BeforeAgent':
      return geminiResponse(event, runClaudeScript('inject-context.ts', { hook_event_name: 'UserPromptSubmit', cwd }));
    case 'AfterTool':
      await startPublisher(ADAPTER, cwd);
      return geminiResponse(event, runClaudeScript('inject-context.ts', { hook_event_name: 'PostToolUse', cwd }));
    case 'AfterAgent':
      await syncWork(ADAPTER, cwd).catch(() => undefined); // the publisher retries; never block the turn on it
      return geminiResponse(event, runClaudeScript('stop.ts', { hook_event_name: 'Stop', cwd, stop_hook_active: input.stop_hook_active === true }));
    default:
      return {};
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = await readStdinJson();
  try { writeHookJson(await handle(input)); }
  catch {
    if (process.env.COWORK_DEBUG === '1') process.stderr.write('[cowork] Gemini hook failed; the publisher will retry.\n');
    writeHookJson({});
  }
}
