/**
 * adapters/core/hook-bridge.ts
 *
 * WHAT IT'S FOR
 *   Lets another client's native hooks reuse the existing Claude Code hook scripts in hooks/src
 *   (session-start.ts, inject-context.ts, stop.ts) without changing them. Each client's hook.ts
 *   translates its own event into a minimal Claude-shaped input, runs the script here, and turns the
 *   Claude-shaped output (parseClaudeOutput) back into its own schema.
 *
 * PRIVACY
 *   Only { hook_event_name, cwd, stop_hook_active } reach the scripts: never the user's prompt,
 *   transcript, tool output or credentials from the client's input.
 *
 * FAIL OPEN
 *   Any failure (script crash, timeout, non-JSON output) becomes "no context, no block".
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config } from '../../shared/src/config.ts';

export type ClaudeScript = 'session-start.ts' | 'inject-context.ts' | 'stop.ts';
export interface ClaudeInput { hook_event_name: 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop'; cwd: string; stop_hook_active?: boolean }
/** What a Claude-format hook asked for, in client-neutral terms. */
export interface HookIntent { context?: string; block?: string }

/** Reads a hook's stdin as a JSON object. Empty or invalid input gives {}. */
export async function readStdinJson(): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Extracts additionalContext / a Stop block from a Claude hook's stdout. Anything else => {}. */
export function parseClaudeOutput(stdout: string): HookIntent {
  try {
    const value = JSON.parse(stdout);
    const context = value?.hookSpecificOutput?.additionalContext;
    const intent: HookIntent = {};
    if (typeof context === 'string' && context) intent.context = context;
    if (value?.decision === 'block' && typeof value.reason === 'string' && value.reason) intent.block = value.reason;
    return intent;
  } catch { return {}; }
}

/** Runs one of hooks/src's scripts with a minimal input and returns what it asked for. */
export function runClaudeScript(script: ClaudeScript, input: ClaudeInput, timeoutMs = 6000): HookIntent {
  const result = spawnSync(process.execPath, [path.join(config.repoRoot, 'hooks', 'src', script)], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: timeoutMs,
  });
  return result.status === 0 && result.stdout.trim() ? parseClaudeOutput(result.stdout) : {};
}

/** Writes exactly one JSON object to stdout: the only thing a hook may print there. */
export function writeHookJson(value: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(value));
}
