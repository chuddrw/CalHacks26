/**
 * hooks/src/inject-context.ts
 *
 * WHAT IT'S FOR
 *   Delivers the quiet messages: teammates' intents (heads_up), conflicts that someone else is
 *   fixing (info), and verified facts (fact). It runs synchronously after every tool call and
 *   before every prompt, adds the notes to the agent's context, and marks them delivered.
 *   It also delivers "conflict" rows itself when no listener is alive for this agent, for
 *   example after the listener timed out during 25 quiet minutes.
 *
 * OWNER: A. WHEN: Sat 9:20-13:00.
 * DONE WHEN: an intent posted by agent A shows up in agent B's context on B's next tool call.
 *
 * REGISTERED BY install.ts AS
 *   PostToolUse, matcher "*", timeout 5
 *   UserPromptSubmit, timeout 5 (this event takes no matcher)
 *
 * STEPS
 *   1. If settings are missing, exit 0.
 *   2. rows = selectRows("inbox", `agent = '<me>' AND delivered = false`)
 *   3. If listenerAlive(gitDir) (lib/listener-lock.ts), drop the "conflict" rows: the listener owns them.
 *      Render any remaining "conflict" row with conflictForFixer() instead of the short inbox text.
 *   4. Nothing left: exit 0 with no output, so the agent's context costs nothing.
 *   5. addContext(input.hook_event_name, notes(rows)), then mark_delivered(ids).
 *      Mark AFTER printing: if we get killed in between, a note shows twice, never zero times.
 *
 * NOTES
 *   - Keep it under about 300 ms. It runs on every tool call of every agent.
 *   - notes() in lib/format.ts already cuts long text and points to the team_status tool.
 */
import { missingSettings } from "../../shared/src/config.ts";
import { runHook, type HookInput } from "./lib/hook-io.ts";

async function main(input: HookInput): Promise<void> {
  if (missingSettings(["agent", "stdbDb", "stdbToken"]).length > 0) return;
  // TODO (A): steps 2-5 above.
  void input;
}

await runHook(main, 2500);
