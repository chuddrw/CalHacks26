/** WHAT IT'S FOR: the kickoff helpers (parsing, drafts, samples) and the configurable price table. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answersJson,
  answersProblem,
  KICKOFF_STATUSES,
  kickoffProblem,
  latestKickoff,
  membersJson,
  parseMembers,
  parseProposal,
  parseQuestions,
  sampleKickoffs,
} from "../src/kickoff.ts";
import { hasUnpriced, parsePrices, rowCost, type UsageRow } from "../src/metrics.ts";

test("samples cover every status and the newest is first", () => {
  const rows = sampleKickoffs(1_000_000);
  assert.deepEqual([...new Set(rows.map((r) => r.status))].sort(), [...KICKOFF_STATUSES].sort());
  assert.equal(latestKickoff(rows)?.id, 7);
  assert.equal(latestKickoff([]), undefined);
});

test("a proposed sample parses into owners, contracts and tasks; garbage parses to nothing", () => {
  const proposed = sampleKickoffs(0).find((r) => r.status === "proposed")!;
  const proposal = parseProposal(proposed)!;
  assert.equal(proposal.owners.length, 2);
  assert.deepEqual(proposal.contracts, ["src/contracts/"]);
  assert.equal(proposal.tasks[0]!.agent, "ana");
  assert.equal(parseProposal({ proposal: "not json" }), null);
  assert.equal(parseProposal({ proposal: "" }), null);
  // the orchestrator's shape: contracts as {path, description}, firstTasks, architecture
  const real = parseProposal({ proposal: JSON.stringify({ architecture: "A", owners: [], contracts: [{ path: "src/c/", description: "d" }], firstTasks: [{ agent: "a", title: "t", details: "", files: ["x"] }] }) })!;
  assert.deepEqual(real.contracts, ["src/c/"]);
  assert.equal(real.tasks[0]!.title, "t");
  assert.equal(real.notes, "A");
});

test("questions and members tolerate bad JSON", () => {
  assert.deepEqual(parseQuestions({ questions: "nope" }), []);
  assert.deepEqual(parseQuestions({ questions: '["a","b",3]' }), ["a", "b"]);
  assert.deepEqual(parseMembers({ members: "" }), []);
  assert.deepEqual(parseMembers({ members: '[{"handle":"ana","displayName":"Ana"},{"displayName":"x"}]' }), [{ handle: "ana", displayName: "Ana" }]);
});

test("the form needs a goal and a team, and answers need every question", () => {
  const team = [{ handle: "ana", displayName: "Ana" }];
  assert.match(kickoffProblem("", team), /goal/i);
  assert.match(kickoffProblem("Build it", []), /team member/i);
  assert.equal(kickoffProblem("Build it", team), "");
  assert.match(answersProblem(["q1", "q2"], ["yes", " "]), /question 2/);
  assert.equal(answersProblem(["q1"], ["yes"]), "");
  assert.deepEqual(JSON.parse(answersJson(["q1"], [" ok "])), [{ question: "q1", answer: "ok" }]);
  assert.deepEqual(JSON.parse(membersJson([{ handle: " ana ", displayName: " Ana ", strengths: " ui " }, { handle: " ", displayName: "x" }])), [{ handle: "ana", displayName: "Ana", strengths: "ui" }]);
});

const row = (over: Partial<UsageRow>): UsageRow => ({
  id: 1, agent: "a", requestId: 0, taskId: 0, conflictId: 0, phase: "implementing", model: "m-large-1",
  inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, createdAt: 0, ...over,
});

test("VITE_PRICES_JSON is validated: bad entries are dropped, never guessed", () => {
  assert.deepEqual(parsePrices(undefined), {});
  assert.deepEqual(parsePrices(""), {});
  assert.deepEqual(parsePrices("{oops"), {});
  assert.deepEqual(parsePrices("[1]"), {});
  const good = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 };
  const parsed = parsePrices(JSON.stringify({ ok: good, neg: { ...good, input: -1 }, missing: { input: 1 }, str: { ...good, output: "2" } }));
  assert.deepEqual(parsed, { ok: good });
});

test("a priced model gets an estimate, the longest matching prefix wins, reported cost wins over both", () => {
  const prices = parsePrices(JSON.stringify({
    "m-": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    "m-large": { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  }));
  assert.equal(rowCost(row({}), prices), 18);
  assert.equal(rowCost(row({ model: "m-small" }), prices), 2);
  assert.equal(rowCost(row({ costUsd: 0.25 }), prices), 0.25);
  assert.equal(rowCost(row({ model: "other" }), prices), 0);
});

test("unpriced tokens are flagged only when there are tokens and no price or reported cost", () => {
  const prices = parsePrices(JSON.stringify({ "m-large": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
  assert.equal(hasUnpriced([row({})], prices), false);
  assert.equal(hasUnpriced([row({ model: "other" })], prices), true);
  assert.equal(hasUnpriced([row({ model: "other", costUsd: 1 })], prices), false);
  assert.equal(hasUnpriced([row({ model: "other", inputTokens: 0, outputTokens: 0 })], prices), false);
  assert.equal(hasUnpriced([row({})], {}), true);
});
