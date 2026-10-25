/**
 * hooks/src/stop.ts
 *
 * WHAT IT'S FOR
 *   One nudge before an agent ends its turn with something left hanging:
 *     1. it owes a teammate a reply: an open conflict thread where the last word isn't its own
 *        (the thread just opened, or the other agent, the orchestrator or the humans spoke last);
 *     2. a task from the orchestrator is still assigned to it.
 *   Without it, an agent could read the message, reply "noted" to its human, and stop. An
 *   escalated conflict never blocks: the agent is waiting for its human there.
 *
 * OWNER: A.
 * DONE WHEN: an agent with an unanswered thread, or an open task, can't finish a turn without
 *            replying or completing it once (hooks/test/e2e.ts checks both, and the stop_hook_active pass).
 *
 * REGISTERED BY install.ts AS
 *   Stop, timeout 5 (this event takes no matcher)
 *
 * STEPS
 *   1. If input.stop_hook_active is true, exit 0. We already pushed back once in this turn.
 *      Claude Code allows up to 8 repeats, but one nudge is enough; the escalation timer brings
 *      in both humans after that.
 *   2. The oldest open conflict this agent is part of whose last message isn't its own: block with
 *      stopReasonReply. Otherwise its oldest assigned task: block with stopReasonTask.
 *   3. Neither: exit 0.
 */
import { config, missingSettings } from "../../shared/src/config.ts";
import { selectRows, sqlString } from "../../shared/src/stdb-http.ts";
import { stopReasonReply, stopReasonTask } from "./lib/format.ts";
import { blockStop, runHook, type HookInput } from "./lib/hook-io.ts";
import { unanswered } from "./lib/wake-message.ts";

async function main(input: HookInput): Promise<void> {
  if (input.stop_hook_active) return;
  if (missingSettings(["agent", "stdbDb"]).length > 0) return;
  const me = config.agent;
  const [conflicts, messages, tasks] = await Promise.all([
    selectRows("conflict", `status = 'open'`),
    selectRows("message"),
    selectRows("task", `agent = ${sqlString(me)} AND status = 'assigned'`),
  ]);
  const mine = conflicts.filter((c) => c.agentB !== "" && (c.agentA === me || c.agentB === me)).sort((a, b) => a.createdAt - b.createdAt);
  for (const conflict of mine) {
    const thread = messages.filter((m) => m.conflictId === conflict.id).sort((a, b) => a.id - b.id);
    if (thread.length === 0 || unanswered(thread, me).length > 0) {
      blockStop(stopReasonReply(conflict, me));
      return;
    }
  }
  const task = tasks.sort((a, b) => a.id - b.id)[0];
  if (task) blockStop(stopReasonTask(task));
}

await runHook(main, 2500);
