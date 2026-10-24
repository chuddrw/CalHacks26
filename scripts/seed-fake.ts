/**
 * WHAT IT'S FOR: seed clearly simulated dashboard rows through the real reducer contract.
 * Owner: D. Use only the team's development database; this does not run agents or tests.
 * Usage: npm run seed -- --dry-run | --scene conflict|resolved|escalated|needs_human
 * Repeated runs use distinct run keys and select the matching new/open conflict.
 * No reset or branch mutation is performed. Real presence requires A's MCP connections.
 */
import { config, missingSettings } from "../shared/src/config.ts";
import { callReducer, selectRows, sqlString } from "../shared/src/stdb-http.ts";
import { pairKey, runKey, type ConflictStatus } from "../shared/src/schema.ts";
import { buildDemo, type DemoScene } from "../ui/src/demo.ts";

const allowed = ["conflict", "resolved", "escalated", "needs_human"] as const;
const args = process.argv.slice(2);
const index = args.indexOf("--scene");
const scene = (
  index >= 0 ? args[index + 1] : "conflict"
) as (typeof allowed)[number];
if (!allowed.includes(scene))
  throw new Error(`Unknown scene. Choose: ${allowed.join(", ")}`);
// Escalation is module-owned; do not fabricate timer behavior via client-side reducers.
if (scene === "escalated")
  throw new Error(
    "Seed a conflict, then let C's real escalation timer fire. Use ?demo&scene=escalated for a local-only preview.",
  );
const tables = buildDemo(scene as DemoScene);
if (args.includes("--dry-run")) {
  console.log(
    JSON.stringify(
      {
        mode: "dry-run",
        scene,
        database: config.stdbDb || "(not configured)",
        agents: tables.agent.map((a) => a.name),
        snapshots: tables.snapshot.length,
        check: scene === "resolved" ? "green" : "red",
        checkSequence: scene === "resolved" ? ["red", "green"] : ["red"],
        finalStatus:
          scene === "resolved"
            ? "resolved"
            : scene === "needs_human"
              ? "needs_human"
              : "open",
        diagnosisSteps: tables.diagnosis_step.length,
        writesPerformed: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const missing = missingSettings(["stdbDb", "stdbToken"]);
if (missing.length)
  throw new Error(`Fill in ${missing.join(", ")} in .env first.`);
console.log(
  `Seeding SIMULATED data into ${config.stdbDb}. No agents or checks are running.`,
);
for (const agent of tables.agent)
  await callReducer("register_agent", [agent.name]);
const suffix = Date.now().toString(36);
const shas = tables.snapshot.map((s) => `${s.sha}-${suffix}`);
for (const [i, snapshot] of tables.snapshot.entries()) {
  await callReducer("post_snapshot", [
    snapshot.agent,
    shas[i],
    snapshot.baseSha,
    snapshot.files,
    snapshot.diff,
  ]);
}
for (const intent of tables.intent.filter((i) => !i.verified)) {
  await callReducer("post_intent", [
    intent.agent,
    intent.summary,
    intent.files,
    intent.symbols,
  ]);
}
const key = runKey(shas);
await callReducer("report_check", [runKey(shas.slice(2)), ["c", "d"], "green", "[SIMULATED] Unaffected C/D snapshots pass their check."]);
const failure = tables.conflict[0];
await callReducer("report_check", [
  key,
  tables.agent.map((a) => a.name),
  "red",
  `[SIMULATED] ${failure.error}`,
]);
await callReducer("report_conflict", [
  failure.kind,
  failure.agentA,
  failure.agentB,
  failure.locA,
  failure.locB,
  `[SIMULATED] ${failure.error}`,
  failure.fixer,
  key,
]);
const openStatuses: ConflictStatus[] = ["open", "escalated"];
const conflicts = await selectRows(
  "conflict",
  `pair = ${sqlString(pairKey("a", "b"))}`,
);
const conflict = conflicts
  .filter((c) => c.runKey === key && openStatuses.includes(c.status))
  .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0];
if (!conflict)
  throw new Error(
    "report_conflict did not produce the expected row. Check C's module reducer implementation.",
  );
for (const step of tables.diagnosis_step) {
  await callReducer("add_diagnosis_step", [
    conflict.id,
    step.source,
    step.kind,
    `[SIMULATED] ${step.detail}`,
  ]);
}
await callReducer("set_explanation", [
  conflict.id,
  `[SIMULATED] ${failure.explanation || "Timestamp unit mismatch: A writes milliseconds; B assumes seconds. B should divide the difference in milliseconds by 60,000."}`,
]);
if (scene === "resolved") {
  await callReducer("report_check", [
    key,
    tables.agent.map((a) => a.name),
    "green",
    "[SIMULATED] Typecheck and tests pass. This is fixture data.",
  ]);
  await callReducer("resolve_conflict", [
    conflict.id,
    "[SIMULATED] User.lastLogin is milliseconds since the Unix epoch.",
  ]);
  const resolved = await selectRows("conflict", `id = ${conflict.id}`);
  if (resolved[0]?.status !== "resolved")
    throw new Error("The module did not resolve the seeded conflict. Check current-snapshot green evidence before presenting this scene.");
} else if (scene === "needs_human") {
  await callReducer("flag_needs_human", [
    conflict.id,
    "[SIMULATED] The proposed fix modified src/sessions/idle.test.ts. Human review required.",
  ]);
}
console.log(
  `Seeded simulated ${scene} scene, conflict #${conflict.id}. Do not use this as evidence of the live loop. Clean up with C's reset procedure before real rehearsals.`,
);
