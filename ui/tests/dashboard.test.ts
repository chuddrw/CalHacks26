/** WHAT IT'S FOR: verify user-visible truthfulness, scene transitions, excerpts, and SDK normalization. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDemo, demoScenes } from "../src/demo.ts";
import { emptyTables, teamHealth, timelineEvents } from "../src/dashboard.ts";
import { excerptFromDiff, parseLocation } from "../src/diff.ts";
import { normalizeRow } from "../src/live.ts";
import { relativeTime } from "../src/time.ts";

const connected = { phase: "live" as const, detail: "", updatedAt: 1 };
test("empty tables and offline cached greens never claim a healthy team", () => {
  assert.equal(teamHealth(emptyTables(), connected).tone, "neutral");
  const t = buildDemo("resolved", 100000);
  for (const phase of [
    "unconfigured",
    "connecting",
    "syncing",
    "reconnecting",
    "error",
  ] as const) {
    assert.equal(teamHealth(t, { ...connected, phase }).tone, "neutral");
  }
});
test("demo's actual working → red → fixing → green narrative is reflected in health", () => {
  assert.equal(
    teamHealth(buildDemo("working", 100000), connected).tone,
    "amber",
  );
  for (const scene of [
    "conflict",
    "fixing",
    "escalated",
    "needs_human",
  ] as const) {
    assert.equal(teamHealth(buildDemo(scene, 100000), connected).tone, "red");
  }
  assert.equal(
    teamHealth(buildDemo("resolved", 100000), connected).tone,
    "green",
  );
});
test("new snapshots invalidate a passing check; unlocalized failures stay red", () => {
  const t = buildDemo("resolved", 100000);
  t.snapshot[0].createdAt = 100001;
  assert.equal(teamHealth(t, connected).tone, "amber");
  t.snapshot = [];
  t.check_run.push({
    ...t.check_run[0],
    runKey: "latest",
    createdAt: 100002,
    result: "red",
  });
  assert.equal(teamHealth(t, connected).tone, "red");
});
test("human-review conflicts override passing checks", () => {
  const t = buildDemo("resolved", 100000);
  t.conflict[0].status = "needs_human";
  assert.match(teamHealth(t, connected).title, /needs a hand/);
});
test("passing single/pair localization checks cannot replace the full combined failure", () => {
  const t = buildDemo("conflict", 100000);
  t.conflict = [];
  t.agent.forEach((agent) => {
    agent.status = "green";
  });
  t.check_run.push({
    runKey: "single-a",
    agents: ["a"],
    result: "green",
    log: "",
    createdAt: 100001,
  });
  t.check_run.push({
    runKey: "single-b",
    agents: ["b"],
    result: "green",
    log: "",
    createdAt: 100002,
  });
  assert.equal(teamHealth(t, connected).tone, "red");
  t.check_run = t.check_run.filter((run) => run.agents.length === 1);
  assert.equal(teamHealth(t, connected).tone, "amber");
});
test("timeline includes both detection and resolution without mutating input", () => {
  const t = buildDemo("resolved", 100000);
  const before = structuredClone(t);
  const events = timelineEvents(t);
  assert(events.some((e) => e.kind === "resolved"));
  assert(events.some((e) => e.kind === "conflict"));
  assert(events.some((e) => e.kind === "fact"));
  assert(events.every((e, i) => !i || events[i - 1].at >= e.at));
  assert.deepEqual(t, before);
});
test("all simulated rows satisfy the actual shared schema validator", () => {
  for (const scene of demoScenes) {
    const t = buildDemo(scene, 100000);
    assert(
      t.agent.every((agent) =>
        t.snapshot.some(
          (s) => s.agent === agent.name && s.createdAt === agent.lastSnapshotAt,
        ),
      ),
    );
    for (const table of Object.keys(t) as (keyof typeof t)[]) {
      for (const row of t[table])
        assert.deepEqual(normalizeRow(table, row), row);
    }
  }
});
test("SDK bigint IDs normalize safely and schema drift surfaces as an error", () => {
  const row = buildDemo("resolved", 100000).intent[0];
  assert.equal(
    normalizeRow("intent", { ...row, id: 4n, createdAt: 500n }).id,
    4,
  );
  assert.throws(
    () => normalizeRow("intent", { ...row, id: 9007199254740993n }),
    /safe/,
  );
  assert.throws(
    () => normalizeRow("intent", { ...row, createdAt: 8_640_000_000_000_001 }),
    /Date range/,
  );
  assert.throws(() => normalizeRow("agent", { name: "a" }), /expected/);
  assert.throws(
    () =>
      normalizeRow("conflict", {
        ...buildDemo("conflict", 100000).conflict[0],
        status: "unknown",
      }),
    /Unknown/,
  );
});
test("excerpts locate the correct file and added lines from real-format demo diffs", () => {
  const t = buildDemo("conflict", 100000);
  assert(
    excerptFromDiff(t.snapshot[0].diff, "src/users/user.ts:14").some(
      (l) =>
        l.kind === "added" && l.newLine === 14 && l.text.includes("getTime()"),
    ),
  );
  assert(
    excerptFromDiff(t.snapshot[1].diff, "src/sessions/idle.ts:7").some(
      (l) => l.newLine === 7 && l.text.includes("/ 1000"),
    ),
  );
  assert.deepEqual(
    excerptFromDiff(t.snapshot[0].diff, "src/missing.ts:14"),
    [],
  );
  assert.deepEqual(excerptFromDiff("truncated", "src/users/user.ts:14"), []);
});
test("diff parser handles multiple files, hunks, removals, CRLF, and path colons", () => {
  const diff =
    "diff --git a/a.ts b/a.ts\r\n--- a/a.ts\r\n+++ b/a.ts\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n@@ -10 +10 @@\r\n-away\r\n+here\r\ndiff --git a/b.ts b/b.ts\r\n--- a/b.ts\r\n+++ b/b.ts\r\n@@ -1 +1 @@\r\n-other\r\n+file";
  const lines = excerptFromDiff(diff, "a.ts:10", 0);
  assert.deepEqual(
    lines.map((l) => l.text),
    ["away", "here"],
  );
  assert.deepEqual(parseLocation("C:\\repo\\a.ts:10"), {
    path: "C:/repo/a.ts",
    line: 10,
  });
  assert.equal(parseLocation("a.ts:0"), null);
});
test("relative times handle unknown and future timestamps", () => {
  assert.equal(relativeTime(0, 100000), "Never");
  assert.equal(relativeTime(100001, 100000), "Just now");
  assert.equal(relativeTime(40000, 100000), "1m ago");
});
