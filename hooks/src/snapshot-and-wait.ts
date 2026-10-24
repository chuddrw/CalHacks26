/**
 * hooks/src/snapshot-and-wait.ts
 *
 * WHAT IT'S FOR
 *   The main hook. Claude Code starts it in the background (asyncRewake) after every Edit,
 *   Write, MultiEdit, NotebookEdit or Bash call. It has two jobs:
 *     1. Snapshot: push the agent's working tree to wip/<name>, then call post_snapshot.
 *     2. Listen: the newest one per agent stays alive and wakes the agent when the watcher
 *        assigns it a conflict. Waking means writing the message to stderr and exiting with
 *        code 2. Claude Code then starts a new turn with that message, even if the agent was idle.
 *
 * OWNER: A. WHEN: Sat 9:20-13:00 (snapshot first, then the listener).
 * DONE WHEN: (a) an edit appears as wip/<name> plus a snapshot row within 2 s, and (b) with the
 *            agent idle, a conflict assigned to it wakes it within 3 s of report_conflict.
 *
 * REGISTERED BY install.ts AS
 *   PostToolUse, matcher "Edit|Write|MultiEdit|NotebookEdit|Bash", asyncRewake: true, timeout: 1800
 *
 * STEPS
 *   1. If COWORK_NAME, STDB_DB or STDB_TOKEN is missing, exit 0.
 *   2. takeSnapshot(input.cwd, agent) from lib/snapshot.ts. If it returns a snapshot, call
 *      post_snapshot(agent, sha, baseSha, files, diff). On an error: log it under COWORK_DEBUG
 *      and carry on to step 3.
 *   3. claimListener(gitDir). From now on, any older listener for this agent exits by itself.
 *   4. Every second, until LISTENER_MINUTES have passed:
 *        - if !isCurrentListener(gitDir): exit 0 (a newer edit took over)
 *        - rows = selectRows("inbox", `agent = '<me>' AND kind = 'conflict' AND delivered = false`)
 *        - if there are any: load the newest one's conflict row, render it with conflictForFixer()
 *          from lib/format.ts, call mark_delivered(ids), releaseListener(gitDir),
 *          then wakeAgent(text). That exits with code 2.
 *   5. Time is up: releaseListener(gitDir) and exit 0. Claude Code would kill us at 1800 s anyway.
 *
 * NOTES
 *   - Only "conflict" rows wake the agent. heads_up, info and fact rows wait for inject-context.ts
 *     on the next tool call, so teammates' notes never interrupt an idle agent.
 *   - A Bash call that changes no files makes takeSnapshot() return null: no push, no row. It still
 *     restarts the listener, which is what we want.
 *   - Polling once a second over HTTP is the simple version. If it turns out too chatty, switch the
 *     listener to a WebSocket subscription later. Nothing else has to change.
 */
import { config, missingSettings } from "../../shared/src/config.ts";
import { runHook, type HookInput } from "./lib/hook-io.ts";

async function main(input: HookInput): Promise<void> {
  if (missingSettings(["agent", "stdbDb", "stdbToken"]).length > 0) return;
  // TODO (A): steps 2-5 above, using lib/snapshot.ts, lib/listener-lock.ts, lib/format.ts
  // and shared/src/stdb-http.ts.
  void input;
}

await runHook(main, (config.listenerMinutes + 1) * 60_000);
