/**
 * hooks/src/session-start.ts
 *
 * WHAT IT'S FOR
 *   Gives a new (or resumed) Claude session the team picture before it writes a single line:
 *   who's online and what they're doing, recent intents, every verified fact, its open tasks
 *   from the orchestrator, and any conflict thread it's part of. This is how shared memory
 *   reaches an agent in the memory beat, where C's agent gets "lastLogin is milliseconds" right
 *   the first time.
 *
 * OWNER: A.
 * DONE WHEN: a new Claude session in demo-app starts with a "[cowork] Team status" note that
 *            lists every verified fact (hooks/test/e2e.ts checks it against the mock database).
 *
 * REGISTERED BY install.ts AS
 *   SessionStart, timeout 10 (no matcher, so it runs on startup, resume, clear and compact)
 *   (snapshot-and-wait.ts is registered on SessionStart too, to start the listener.)
 *
 * STEPS
 *   1. If settings are missing, exit 0.
 *   2. Read agents, intents, conflicts and this agent's tasks, all in parallel.
 *   3. addContext("SessionStart", teamStatus(...)) from lib/format.ts. teamStatus keeps every
 *      verified fact and the last 10 plans.
 */
import { config, missingSettings } from "../../shared/src/config.ts";
import { selectRows, sqlString } from "../../shared/src/stdb-http.ts";
import { teamStatus } from "./lib/format.ts";
import { addContext, runHook, type HookInput } from "./lib/hook-io.ts";

async function main(_input: HookInput): Promise<void> {
  if (missingSettings(["agent", "stdbDb"]).length > 0) return;
  const me = config.agent;
  const [agents, intents, conflicts, tasks] = await Promise.all([
    selectRows("agent"),
    selectRows("intent"),
    selectRows("conflict"),
    selectRows("task", `agent = ${sqlString(me)}`),
  ]);
  intents.sort((a, b) => a.createdAt - b.createdAt);
  const mine = conflicts.filter((c) => (c.status === "open" || c.status === "escalated") && (c.agentA === me || c.agentB === me));
  const open = tasks.filter((t) => t.status === "assigned" || t.status === "waiting_review").sort((a, b) => a.id - b.id);
  addContext("SessionStart", teamStatus(agents, intents, mine, open, me));
}

await runHook(main, 4000);
