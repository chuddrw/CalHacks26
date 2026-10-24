/**
 * hooks/src/stop.ts
 *
 * WHAT IT'S FOR
 *   Keeps the fixer from ending its turn while its conflict is still open. Without it, an agent
 *   could read the warning, reply "noted", and stop.
 *
 * OWNER: A. WHEN: Sat 9:20-13:00.
 * DONE WHEN: with an open conflict assigned to it, the agent can't finish a turn without either
 *            fixing the conflict or explaining why it can't.
 *
 * REGISTERED BY install.ts AS
 *   Stop, timeout 5 (this event takes no matcher)
 *
 * STEPS
 *   1. If input.stop_hook_active is true, exit 0. We already pushed back once in this turn.
 *      Claude Code allows up to 8 repeats, but one nudge is enough; the escalation timer brings
 *      in a human after that.
 *   2. open = selectRows("conflict", `fixer = '<me>' AND status = 'open'`)
 *   3. None: exit 0. Otherwise blockStop(stopReason(open[0])) from lib/format.ts.
 */
import { missingSettings } from "../../shared/src/config.ts";
import { runHook, type HookInput } from "./lib/hook-io.ts";

async function main(input: HookInput): Promise<void> {
  if (input.stop_hook_active) return;
  if (missingSettings(["agent", "stdbDb", "stdbToken"]).length > 0) return;
  // TODO (A): steps 2-3 above.
}

await runHook(main, 2500);
