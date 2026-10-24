/**
 * scripts/seed-fake.ts
 *
 * WHAT IT'S FOR
 *   Fills every table with fake rows that match the demo scenario (a switches lastLogin to
 *   milliseconds, b's new idle code assumes seconds), so D can build the UI and we can pass
 *   checkpoint 1 without waiting for real hooks or a real watcher.
 *
 * OWNER: D (uses it the most). WHEN: Sat 9:20, as soon as C's reducers exist.
 * USAGE (from the repo root, with .env filled in): npm run seed
 *   Then clean up with `npm run reset` before any real run or rehearsal.
 * DONE WHEN: four agent cards, one red conflict a x b, Droid steps and a timeline show up on every
 *            open dashboard.
 *
 * NOTES
 *   - Uses shared/src/stdb-http.ts, so it also smoke-tests the HTTP path the hooks depend on.
 *   - Only ever run it against our own development database. The rows are fake.
 *   - Reducers don't return ids, so the script looks up the new conflict's id with a SQL query.
 */
import { config, missingSettings } from "../shared/src/config.ts";
import { callReducer, selectRows, sqlString } from "../shared/src/stdb-http.ts";
import { pairKey, runKey } from "../shared/src/schema.ts";

const missing = missingSettings(["stdbDb"]);
if (missing.length > 0) {
  console.error(`Fill in ${missing.join(", ")} in .env first (see .env.example).`);
  process.exit(1);
}

const diffA = [
  "--- a/src/users/user.ts",
  "+++ b/src/users/user.ts",
  "@@ -14 +14 @@",
  "-  u.lastLogin = Math.floor(at.getTime() / 1000);",
  "+  u.lastLogin = at.getTime();",
].join("\n");

const diffB = [
  "--- /dev/null",
  "+++ b/src/sessions/idle.ts",
  "@@ -0,0 +7 @@",
  "+  return (now.getTime() / 1000 - user.lastLogin) / 60;",
].join("\n");

// register_agent needs a live WebSocket in Part C's module; a note creates the agent rows instead.
await callReducer("send_note", ["c", "info", "[cowork] Seeded demo note for c."]);
await callReducer("send_note", ["d", "info", "[cowork] Seeded demo note for d."]);
await callReducer("post_snapshot", ["a", "fake-a1", "fake-main", ["src/users/user.ts", "src/sessions/session.ts"], diffA]);
await callReducer("post_snapshot", ["b", "fake-b1", "fake-main", ["src/sessions/idle.ts", "src/sessions/idle.test.ts"], diffB]);
await callReducer("post_intent", [
  "a",
  "Changing User.lastLogin from seconds to milliseconds because the frontend needs ms.",
  ["src/users/user.ts", "src/contracts/user.ts"],
  ["User.lastLogin", "recordLogin"],
]);

const key = runKey(["fake-a1", "fake-b1"]);
const error = "FAIL src/sessions/idle.test.ts > minutesSinceLastLogin > counts minutes since login\nAssertionError: expected -29850839249 to be 31";
await callReducer("report_check", [key, ["a", "b"], "red", error]);
await callReducer("report_conflict", ["pair", "a", "b", "src/users/user.ts:14", "src/sessions/idle.ts:7", error, "b", key]);

const [conflict] = await selectRows("conflict", `pair = ${sqlString(pairKey("a", "b"))}`);
if (conflict) {
  await callReducer("add_diagnosis_step", [conflict.id, "droid", "status", "started"]);
  await callReducer("add_diagnosis_step", [conflict.id, "droid", "tool_call", "npx vitest run src/sessions/idle.test.ts"]);
  await callReducer("add_diagnosis_step", [conflict.id, "droid", "tool_result", "1 failed: expected -29850839249 to be 31"]);
  await callReducer("set_explanation", [
    conflict.id,
    "a now stores lastLogin in milliseconds, but b's minutesSinceLastLogin still divides now by 1000 and treats lastLogin as seconds. Compute the difference in milliseconds and divide by 60000.",
  ]);
  console.log(`Seeded fake rows into ${config.stdbDb}: agents a-d, conflict #${conflict.id}. Run \`npm run reset\` when done.`);
} else {
  console.log("Seeded snapshots and the check, but no conflict row came back. Is report_conflict implemented in the module yet?");
}
