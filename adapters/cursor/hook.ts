/**
 * adapters/cursor/hook.ts
 *
 * WHAT IT'S FOR
 *   The single entry point for every Cursor hook that adapters/cursor/install.ts registers. It maps
 *   Cursor's events onto Orkio (core publisher/sync + the existing hooks/src scripts) and translates
 *   the Claude-format output of those scripts into Cursor's output schema.
 *
 * EVENT MAP (Cursor docs: https://cursor.com/docs/agent/hooks, checked 2026-10-31)
 *   sessionStart        start publisher; session-start.ts      -> { additional_context }
 *   beforeSubmitPrompt  start publisher                         -> { continue: true }   (no context field exists)
 *   postToolUse         inject-context.ts (team notes)        -> { additional_context }
 *   afterFileEdit,
 *   afterShellExecution ensure the publisher runs (it publishes within ~2 s; no blocking push here) -> {}
 *   stop                sync now; stop.ts                     -> { followup_message } when a task/conflict waits
 *
 * FAIL OPEN
 *   Without automatic consent, on any error, or for an unknown event, it prints the minimal valid
 *   response for the event and exits 0. stdout carries exactly one JSON object, nothing else.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, runClaudeScript, writeHookJson, type HookIntent } from '../core/hook-bridge.ts';
import { adapterFrom, reportingEnabled, syncWork } from '../core/runtime.ts';
import { startPublisher } from '../core/cli.ts';

export const ADAPTER = adapterFrom('cursor', 'Cursor');

/** The smallest valid response for each event (beforeSubmitPrompt must say continue). */
export function minimalResponse(event: unknown): Record<string, unknown> {
  return event === 'beforeSubmitPrompt' ? { continue: true } : {};
}

/** Cursor's response for `event`, given what the Claude-format script asked for. */
export function cursorResponse(event: unknown, intent: HookIntent): Record<string, unknown> {
  if ((event === 'sessionStart' || event === 'postToolUse') && intent.context) return { additional_context: intent.context };
  if (event === 'stop' && intent.block) return { followup_message: intent.block };
  return minimalResponse(event);
}

/** The workspace clone: Cursor gives cwd only on some events, workspace_roots on all. */
export function workspaceOf(input: Record<string, any>): string {
  const root = Array.isArray(input.workspace_roots) ? input.workspace_roots.find((r: unknown) => typeof r === 'string') : undefined;
  return path.resolve(typeof input.cwd === 'string' && input.cwd ? input.cwd : root || process.env.CURSOR_PROJECT_DIR || process.cwd());
}

/** stop.ts must not ask again when the user aborted or this stop is already a hook's follow-up. */
export function stopHookActive(input: Record<string, any>): boolean {
  return input.status !== 'completed' || Number(input.loop_count ?? 0) > 0;
}

export async function handle(input: Record<string, any>): Promise<Record<string, unknown>> {
  const event = input.hook_event_name;
  const cwd = workspaceOf(input);
  if (!await reportingEnabled(ADAPTER, cwd, true)) return minimalResponse(event);
  switch (event) {
    case 'sessionStart':
      await startPublisher(ADAPTER, cwd);
      return cursorResponse(event, runClaudeScript('session-start.ts', { hook_event_name: 'SessionStart', cwd }));
    case 'beforeSubmitPrompt': case 'afterFileEdit': case 'afterShellExecution':
      await startPublisher(ADAPTER, cwd);
      return minimalResponse(event);
    case 'postToolUse':
      return cursorResponse(event, runClaudeScript('inject-context.ts', { hook_event_name: 'PostToolUse', cwd }));
    case 'stop':
      await syncWork(ADAPTER, cwd).catch(() => undefined); // the publisher retries; never block the stop on it
      return cursorResponse(event, runClaudeScript('stop.ts', { hook_event_name: 'Stop', cwd, stop_hook_active: stopHookActive(input) }));
    default:
      return minimalResponse(event);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = await readStdinJson();
  try { writeHookJson(await handle(input)); }
  catch {
    if (process.env.COWORK_DEBUG === '1') process.stderr.write('[cowork] Cursor hook failed; the publisher will retry.\n');
    writeHookJson(minimalResponse(input.hook_event_name));
  }
}
