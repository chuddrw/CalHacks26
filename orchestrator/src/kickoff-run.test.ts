/**
 * WHAT IT'S FOR: runKickoff against a fake database (no server, no model, no git): the reducer calls it
 * makes for a proposal, for one round of questions, and for a failure; and the scripted kickoff file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { KickoffRow } from "../../shared/src/schema.ts";
import { parseOwners } from "../../shared/src/owners.ts";
import { membersOf, runKickoff, scriptedKickoff } from "./kickoff-run.ts";

const row = (changes: Partial<KickoffRow> = {}): KickoffRow => ({
  id: 7, requester: "ana", goal: "A snack rating app", constraints: "React", status: "new", questions: "", answers: "", proposal: "", ownersJson: "", note: "",
  members: JSON.stringify([{ handle: "ana", displayName: "Ana", strengths: "frontend" }, { handle: "ben", displayName: "Ben" }]),
  createdAt: 1, updatedAt: 1, ...changes,
});
const proposal = {
  architecture: "React client, Node API.", summary: "Ana frontend, Ben API",
  owners: [{ agent: "ana", human: "Ana", feature: "Frontend", paths: ["src/ui/"] }, { agent: "ben", human: "Ben", feature: "API", paths: ["src/api/"] }],
  contracts: [{ path: "src/contracts/snack.ts", description: "Snack type" }],
  firstTasks: [{ agent: "ana", title: "Snack list", details: "", files: ["src/ui/list.tsx"] }],
};
function harness() {
  const calls: Array<[string, unknown[]]> = [];
  let cleaned = false;
  return {
    calls, cleaned: () => cleaned,
    deps: {
      call: async (reducer: string, args: unknown[]) => { calls.push([reducer, args]); },
      workspace: async () => ({ dir: "/tmp/none", cleanup: async () => { cleaned = true; } }),
    },
  };
}

test("members come from the row: handle becomes the agent, display name the human", () => {
  assert.deepEqual(membersOf(row()), [{ agent: "ana", human: "Ana", strengths: "frontend" }, { agent: "ben", human: "Ben" }]);
});

test("a proposal is published with the owners file text, after start_kickoff, and the workspace is removed", async () => {
  const h = harness();
  let seen: unknown;
  await runKickoff(row(), { ...h.deps, kickoff: async (input) => { seen = input; return { kind: "proposal", proposal }; } });
  assert.deepEqual(h.calls.map(([name]) => name), ["start_kickoff", "publish_proposal"]);
  assert.equal(h.calls[0]![1][0], 7);
  const [id, proposalJson, ownersJson] = h.calls[1]![1] as [number, string, string];
  assert.equal(id, 7);
  assert.equal(JSON.parse(proposalJson).summary, "Ana frontend, Ben API");
  const owners = parseOwners(ownersJson);
  assert.deepEqual(owners.owners.map((o) => o.agent), ["ana", "ben"]);
  assert.deepEqual(owners.shared, ["src/contracts/snack.ts"]);
  assert.equal((seen as { goal: string; answers?: string }).answers, undefined);
  assert.ok(h.cleaned());
});

test("questions are stored once, and answers are passed back to the planner", async () => {
  const h = harness();
  await runKickoff(row(), { ...h.deps, kickoff: async () => ({ kind: "questions", questions: ["Which stack?"] }) });
  assert.deepEqual(h.calls.map(([name]) => name), ["start_kickoff", "ask_kickoff_questions"]);
  assert.deepEqual(h.calls[1]![1], [7, ["Which stack?"]]);
  const again = harness();
  let answers: string | undefined;
  await runKickoff(row({ status: "new", answers: "React; Ana demos" }), { ...again.deps, kickoff: async (input) => { answers = input.answers; return { kind: "proposal", proposal }; } });
  assert.equal(answers, "React; Ana demos");
});

test("a failing planner, or a proposal that names someone off the team, fails the kickoff with the reason", async () => {
  const h = harness();
  await runKickoff(row(), { ...h.deps, kickoff: async () => { throw new Error("FACTORY_API_KEY is not set"); } });
  assert.deepEqual(h.calls.at(-1), ["fail_kickoff", [7, "FACTORY_API_KEY is not set"]]);
  assert.ok(h.cleaned());
  const bad = harness();
  const outsider = { ...proposal, owners: [{ agent: "zed", human: "Zed", feature: "X", paths: ["x/"] }], firstTasks: [] };
  await runKickoff(row(), { ...bad.deps, kickoff: async () => ({ kind: "proposal", proposal: outsider }) });
  const last = bad.calls.at(-1)!;
  assert.equal(last[0], "fail_kickoff");
  assert.match(String(last[1][1]), /zed isn't on the team/);
});

test("the scripted kickoff asks its questions once, then proposes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cowork-kickoff-"));
  try {
    const file = path.join(dir, "kickoff.json");
    writeFileSync(file, JSON.stringify({ questions: ["Which stack?"], proposal }));
    const run = scriptedKickoff(file);
    const input = { goal: "g", members: membersOf(row()), worktree: "." };
    assert.deepEqual(await run(input, () => undefined), { kind: "questions", questions: ["Which stack?"] });
    const result = await run({ ...input, answers: "React" }, () => undefined);
    assert.equal(result.kind, "proposal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
