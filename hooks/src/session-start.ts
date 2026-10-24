/**
 * hooks/src/session-start.ts
 *
 * WHAT IT'S FOR
 *   Gives a new (or resumed) Claude session the team picture before it writes a single line:
 *   who's online and what they're doing, recent intents, every verified fact, and any open
 *   conflict assigned to this agent. This is how shared memory reaches an agent in demo beat 4,
 *   where C's agent gets "lastLogin is milliseconds" right the first time.
 *
 * OWNER: A. WHEN: Sat 20:00-24:00.
 * DONE WHEN: a new Claude session in demo-app starts with a "[cowork] Team status" note that
 *            lists every verified fact.
 *
 * REGISTERED BY install.ts AS
 *   SessionStart, timeout 10 (no matcher, so it runs on startup, resume, clear and compact)
 *
 * STEPS
 *   1. If settings are missing, exit 0.
 *   2. agents  = selectRows("agent")
 *      intents = selectRows("intent")    teamStatus() keeps every verified fact and the last 10 plans
 *      mine    = selectRows("conflict", `fixer = '<me>' AND status = 'open'`)
 *   3. addContext("SessionStart", teamStatus(agents, intents, mine)) from lib/format.ts.
 */
import { missingSettings } from "../../shared/src/config.ts";
import { runHook, type HookInput } from "./lib/hook-io.ts";

async function main(input: HookInput): Promise<void> {
  if (missingSettings(["agent", "stdbDb", "stdbToken"]).length > 0) return;
  // TODO (A): steps 2-3 above.
  void input;
}

await runHook(main, 4000);
