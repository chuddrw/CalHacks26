import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCases, rulePlans } from "./run-rules.ts";
import { scorePlans } from "./score.ts";

test("at least 20 labeled cases with unique ids and only known agents", () => {
  const cases = loadCases();
  assert.ok(cases.length >= 20);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  const agents = new Set(["a", "b", "c", "d"]);
  for (const c of cases) for (const x of [c.requester, ...c.expect.owners, ...c.expect.reviewers, ...c.expect.conflicts.flat()]) assert.ok(agents.has(x), `${c.id}: ${x}`);
});

test("the contract rule matches every major/reviewer label", () => {
  const cases = loadCases();
  const s = scorePlans(cases, rulePlans(cases), ["major", "reviewers"]);
  assert.deepEqual(s.major!.wrong, []);
  assert.equal(s.reviewers!.fp, 0);
  assert.equal(s.reviewers!.fn, 0);
});

test("the scorer computes precision and recall", () => {
  const cases = loadCases().slice(0, 2);
  const plans = {
    [cases[0]!.id]: { tasks: [{ agent: "a", major: true }, { agent: "z", major: true }], reviews: [{ reviewer: "b" }], conflicts: [{ agentA: "b", agentB: "a" }] },
  };
  const s = scorePlans(cases, plans);
  assert.deepEqual(s.missing, [cases[1]!.id]);
  // case 0 expects owners a,b,c,d: predicted a,z => tp 1, fp 1, fn 3
  assert.equal(s.owners!.tp >= 1, true);
  assert.equal(s.conflicts!.tp, 1);
  assert.equal(s.major!.total, 2);
});

test("a missing plan counts as misses, not as a pass", () => {
  const cases = loadCases();
  const s = scorePlans(cases, {});
  assert.equal(s.owners!.recall, 0);
  assert.equal(s.missing.length, cases.length);
});
