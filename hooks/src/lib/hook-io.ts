/**
 * hooks/src/lib/hook-io.ts
 *
 * WHAT IT'S FOR
 *   Shared plumbing for every hook: read the JSON that Claude Code sends on stdin, print the
 *   JSON it expects back, and make sure one of OUR bugs never blocks an agent (fail open).
 *
 * OWNER: A. USED BY: every hook in hooks/src.
 *
 * WHAT CLAUDE CODE SENDS (stdin JSON, from the Claude Code hooks reference)
 *   Every event: session_id, transcript_path, cwd, hook_event_name, permission_mode
 *   Tool events: tool_name, tool_input, tool_use_id
 *   Stop:        stop_hook_active, last_assistant_message
 *
 * WHAT WE SEND BACK
 *   Add context:  stdout {"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"..."}}
 *   Block a Stop: stdout {"decision":"block","reason":"..."}
 *   Wake (asyncRewake hooks only): the message on stderr, then exit code 2.
 *
 * FAIL OPEN
 *   runHook() wraps a hook's main function. An exception, a missing setting or a timeout ends
 *   with exit code 0 and nothing on stdout, so the agent carries on as if we weren't there.
 *   Errors are printed (to stderr) only when COWORK_DEBUG=1, so normal sessions stay quiet.
 */

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

/** Reads all of stdin and parses it. Empty stdin gives an empty object. */
export async function readHookInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as HookInput) : {};
}

/** Adds text to the agent's context for this event. Call at most once per hook run. */
export function addContext(event: string, text: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

/** Stops the agent from ending its turn and tells it why. Stop hooks only. */
export function blockStop(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

/** Wakes the agent with a message. Only works in a hook registered with asyncRewake: true. */
export function wakeAgent(message: string): never {
  process.stderr.write(message);
  process.exit(2);
}

/** Runs a hook's main function with a time budget, and fails open on any error. */
export async function runHook(main: (input: HookInput) => Promise<void>, budgetMs: number): Promise<void> {
  const timer = setTimeout(() => process.exit(0), budgetMs);
  try {
    await main(await readHookInput());
  } catch (error) {
    if (process.env.COWORK_DEBUG === "1") process.stderr.write(`[cowork] hook error: ${String(error)}\n`);
  } finally {
    clearTimeout(timer);
  }
}
