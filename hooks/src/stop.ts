/**
 * hooks/src/stop.ts
 *
 * WHAT IT'S FOR
 *   Keeps the fixer from ending its turn while its conflict is still open. Without it, an agent
 *   could read the warning, reply "noted", and stop.
 *
 * OWNER: A.
 * DONE WHEN: with an open conflict assigned to it, the agent can't finish a turn without either
 *            fixing the conflict or explaining why it can't (hooks/test/e2e.ts checks both branches).
 *
 * REGISTERED BY install.ts AS
 *   Stop, timeout 5 (this event takes no matcher)
 *
 * STEPS
 *   1. If input.stop_hook_active is true, exit 0. We already pushed back once in this turn.
 *      Claude Code allows up to 8 repeats, but one nudge is enough; the escalation timer brings
 *      in a human after that.
 *   2. open = conflicts where this agent is the fixer and the status is "open".
 *   3. None: exit 0. Otherwise blockStop(stopReason(open[0])) from lib/format.ts.
 */
import { config, missingSettings } from "../../shared/src/config.ts";
import { selectRows, sqlString } from "../../shared/src/stdb-http.ts";
import { stopReason } from "./lib/format.ts";
import { blockStop, runHook, type HookInput } from "./lib/hook-io.ts";

async function main(input: HookInput): Promise<void> {
  if (input.stop_hook_active) return;
  if (missingSettings(["agent", "stdbDb"]).length > 0) return;
  const open = await selectRows("conflict", `fixer = ${sqlString(config.agent)} AND status = 'open'`);
  const first = open.sort((a, b) => a.createdAt - b.createdAt)[0];
  if (first) blockStop(stopReason(first));
}

await runHook(main, 2500);
