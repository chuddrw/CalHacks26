/** WHAT IT'S FOR: the Metrics numbers and the Ask box's request text. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScene } from "./fixtures.ts";
import { emptyTables } from "../src/dashboard.ts";
import { computeMetrics, formatCost, formatDuration, formatPercent, formatTokens, groupUsage, sampleUsage, usageRows } from "../src/metrics.ts";
import { draftProblem, requestBody } from "../src/ask.ts";

test("empty tables and a missing usage table give zeros and no rates", () => {
  const m = computeMetrics(emptyTables());
  assert.equal(usageRows(emptyTables()).length, 0);
  assert.equal(m.usage.total.calls, 0);
  assert.equal(m.conflicts.escalationRate, null);
  assert.equal(m.checks.passRate, null);
  assert.equal(m.builds.greenRate, null);
  assert.equal(formatPercent(null), "–");
});

test("usage groups by agent, request and phase and sorts by cost", () => {
  const rows = sampleUsage(1_000_000);
  const agents = groupUsage(rows, (r) => r.agent);
  assert.equal(agents[0]!.key, "a");
  const total = rows.reduce((sum, r) => sum + r.costUsd, 0);
  assert.ok(Math.abs(groupUsage(rows, () => "all")[0]!.costUsd - total) < 1e-9);
  const m = computeMetrics({ ...emptyTables(), usage: rows } as never);
  assert.equal(m.usage.byPhase.map((p) => p.key).sort().join(), "checking,implementing,negotiating,planning");
  assert.equal(m.usage.byRequest[0]!.key, "#1");
});

test("conflict, check, build and human-load numbers come from the tables", () => {
  const resolved = computeMetrics(buildScene("resolved", 100000));
  assert.equal(resolved.conflicts.resolved, 1);
  assert.equal(resolved.conflicts.open, 0);
  const escalated = computeMetrics(buildScene("escalated", 100000));
  assert.equal(escalated.conflicts.escalated, 1);
  assert.equal(escalated.conflicts.escalationRate, 1);
  assert.equal(escalated.human.escalatedConflicts, 1);
  assert.equal(computeMetrics(buildScene("needs_human", 100000)).human.testChangesWaiting, 1);
});

test("formatters", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(2_500_000), "2.5M");
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(1.234), "$1.23");
  assert.equal(formatDuration(0), "–");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(5 * 60_000), "5 min");
});

test("Ask: plain request, roles and goal setups produce one text, and bad drafts say why", () => {
  assert.equal(draftProblem({ text: "", setup: { mode: "none" } }), "Write what you want done.");
  assert.equal(draftProblem({ text: "x", setup: { mode: "none" } }), "");
  assert.equal(requestBody({ text: " hi ", setup: { mode: "none" } }), "hi");
  const roles = { text: "", setup: { mode: "roles" as const, roles: [{ person: "Ann", feature: "login", paths: "src/users/" }, { person: "", feature: "", paths: "" }] } };
  assert.match(requestBody(roles), /- Ann: login \(src\/users\/\)/);
  assert.equal(draftProblem(roles), "");
  assert.notEqual(draftProblem({ text: "", setup: { mode: "roles", roles: [] } }), "");
  const goal = { text: "", setup: { mode: "goal" as const, goal: "a todo app", constraints: "36 hours" } };
  assert.match(requestBody(goal), /Goal: a todo app\nConstraints: 36 hours/);
  assert.notEqual(draftProblem({ text: "", setup: { mode: "goal", goal: " ", constraints: "" } }), "");
  assert.match(draftProblem({ text: "x".repeat(5000), setup: { mode: "none" } }), /Too long/);
});
