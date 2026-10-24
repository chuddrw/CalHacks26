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
 * OWNER: A.
 * DONE WHEN: an intent posted by agent A shows up in agent B's context on B's next tool call
 *            (hooks/test/e2e.ts checks it against the mock database).
 *
 * REGISTERED BY install.ts AS
 *   PostToolUse, matcher "*", timeout 5
 *   UserPromptSubmit, timeout 5 (this event takes no matcher)
 *
 * STEPS
 *   1. If settings are missing, exit 0.
 *   2. rows = undelivered inbox rows for this agent.
 *   3. If a listener is alive (lib/listener-lock.ts), leave the "conflict" rows to it. Any remaining
 *      "conflict" row is rendered in full with conflictForFixer(), the rest with notes().
 *   4. Nothing to say: exit 0 with no output, so the agent's context costs nothing.
 *   5. addContext(<this event>, text), then mark_delivered(ids). Marking AFTER printing means a note
 *      can show twice if we get killed in between, but never zero times.
 *
 * NOTES
 *   - Keep it fast. It runs on every tool call of every agent: one SQL call when the inbox is empty.
 */
import { config, missingSettings } from "../../shared/src/config.ts";
import { callReducer, selectRows, sqlString } from "../../shared/src/stdb-http.ts";
import type { InboxRow } from "../../shared/src/schema.ts";
import { conflictForFixer, notes } from "./lib/format.ts";
import { addContext, runHook, type HookInput } from "./lib/hook-io.ts";
import { listenerAlive } from "./lib/listener-lock.ts";
import { gitDirOf } from "./lib/snapshot.ts";

async function main(input: HookInput): Promise<void> {
  if (missingSettings(["agent", "stdbDb"]).length > 0) return;
  let rows: InboxRow[] = await selectRows("inbox", `agent = ${sqlString(config.agent)} AND delivered = false`);
  if (rows.length === 0) return;

  let listener = false;
  try {
    listener = listenerAlive(await gitDirOf(input.cwd ?? process.cwd()));
  } catch {
    // not inside a git repo: there can't be a listener either
  }
  if (listener) rows = rows.filter((row) => row.kind !== "conflict");
  if (rows.length === 0) return;
  rows.sort((a, b) => a.createdAt - b.createdAt);

  const parts: string[] = [];
  for (const row of rows.filter((r) => r.kind === "conflict")) {
    const [conflict] = await selectRows("conflict", `id = ${Number(row.conflictId)}`);
    if (conflict && (conflict.status === "open" || conflict.status === "escalated")) parts.push(conflictForFixer(conflict));
  }
  const quiet = rows.filter((row) => row.kind !== "conflict");
  if (quiet.length > 0) parts.push(notes(quiet));

  if (parts.length > 0) addContext(input.hook_event_name ?? "PostToolUse", parts.join("\n\n"));
  await callReducer("mark_delivered", [rows.map((row) => row.id)]);
}

await runHook(main, 2500);
