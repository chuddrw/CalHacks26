/**
 * hooks/src/lib/fixer-message.ts
 *
 * WHAT IT'S FOR
 *   Builds the message that wakes the fixer, including the teammate's latest plan (their newest
 *   post_intent). Without it the fixer sees what broke but not why the teammate changed it, and
 *   may undo the teammate's change instead of adapting to it.
 *
 * OWNER: A. USED BY: snapshot-and-wait.ts (the wake), inject-context.ts (delivery when no listener).
 */
import { selectRows, sqlString } from "../../../shared/src/stdb-http.ts";
import type { ConflictRow } from "../../../shared/src/schema.ts";
import { conflictForFixer, wakeReason } from "./format.ts";

/** `inboxMessage` is the text of the conflict note that triggered this wake, if any. */
export async function fixerMessage(c: ConflictRow, inboxMessage = ""): Promise<string> {
  const other = c.fixer === c.agentA ? c.agentB : c.agentA;
  let plan = "";
  if (c.kind !== "self" && other) {
    try {
      const intents = await selectRows("intent", `agent = ${sqlString(other)}`);
      plan = intents.filter((i) => !i.verified).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0]?.summary ?? "";
    } catch {
      // The wake matters more than the plan; send the message without it.
    }
  }
  return conflictForFixer(c, plan, wakeReason(inboxMessage));
}
