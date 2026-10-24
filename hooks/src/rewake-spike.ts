/**
 * hooks/src/rewake-spike.ts
 *
 * WHAT IT'S FOR
 *   Tonight's 15-minute test of the one Claude Code feature the whole design depends on:
 *   an `asyncRewake` hook that exits with code 2 wakes Claude, even when the session is idle.
 *   If this passes, the listener in snapshot-and-wait.ts will work. If it fails, we switch to
 *   the fallback before building anything else (warn on the next tool call, plus the Stop hook).
 *
 * OWNER: A. WHEN: tonight, 0:20-1:20. Delete the scratch folder afterwards.
 *
 * HOW TO RUN THE TEST
 *   1. Make an empty scratch folder OUTSIDE every repo and cd into it.
 *   2. Print the settings block and save it as <scratch>/.claude/settings.local.json:
 *        node <this repo>/hooks/src/rewake-spike.ts --print-config
 *   3. Start `claude` in the scratch folder. Ask: "Create hello.txt containing hi." Let it finish.
 *   4. Don't type anything for 25 seconds.
 *      PASS: Claude starts a new turn by itself and mentions COWORK SPIKE.
 *      FAIL: nothing happens until you type.
 *   5. Post PASS or FAIL in team chat, then delete the scratch folder.
 *
 * WHAT IT DOES WHEN CLAUDE CODE RUNS IT
 *   Reads the hook input, waits 20 seconds (long enough for the turn to end), writes a message
 *   to stderr and exits with code 2.
 */
import path from "node:path";

const WAIT_MS = 20_000;

if (process.argv.includes("--print-config")) {
  const self = path.resolve(import.meta.filename);
  const settings = {
    hooks: {
      PostToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [{ type: "command", command: "node", args: [self], asyncRewake: true, timeout: 60 }],
        },
      ],
    },
  };
  console.log(JSON.stringify(settings, null, 2));
} else {
  for await (const _chunk of process.stdin) {
    // drain the hook input; we don't need it
  }
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  process.stderr.write(
    "COWORK SPIKE: this message arrived 20 seconds after your edit, from a background hook. Reply with one line saying you got it.",
  );
  process.exit(2);
}
