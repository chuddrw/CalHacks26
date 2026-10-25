/** WHAT IT'S FOR: which arrows the graph flashes, from whom to whom, as the demo story moves on. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pulledNote, pullerOf } from "../../shared/src/schema.ts";
import { buildDemo, type DemoScene } from "../src/demo.ts";
import { newTransfers, transfers } from "../src/transfers.ts";

const NOW = 1_000_000;
const keys = (scene: DemoScene) => new Set(transfers(buildDemo(scene, NOW)).map((x) => x.key));
const step = (from: DemoScene, to: DemoScene) =>
  newTransfers(keys(from), transfers(buildDemo(to, NOW)));
const arrow = (x: { from: string; to: string[] }) => `${x.from}->${x.to.join(",")}`;

test("pull notes round-trip", () => {
  assert.equal(pullerOf(pulledNote("b", ["src/a.ts"])), "b");
  assert.equal(pullerOf("[cowork] b plans: something"), null);
});

test("working: request, tasks and reviews flow through the orchestrator and people", () => {
  const all = transfers(buildDemo("working", NOW));
  const by = (key: string) => all.find((x) => x.key === key)!;
  assert.equal(arrow(by("request-4")), "a->orchestrator");
  assert.equal(arrow(by("task-8")), "orchestrator->b");
  assert.match(by("task-8").text, /^task #8: Read lastLogin as milliseconds/);
  assert.equal(arrow(by("review-ask-1")), "orchestrator->people");
  assert.equal(arrow(by("review-2")), "people->orchestrator");
  assert.equal(by("snapshot-1-demo-a100000").via, "git");
  assert.equal(arrow(by("snapshot-1-demo-a100000")), "a->b,c,d");
});

// Oldest first: in the demo rows the orchestrator's first thread message is 1 s older than the conflict.
test("working -> conflict: B's approval, the clash, the thread and the full stack are new", () => {
  const fresh = step("working", "conflict");
  assert.deepEqual(
    fresh.map((x) => [x.key, arrow(x)]),
    [
      ["build-1", "orchestrator->a,b,c,d"],
      ["review-1", "people->orchestrator"],
      ["message-1", "orchestrator->a,b"],
      ["conflict-12", "a->b"],
      ["message-2", "a->b"],
    ],
  );
  assert.match(fresh[1]!.text, /^B's human approved #4/);
});

test("conflict -> fixing: B pulls A's code (via git), then agrees", () => {
  const fresh = step("conflict", "fixing");
  assert.deepEqual(fresh.map((x) => [x.key, arrow(x), x.via]), [
    ["pull-1", "b->a", "git"],
    ["message-3", "b->a", "DB"],
  ]);
  assert.match(fresh[1]!.text, /^agrees: /);
});

test("fixing -> resolved: A agrees, tasks report back, fact and full stack go to everyone", () => {
  const fresh = step("fixing", "resolved").map((x) => [x.key, arrow(x)]);
  for (const expected of [
    ["message-4", "a->b"],
    ["snapshot-2-demo-b200000", "b->a,c,d"],
    ["resolved-12", "a->b"],
    ["intent-5", "orchestrator->a,b,c,d"],
    ["task-done-7", "a->orchestrator"],
    ["task-done-8", "b->orchestrator"],
    ["build-2", "orchestrator->a,b,c,d"],
  ])
    assert.ok(fresh.some((x) => x[0] === expected[0] && x[1] === expected[1]), expected.join(" "));
});

test("escalation goes to the people, their decision to both agents", () => {
  const esc = step("conflict", "escalated");
  assert.equal(arrow(esc.find((x) => x.key === "message-3")!), "b->people");
  const t = buildDemo("escalated", NOW);
  t.message.push({ id: 9, conflictId: 12, author: "human", kind: "decision", body: "Use ms.", createdAt: NOW });
  const decision = transfers(t).find((x) => x.key === "message-9")!;
  assert.equal(arrow(decision), "people->a,b");
});

test("the same scene twice adds nothing", () => {
  assert.deepEqual(step("conflict", "conflict"), []);
});
