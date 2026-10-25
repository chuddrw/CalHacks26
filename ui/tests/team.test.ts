/** WHAT IT'S FOR: the graph, "now" lines and human actions the dashboard shows, for every demo scene. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDemo } from "../src/demo.ts";
import {
  activity,
  agentNow,
  needsYou,
  RESOLVED_VISIBLE_MS,
  teamGraph,
} from "../src/team.ts";

const NOW = 1_000_000;
const edge = (scene: Parameters<typeof buildDemo>[0], id: string) =>
  teamGraph(buildDemo(scene, NOW), NOW).edges.find((e) => e.id === id);

test("the graph has the orchestrator and every agent", () => {
  const { nodes } = teamGraph(buildDemo("conflict", NOW), NOW);
  assert.deepEqual(
    nodes.map((n) => n.id),
    ["orchestrator", "people", "a", "b", "c", "d"],
  );
  assert.match(nodes[0]!.doing, /^#4 from A: /);
});

test("working: tasks wait for review, B's review is pending, D's is done", () => {
  const t = buildDemo("working", NOW);
  const { nodes, edges } = teamGraph(t, NOW);
  assert.equal(nodes[0]!.state, "Waiting for review");
  const tasks = edges.filter((e) => e.kind === "task");
  assert.deepEqual(tasks.map((e) => e.to).sort(), ["a", "b"]);
  assert.ok(tasks.every((e) => e.dashed && !e.active));
  const reviews = edges.filter((e) => e.kind === "review");
  assert.deepEqual(
    reviews.map((e) => [e.from, e.to, e.tone]),
    [
      ["b", "a", "amber"],
      ["d", "a", "neutral"],
    ],
  );
  assert.equal(edges.filter((e) => e.kind === "conflict").length, 0);
  assert.equal(nodes.find((n) => n.id === "people")?.state, "1 needs you");
  const actions = needsYou(t);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.who, "B's human");
  assert.deepEqual(actions[0]!.select, { kind: "request", id: 4 });
  const a = agentNow(t, t.agent[0]!);
  assert.equal(a.source, "task");
  assert.match(a.doing, /^Waiting for review: Store User.lastLogin/);
  assert.ok(agentNow(t, t.agent[1]!).badges.includes("Reviews request #4"));
});

test("conflict: both tasks are live, A and B are talking, nobody needs a human", () => {
  const t = buildDemo("conflict", NOW);
  const { edges } = teamGraph(t, NOW);
  const tasks = edges.filter((e) => e.kind === "task");
  assert.ok(tasks.every((e) => e.active && e.tone === "accent"));
  assert.equal(edge("conflict", "task-7")?.label, "doing: Store User.lastLogin in milliseconds");
  assert.equal(edges.filter((e) => e.kind === "review").length, 0);
  const c = edge("conflict", "conflict-12");
  assert.equal(c?.tone, "red");
  assert.equal(c?.label, "#12 talking · 2 messages");
  assert.deepEqual(needsYou(t), []);
  const b = agentNow(t, t.agent[1]!);
  assert.equal(b.doing, "Read lastLogin as milliseconds in sessions");
  assert.deepEqual(b.badges, ["In thread with A"]);
  assert.equal(b.state, "Red");
});

test("fixing: one side agreed", () => {
  assert.equal(edge("fixing", "conflict-12")?.label, "#12 B agreed · waiting on A");
});

test("resolved: green conflict for a while, done tasks, healthy agents", () => {
  const t = buildDemo("resolved", NOW);
  assert.equal(edge("resolved", "conflict-12")?.tone, "green");
  assert.equal(edge("resolved", "conflict-12")?.label, "#12 agreed");
  assert.ok(
    teamGraph(t, NOW)
      .edges.filter((e) => e.kind === "task")
      .every((e) => e.tone === "green" && !e.active),
  );
  const later = NOW + RESOLVED_VISIBLE_MS + 10_000;
  assert.equal(
    teamGraph(t, later).edges.find((e) => e.kind === "conflict"),
    undefined,
  );
  assert.deepEqual(needsYou(t), []);
});

test("escalated and test-edit scenes ask the right humans", () => {
  const escalated = needsYou(buildDemo("escalated", NOW));
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0]!.who, "A's and B's humans");
  assert.equal(edge("escalated", "conflict-12")?.label, "#12 humans decide");
  const tests = needsYou(buildDemo("needs_human", NOW));
  assert.equal(tests.length, 1);
  assert.match(tests[0]!.text, /changed existing tests/);
  assert.equal(edge("needs_human", "conflict-12")?.tone, "amber");
});

test("an offline agent says so and has no busy task", () => {
  const t = buildDemo("conflict", NOW);
  t.agent[2] = { ...t.agent[2]!, online: false };
  const c = teamGraph(t, NOW).nodes.find((n) => n.id === "c")!;
  assert.equal(c.state, "Offline");
  assert.equal(c.busy, false);
});

test("a task assigned to an offline agent waits instead of claiming work", () => {
  const t = buildDemo("conflict", NOW);
  t.agent[1] = { ...t.agent[1]!, online: false };
  const b = teamGraph(t, NOW).edges.find((e) => e.id === "task-8")!;
  assert.equal(b.active, false);
  assert.equal(b.dashed, true);
  assert.equal(b.label, "waiting, B offline: Read lastLogin as milliseconds in sessions");
});

test("a self conflict marks the agent instead of drawing an edge", () => {
  const t = buildDemo("working", NOW);
  t.conflict = [
    {
      id: 30, pair: "c", kind: "self", agentA: "c", agentB: "", locA: "", locB: "",
      error: "tsc failed", explanation: "", fixer: "c", status: "open", runKey: "x",
      createdAt: NOW, resolvedAt: 0,
    },
  ];
  const g = teamGraph(t, NOW);
  assert.equal(g.nodes.find((n) => n.id === "c")?.state, "Own check fails #30");
  assert.equal(g.edges.filter((e) => e.kind === "conflict").length, 0);
});

test("activity mixes the orchestrator's events with checks, newest first", () => {
  const events = activity(buildDemo("resolved", NOW));
  assert.ok(events.some((e) => e.id === "request-4"));
  assert.ok(events.some((e) => e.id === "task-done-7"));
  assert.ok(events.some((e) => e.id === "message-1"));
  assert.ok(events.some((e) => e.id === "resolved-12"));
  for (let i = 1; i < events.length; i++)
    assert.ok(events[i - 1]!.at >= events[i]!.at);
});
