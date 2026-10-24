/**
 * hooks/src/snapshot-and-wait.ts
 *
 * WHAT IT'S FOR
 *   The main hook. Claude Code starts it in the background (asyncRewake) after every Edit,
 *   Write, MultiEdit, NotebookEdit or Bash call. It has two jobs:
 *     1. Snapshot: push the agent's working tree to wip/<name>, then call post_snapshot.
 *     2. Listen: the newest one per agent stays alive and wakes the agent when the watcher
 *        assigns it a conflict. Waking means writing the message to stderr and exiting with
 *        code 2. Claude Code then starts a new turn with that message, even if the agent was idle
 *        (proved by hooks/src/rewake-spike.ts on Oct 24).
 *
 * OWNER: A.
 * DONE WHEN: (a) an edit appears as wip/<name> plus a snapshot row within 2 s, and (b) with the
 *            agent idle, a conflict assigned to it wakes it within 3 s of report_conflict.
 *            hooks/test/e2e.ts measures both against the mock database.
 *
 * REGISTERED BY install.ts AS
 *   PostToolUse, matcher "Edit|Write|MultiEdit|NotebookEdit|Bash", asyncRewake: true, timeout: 1800
 *
 * STEPS
 *   1. If COWORK_NAME or STDB_DB is missing, exit 0. (The token comes from shared/src/session-token.ts.)
 *   2. takeSnapshot() (lib/snapshot.ts). If it returns a snapshot, call post_snapshot. An error here
 *      is logged under COWORK_DEBUG and we carry on to step 3.
 *   3. claimListener(). From now on, any older listener for this agent exits by itself.
 *   4. Every second, until LISTENER_MINUTES have passed:
 *        - a newer listener took over: exit 0
 *        - undelivered "conflict" inbox rows for us: mark them delivered and, if the conflict is
 *          still open, wake the agent with conflictForFixer() (lib/format.ts), which exits with 2
 *   5. Time is up: exit 0. (Claude Code would stop us at the 1800 s timeout anyway.)
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
import { callReducer, selectRows, sqlString } from "../../shared/src/stdb-http.ts";
import { conflictForFixer } from "./lib/format.ts";
import { runHook, wakeAgent, type HookInput } from "./lib/hook-io.ts";
import { claimListener, isCurrentListener, releaseListener } from "./lib/listener-lock.ts";
import { gitDirOf, takeSnapshot } from "./lib/snapshot.ts";

const POLL_MS = 1000;

function debug(message: string): void {
  if (process.env.COWORK_DEBUG === "1") process.stderr.write(`[cowork] ${message}\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(input: HookInput): Promise<void> {
  if (missingSettings(["agent", "stdbDb"]).length > 0) return;
  const me = config.agent;
  const cwd = input.cwd ?? process.cwd();
  const gitDir = await gitDirOf(cwd);

  try {
    const snapshot = await takeSnapshot(cwd, me);
    if (snapshot) {
      await callReducer("post_snapshot", [me, snapshot.sha, snapshot.baseSha, snapshot.files, snapshot.diff]);
      debug(`snapshot ${snapshot.sha.slice(0, 8)} pushed (${snapshot.files.length} files)`);
    }
  } catch (error) {
    debug(`snapshot failed: ${String(error)}`);
  }

  claimListener(gitDir);
  const deadline = Date.now() + config.listenerMinutes * 60_000;
  try {
    while (Date.now() < deadline) {
      if (!isCurrentListener(gitDir)) return;
      try {
        const rows = await selectRows("inbox", `agent = ${sqlString(me)} AND kind = 'conflict' AND delivered = false`);
        if (rows.length > 0) {
          const newest = rows.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
          const [conflict] = await selectRows("conflict", `id = ${Number(newest.conflictId)}`);
          await callReducer("mark_delivered", [rows.map((row) => row.id)]);
          if (conflict && (conflict.status === "open" || conflict.status === "escalated")) {
            releaseListener(gitDir);
            wakeAgent(conflictForFixer(conflict));
          }
        }
      } catch (error) {
        debug(`poll failed: ${String(error)}`);
      }
      await sleep(POLL_MS);
    }
  } finally {
    releaseListener(gitDir);
  }
}

await runHook(main, (config.listenerMinutes + 1) * 60_000);
