/**
 * hooks/src/lib/wake-message.ts
 *
 * WHAT IT'S FOR
 *   Turns an agent's undelivered wake rows (inbox kinds task, conflict and message) into the text
 *   that wakes it, with what it needs to act: the task and who asked for it; the conflict thread,
 *   the other agent's plan and what they said; or both humans' decision. Rows whose task or conflict
 *   is no longer active render nothing, so a stale note never wakes anyone. Replaced
 *   fixer-message.ts on branch feat/orchestrator (there is no single "fixer" any more).
 *
 * OWNER: A. USED BY: snapshot-and-wait.ts (the wake), inject-context.ts (delivery when no listener).
 *
 * NOTES
 *   - WHERE clauses only use one-word columns (id, agent), which read the same under any naming
 *     policy; message rows are filtered here by conflictId.
 *   - A task row's inbox note carries the task id in its conflictId column (module/src/index.ts).
 */
import type { ConflictRow, InboxRow, MessageRow } from "../../../shared/src/schema.ts";
import { selectRows, sqlString } from "../../../shared/src/stdb-http.ts";
import { conflictOpened, otherAgent, taskMessage, threadMessage, wakeReason } from "./format.ts";

async function latestPlanOf(agent: string): Promise<string> {
  if (!agent) return "";
  try {
    const intents = await selectRows("intent", `agent = ${sqlString(agent)}`);
    return intents.filter((i) => !i.verified).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0]?.summary ?? "";
  } catch {
    return ""; // The wake matters more than the plan.
  }
}

async function conflictById(id: number): Promise<ConflictRow | undefined> {
  return (await selectRows("conflict", `id = ${Number(id)}`))[0];
}

/** Messages of one thread, oldest first. */
export async function threadOf(conflictId: number): Promise<MessageRow[]> {
  return (await selectRows("message")).filter((m) => m.conflictId === conflictId).sort((a, b) => a.id - b.id);
}

/** What `me` hasn't answered yet: everything after its own last message in the thread. */
export function unanswered(thread: MessageRow[], me: string): MessageRow[] {
  let last = -1;
  thread.forEach((m, index) => {
    if (m.author === me) last = index;
  });
  return thread.slice(last + 1).filter((m) => m.author !== me);
}

/** The wake text for these rows, or "" when none of them is still worth waking for. */
export async function wakeText(me: string, rows: InboxRow[]): Promise<string> {
  const parts: string[] = [];
  const seenConflicts = new Set<number>();
  for (const row of [...rows].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)) {
    if (row.kind === "task") {
      const [task] = await selectRows("task", `id = ${Number(row.conflictId)}`);
      if (task?.status !== "assigned") continue;
      const [request] = await selectRows("request", `id = ${Number(task.requestId)}`);
      parts.push(taskMessage(task, request));
      continue;
    }
    if (row.kind !== "conflict" && row.kind !== "message") continue;
    if (seenConflicts.has(row.conflictId)) continue;
    const conflict = await conflictById(row.conflictId);
    if (!conflict || conflict.status !== "open") continue;
    seenConflicts.add(conflict.id);
    const thread = await threadOf(conflict.id);
    if (row.kind === "conflict") {
      parts.push(conflictOpened(conflict, me, await latestPlanOf(otherAgent(conflict, me)), thread, wakeReason(row.message)));
    } else {
      const fresh = unanswered(thread, me);
      if (fresh.length) parts.push(threadMessage(conflict, me, fresh));
    }
  }
  return parts.join("\n\n");
}
