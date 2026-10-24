/** WHAT IT'S FOR: explicitly simulated, local-only scenes from plan.md. Never writes to a database. */
import type {
  AgentRow,
  ConflictRow,
  DiagnosisStepRow,
} from "../../shared/src/schema.ts";
import { emptyTables, type Tables } from "./dashboard";
import { replaceTables, setConnection } from "./store";

export const demoScenes = [
  "working",
  "conflict",
  "fixing",
  "resolved",
  "escalated",
  "needs_human",
] as const;
export type DemoScene = (typeof demoScenes)[number];
export const sceneLabels: Record<DemoScene, string> = {
  working: "01 · Agents working",
  conflict: "02 · Conflict detected",
  fixing: "03 · B is fixing",
  resolved: "04 · Verified & green",
  escalated: "Escalated",
  needs_human: "Test-edit guard",
};
export function initialScene(): DemoScene {
  const value = new URLSearchParams(location.search).get("scene");
  return demoScenes.includes(value as DemoScene)
    ? (value as DemoScene)
    : "conflict";
}
export function buildDemo(scene: DemoScene, now = Date.now()): Tables {
  const t = emptyTables();
  const start = now - 60000;
  const resolved = scene === "resolved";
  const working = scene === "working";
  const conflict: ConflictRow = {
    id: 12,
    pair: "a+b",
    kind: "pair",
    agentA: "a",
    agentB: "b",
    locA: "src/users/user.ts:14",
    locB: "src/sessions/idle.ts:7",
    error:
      "FAIL src/sessions/idle.test.ts > counts minutes since login\nAssertionError: expected -29850839249 to be 31",
    explanation:
      scene === "conflict"
        ? ""
        : "A now stores lastLogin in milliseconds. B's new idle-time calculation still treats it as seconds. B should compute the difference in milliseconds, then divide by 60,000.",
    fixer: "b",
    status: resolved
      ? "resolved"
      : scene === "escalated"
        ? "escalated"
        : scene === "needs_human"
          ? "needs_human"
          : "open",
    runKey: "demo-a+demo-b",
    createdAt: start + 22000,
    resolvedAt: resolved ? now - 4000 : 0,
  };
  const people = [
    [
      "a",
      "Updating login timestamps to milliseconds",
      ["src/users/user.ts", "src/sessions/session.ts"],
    ],
    [
      "b",
      resolved
        ? "Updated idle-time calculation; tests pass"
        : scene === "fixing"
          ? "Pulled A's snapshot; adapting idle-time calculation"
          : "Adding an idle-time feature",
      ["src/sessions/idle.ts", "src/sessions/idle.test.ts"],
    ],
    [
      "c",
      resolved
        ? "Using the verified timestamp contract"
        : "Building login activity analytics",
      ["src/analytics/activity.ts"],
    ],
    ["d", "Building the team dashboard", ["src/api/routes.ts"]],
  ] as const;
  t.agent = people.map(([name, intent, files]): AgentRow => ({
    name,
    online: true,
    status: working
      ? name === "a"
        ? "working"
        : "green"
      : !resolved && (name === "a" || name === "b")
        ? "red"
        : "green",
    intent,
    files: [...files],
    lastSnapshotAt:
      start + (name === "a" ? 16000 : name === "b" ? 10000 : 1000),
  }));
  const diffA =
    "diff --git a/src/users/user.ts b/src/users/user.ts\n--- a/src/users/user.ts\n+++ b/src/users/user.ts\n@@ -12,4 +12,4 @@\n export function recordLogin(u: User, at: Date) {\n   // Store the login timestamp\n-  u.lastLogin = Math.floor(at.getTime() / 1000);\n+  u.lastLogin = at.getTime();\n }";
  const diffB = resolved
    ? "diff --git a/src/sessions/idle.ts b/src/sessions/idle.ts\n--- a/src/sessions/idle.ts\n+++ b/src/sessions/idle.ts\n@@ -5,4 +5,4 @@\n export function minutesSinceLastLogin(user: User, now: Date) {\n   // Keep the units consistent\n-  return (now.getTime() / 1000 - user.lastLogin) / 60;\n+  return (now.getTime() - user.lastLogin) / 60000;\n }"
    : "diff --git a/src/sessions/idle.ts b/src/sessions/idle.ts\n--- /dev/null\n+++ b/src/sessions/idle.ts\n@@ -0,0 +5,4 @@\n+export function minutesSinceLastLogin(user: User, now: Date) {\n+  // Minutes since the last login\n+  return (now.getTime() / 1000 - user.lastLogin) / 60;\n+}";
  t.snapshot = [
    {
      id: 1,
      agent: "a",
      sha: "demo-a100000",
      baseSha: "demo-main",
      files: [...people[0][2]],
      diff: diffA,
      createdAt: start + 16000,
    },
    {
      id: 2,
      agent: "b",
      sha: "demo-b100000",
      baseSha: "demo-main",
      files: [...people[1][2]],
      diff: diffB,
      createdAt: start + 10000,
    },
    ...people.slice(2).map(([agent, , files], i) => ({
      id: i + 3,
      agent,
      sha: `demo-${agent}100000`,
      baseSha: "demo-main",
      files: [...files],
      diff: "", // Unaffected example snapshots do not need code excerpts for the A/B scenario.
      createdAt: start + 1000,
    })),
  ];
  t.intent = people.map(([agent, summary, files], i) => ({
    id: i + 1,
    agent,
    summary,
    files: [...files],
    symbols: i < 2 ? ["User.lastLogin"] : [],
    verified: false,
    createdAt: start + i * 1000,
  }));
  t.check_run = [
    {
      runKey: "demo-baseline",
      agents: ["a", "b", "c", "d"],
      result: "green",
      log: "Simulated baseline: typecheck passed; 6 tests passed.",
      createdAt: start + 5000,
    },
  ];
  if (!working) {
    t.conflict = [conflict];
    t.check_run.push({
      runKey: conflict.runKey,
      agents: ["a", "b", "c", "d"],
      result: "red",
      log: conflict.error,
      createdAt: start + 20000,
    });
    const steps: Array<[DiagnosisStepRow["kind"], string]> = [
      [
        "status",
        "Investigating the combined failure in a disposable worktree.",
      ],
      ["tool_call", "git diff demo-main demo-a100000 -- src/users/user.ts"],
      ["tool_result", "recordLogin now writes at.getTime(): milliseconds."],
      ["tool_call", "npx vitest run src/sessions/idle.test.ts"],
      ["tool_result", "1 failed · expected -29850839249 to be 31"],
      [
        "final",
        "Unit mismatch: milliseconds × seconds. Keep both timestamps in milliseconds and divide the difference by 60,000.",
      ],
    ];
    t.diagnosis_step = steps
      .slice(0, scene === "conflict" ? 3 : steps.length)
      .map(([kind, detail], i) => ({
        id: i + 1,
        conflictId: conflict.id,
        source: "droid",
        kind,
        detail,
        createdAt: start + 23000 + i * 1500,
      }));
  }
  if (resolved) {
    t.snapshot[1] = {
      ...t.snapshot[1],
      sha: "demo-b200000",
      createdAt: now - 8000,
    };
    t.agent[1] = { ...t.agent[1], lastSnapshotAt: now - 8000 };
    t.check_run.push({
      runKey: "demo-a+demo-b-fixed",
      agents: ["a", "b", "c", "d"],
      result: "green",
      log: "Simulated result: typecheck passed; 6 tests passed. Existing tests unchanged.",
      createdAt: now - 5000,
    });
    t.intent.push({
      id: 5,
      agent: "watcher",
      summary: "User.lastLogin is milliseconds since the Unix epoch.",
      files: ["src/users/user.ts", "src/sessions/idle.ts"],
      symbols: ["User.lastLogin"],
      verified: true,
      createdAt: now - 3000,
    });
  }
  return t;
}
export function showDemoScene(scene: DemoScene): void {
  replaceTables(buildDemo(scene));
  setConnection({
    phase: "demo",
    detail: "Simulated data. No agents, tests, or database are running.",
  });
}
export function startDemo(): () => void {
  showDemoScene(initialScene());
  return () => {
    /* no background connection and no writes */
  };
}
