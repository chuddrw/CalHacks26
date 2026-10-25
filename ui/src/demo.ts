/** WHAT IT'S FOR: explicitly simulated, local-only scenes from plan.md. Never writes to a database. */
import {
  pulledNote,
  type AgentRow,
  type ConflictRow,
  type DiagnosisStepRow,
} from "../../shared/src/schema.ts";
import { emptyTables, type Tables } from "./dashboard";
import { getSnapshot, replaceTables, setConnection } from "./store";

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
      agent: "orchestrator",
      summary: "User.lastLogin is milliseconds since the Unix epoch.",
      files: ["src/users/user.ts", "src/sessions/idle.ts"],
      symbols: ["User.lastLogin"],
      verified: true,
      createdAt: now - 3000,
    });
  }
  addOrchestrator(t, scene, start, now);
  return t;
}

/** The orchestrator's side of each scene: A's request, Droid's plan, the reviews, both tasks, the thread. */
function addOrchestrator(t: Tables, scene: DemoScene, start: number, now: number): void {
  const reviewing = scene === "working";
  const done = scene === "resolved";
  t.request = [
    {
      id: 4,
      agent: "a",
      body: "The frontend needs User.lastLogin in milliseconds since the Unix epoch.",
      status: reviewing ? "waiting_review" : done ? "done" : "assigned",
      summary:
        "A changes the shared User.lastLogin contract and recordLogin to milliseconds. B adapts the session timeout and its in-progress idle feature. B's and D's humans review first, because their features read lastLogin.",
      plan: "",
      createdAt: start - 30000,
      updatedAt: start - 5000,
    },
  ];
  const steps: Array<[TaskRowKind, string]> = [
    ["status", "Droid is reading the request and the team's state"],
    ["tool_call", "team_status {}"],
    ["tool_call", 'Grep {"pattern":"lastLogin","path":"src"}'],
    ["tool_call", 'Read {"file_path":"src/sessions/session.ts"}'],
    ["tool_call", 'assign_task {"agent":"a","title":"Store User.lastLogin in milliseconds"}'],
    ["tool_call", 'assign_task {"agent":"b","title":"Read lastLogin as milliseconds in sessions"}'],
    ["tool_call", 'flag_conflict {"agentA":"a","agentB":"b","topic":"lastLogin unit"}'],
    ["status", "Rule: B (b) reviews first, because src/sessions/session.ts imports src/contracts/user.ts."],
    ["final", "2 task(s), 2 review(s), 1 flagged conflict(s)."],
  ];
  t.plan_step = steps.map(([kind, detail], i) => ({ id: i + 1, requestId: 4, kind, detail, createdAt: start - 29000 + i * 1500 }));
  t.review = [
    { id: 1, requestId: 4, reviewer: "b", summary: "lastLogin becomes milliseconds; the session timeout and the new idle feature read it.", status: reviewing ? "pending" : "approved", answer: reviewing ? "" : "Sessions will follow.", createdAt: start - 15000, decidedAt: reviewing ? 0 : start - 6000 },
    { id: 2, requestId: 4, reviewer: "d", summary: "getUserRoute passes lastLogin through, so the frontend JSON changes unit too.", status: "approved", answer: "", createdAt: start - 15000, decidedAt: start - 8000 },
  ];
  const taskStatus = reviewing ? "waiting_review" : done ? "done" : "assigned";
  t.task = [
    { id: 7, requestId: 4, agent: "a", title: "Store User.lastLogin in milliseconds", details: "Contract, recordLogin and its test.", files: ["src/contracts/user.ts", "src/users/user.ts", "src/users/user.test.ts"], major: true, status: taskStatus, note: done ? "lastLogin is milliseconds in the contract and users." : "", createdAt: start - 15000, updatedAt: now - 2000 },
    { id: 8, requestId: 4, agent: "b", title: "Read lastLogin as milliseconds in sessions", details: "session.ts and the in-progress idle.ts.", files: ["src/sessions/session.ts", "src/sessions/idle.ts"], major: false, status: taskStatus, note: done ? "Sessions and idle read milliseconds." : "", createdAt: start - 15000, updatedAt: now - 2000 },
  ];
  if (reviewing) return;
  t.build = [
    { id: 1, branch: "cowork/full-stack", sha: "demo1f5ac0de", mainSha: "demo-main", agents: ["b"], result: "green", log: "main + b's work; tsc and vitest pass", requestId: 0, createdAt: start - 40000 },
  ];
  if (done) t.build.push({ id: 2, branch: "cowork/full-stack", sha: "demo2b7e91aa", mainSha: "demo-main", agents: ["a", "b"], result: "green", log: "main + a's work, b's work; tsc and vitest pass", requestId: 4, createdAt: now - 1500 });
  const thread: Array<[string, MessageRowKind, string]> = [
    ["orchestrator", "message", "lastLogin unit. b's in-progress idle.ts assumes seconds. Suggested: b adapts. Agree between you who changes what."],
    ["a", "message", "I switched User.lastLogin to milliseconds in the contract and users. Please read ms in session.ts and idle.ts; pull my change first."],
  ];
  if (scene === "fixing" || done || scene === "needs_human") thread.push(["b", "agree", "User.lastLogin is milliseconds since the Unix epoch."]);
  if (done) thread.push(["a", "agree", "User.lastLogin is milliseconds since the Unix epoch."]);
  if (scene === "escalated") thread.push(["b", "escalate", "b asked for a decision: sessions are stored in seconds by the session store; switching changes how my feature persists them."]);
  t.message = thread.map(([author, kind, body], i) => ({ id: i + 1, conflictId: 12, author, kind, body, createdAt: start + 21000 + i * 6000 }));
  // B pulled A's in-progress change before agreeing (pull_teammate's note to A).
  if (scene === "fixing" || done || scene === "needs_human")
    t.inbox.push({ id: 1, agent: "a", kind: "info", conflictId: 0, message: pulledNote("b", ["src/users/user.ts", "src/sessions/session.ts"]), delivered: false, createdAt: start + 31000 });
}
type TaskRowKind = Tables["plan_step"][number]["kind"];
type MessageRowKind = Tables["message"][number]["kind"];

