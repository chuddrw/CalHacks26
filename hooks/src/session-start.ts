/**
 * hooks/src/session-start.ts
 *
 * WHAT IT'S FOR
 *   Gives a new (or resumed) Claude session the team picture before it writes a single line:
 *   who's online and what they're doing, recent intents, every verified fact, and any open
 *   conflict assigned to this agent. This is how shared memory reaches an agent in demo beat 4,
 *   where C's agent gets "lastLogin is milliseconds" right the first time.
 *
 * OWNER: A.
 * DONE WHEN: a new Claude session in demo-app starts with a "[cowork] Team status" note that
 *            lists every verified fact (hooks/test/e2e.ts checks it against the mock database).
 *
 * REGISTERED BY install.ts AS
 *   SessionStart, timeout 10 (no matcher, so it runs on startup, resume, clear and compact)
 *
 * STEPS
 *   1. If settings are missing, exit 0.
 *   2. Read agents, intents, and open conflicts where this agent is the fixer, all in parallel.
 *   3. addContext("SessionStart", teamStatus(...)) from lib/format.ts. teamStatus keeps every
 *      verified fact and the last 10 plans.
 */
import { config, missingSettings } from "../../shared/src/config.ts";
import { selectRows, sqlString } from "../../shared/src/stdb-http.ts";
import { teamStatus } from "./lib/format.ts";
import { addContext, runHook, type HookInput } from "./lib/hook-io.ts";

async function main(_input: HookInput): Promise<void> {
  if (missingSettings(["agent", "stdbDb"]).length > 0) return;
  const [agents, intents, mine] = await Promise.all([
    selectRows("agent"),
    selectRows("intent"),
    selectRows("conflict", `fixer = ${sqlString(config.agent)} AND status = 'open'`),
  ]);
  intents.sort((a, b) => a.createdAt - b.createdAt);
  addContext("SessionStart", teamStatus(agents, intents, mine));
}

await runHook(main, 4000);