/** Simulated review answer: approving the last pending review releases the request's tasks. This page only. */
export function decideDemoReview(reviewId: number, approve: boolean, answer: string, now = Date.now()): void {
  const { tables } = getSnapshot();
  const review = tables.review.find((r) => r.id === reviewId);
  if (!review || review.status !== "pending") return;
  const reviews = tables.review.map((r) =>
    r.id === reviewId
      ? { ...r, status: approve ? ("approved" as const) : ("rejected" as const), answer, decidedAt: now }
      : !approve && r.requestId === review.requestId && r.status === "pending"
        ? { ...r, status: "cancelled" as const, decidedAt: now }
        : r,
  );
  const release = approve && !reviews.some((r) => r.requestId === review.requestId && r.status === "pending");
  replaceTables({
    ...tables,
    review: reviews,
    task: tables.task.map((task) =>
      task.requestId === review.requestId && task.status === "waiting_review" && (release || !approve)
        ? { ...task, status: release ? ("assigned" as const) : ("cancelled" as const), updatedAt: now }
        : task,
    ),
    request: tables.request.map((request) =>
      request.id === review.requestId && (release || !approve)
        ? { ...request, status: release ? ("assigned" as const) : ("rejected" as const), updatedAt: now }
        : request,
    ),
  });
}

/** Simulated decision by both humans: the conflict reopens with the decision in its thread. This page only. */
export function decideDemoConflict(conflictId: number, decision: string, now = Date.now()): void {
  const { tables } = getSnapshot();
  replaceTables({
    ...tables,
    conflict: tables.conflict.map((c) => (c.id === conflictId && c.status === "escalated" ? { ...c, status: "open" } : c)),
    message: [
      ...tables.message,
      { id: Math.max(0, ...tables.message.map((m) => m.id)) + 1, conflictId, author: "human", kind: "decision", body: decision, createdAt: now },
    ],
  });
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

/** Simulated answer to the test-edit guard: approve resolves, send back reopens. This page only. */
export function reviewDemoConflict(conflictId: number, approve: boolean, now = Date.now()): void {
  const { tables } = getSnapshot();
  replaceTables({
    ...tables,
    conflict: tables.conflict.map((c) =>
      c.id === conflictId && c.status === "needs_human"
        ? { ...c, status: approve ? "resolved" : "open", resolvedAt: approve ? now : 0 }
        : c,
    ),
  });
}
