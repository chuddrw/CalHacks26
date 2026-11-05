/**
 * WHAT IT'S FOR: the OpenRouter planner with a fake `fetch` (npm run test:orchestrator): the model's tool calls become the
 * same validated plan as Droid's, bad arguments and unknown agents are refused, the file tools cannot leave the
 * worktree, and errors surface. No key, no network.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseOwners } from "../../shared/src/owners.ts";
import type { RequestRow } from "../../shared/src/schema.ts";
import { createOpenRouterKickoff, createOpenRouterPlanner, createTieredPlanner, fileTools, needsStrongModel, type FileTool } from "./openrouter.ts";
import type { PlannerInput } from "./planner.ts";

const owners = parseOwners(JSON.stringify({
  shared: ["src/contracts/"],
  owners: [{ agent: "a", paths: ["src/users/"] }, { agent: "b", paths: ["src/sessions/"] }],
}));
const request: RequestRow = { id: 7, agent: "a", body: "The frontend needs lastLogin in milliseconds", status: "planning", summary: "", plan: "", createdAt: 1, updatedAt: 1 };

function worktree(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "or-test-"));
  mkdirSync(path.join(dir, "src/users"), { recursive: true });
  writeFileSync(path.join(dir, "src/users/user.ts"), "export const lastLogin = 1;\n");
  writeFileSync(path.join(os.tmpdir(), "or-outside.txt"), "secret");
  return dir;
}
const inputFor = (dir: string): PlannerInput => ({ request, requesterHuman: "A", owners, worktree: dir, teamStatus: async () => "## Who owns what\n- a\n- b" });

const call = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
function fakeFetch(turns: Array<{ content?: string; tool_calls?: ReturnType<typeof call>[] } | { status: number; error: string }>, seen: unknown[] = []) {
  let i = 0;
  return (async (_url: string, init: { body: string }) => {
    seen.push(JSON.parse(init.body));
    const turn = turns[i++] ?? { content: "" };
    if ("status" in turn) return { ok: false, status: turn.status, json: async () => ({ error: { message: turn.error } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: turn }] }) };
  }) as unknown as typeof fetch;
}

test("tool calls become a validated plan, and bad calls are answered, not recorded", async () => {
  const seen: unknown[] = [];
  const steps: string[] = [];
  const planner = createOpenRouterPlanner({
    apiKey: "k", model: "test/model",
    fetch: fakeFetch([
      { content: "Looking at the team", tool_calls: [call("1", "team_status", {}), call("2", "assign_task", { agent: "ghost", title: "x", details: "y", files: [], major: false })] },
      { tool_calls: [
        call("3", "assign_task", { agent: "a", title: "Store lastLogin in ms", details: "change user.ts", files: ["src/users/user.ts"], major: true }),
        call("4", "request_review", { reviewer: "b", summary: "sessions import the contract" }),
        call("5", "request_review", { reviewer: "a", summary: "the requester never reviews" }),
        call("6", "assign_task", { agent: "a" }),
        call("7", "finish_plan", { summary: "One task for a, reviewed by b." }),
      ] },
    ], seen),
  });
  const plan = await planner(inputFor(worktree()), (kind, detail) => steps.push(`${kind}:${detail}`));
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0]!.agent, "a");
  assert.deepEqual(plan.reviews.map((r) => r.reviewer), ["b"]);
  assert.equal(plan.summary, "One task for a, reviewed by b.");
  const second = seen[1] as { messages: Array<{ role: string; content?: string }> };
  const toolAnswers = second.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
  assert.ok(toolAnswers.some((text) => /ghost isn't in cowork.owners.json/.test(text)), "unknown agent is answered");
  assert.ok((seen[0] as { tools: unknown[] }).tools.length >= 8, "plan tools and file tools are offered");
  assert.equal((seen[0] as { model: string }).model, "test/model");
  assert.ok(steps.some((s) => s.startsWith("tool_call:assign_task")));
});

test("no key, an API error, and a model that gives up all fail with a reason", async () => {
  await assert.rejects(createOpenRouterPlanner({ apiKey: "" })(inputFor(worktree()), () => {}), /OPENROUTER_API_KEY/);
  await assert.rejects(createOpenRouterPlanner({ apiKey: "k", fetch: fakeFetch([{ status: 401, error: "bad key" }]) })(inputFor(worktree()), () => {}), /401: bad key/);
  await assert.rejects(createOpenRouterPlanner({ apiKey: "k", fetch: fakeFetch([{ content: "I can't." }]) })(inputFor(worktree()), () => {}), /ended without a plan/);
});

test("the file tools read inside the worktree and refuse anything outside it", () => {
  const dir = worktree();
  const [read, list, grep] = fileTools(dir) as [FileTool, FileTool, FileTool];
  assert.match(read.run({ path: "src/users/user.ts" }), /lastLogin/);
  assert.match(read.run({ path: "../or-outside.txt" }), /Refused/);
  assert.match(read.run({ path: "/etc/passwd" }), /Refused/);
  assert.match(list.run({ path: "src" }), /users\//);
  assert.match(list.run({ path: ".." }), /Refused/);
  assert.match(grep.run({ pattern: "lastLogin" }), /src\/users\/user.ts:1/);
  assert.match(grep.run({ pattern: "(" }), /not a valid regular expression/);
  symlinkSync(path.join(os.tmpdir(), "or-outside.txt"), path.join(dir, "escape.txt"));
  assert.match(read.run({ path: "escape.txt" }), /Refused/, "a symlink out of the worktree is refused");
});

test("kickoff on OpenRouter proposes owners and tasks, validated, and asks questions only once", async () => {
  const kickoffInput = { goal: "A web app where friends rate snacks", members: [{ agent: "a", human: "Ana" }, { agent: "b", human: "Ben" }], worktree: worktree() };
  const proposal = await createOpenRouterKickoff({
    apiKey: "k",
    fetch: fakeFetch([{ tool_calls: [
      call("1", "propose_owner", { agent: "a", feature: "Frontend", paths: ["web/"] }),
      call("2", "propose_owner", { agent: "b", feature: "API", paths: ["api/"] }),
      call("3", "propose_owner", { agent: "ghost", feature: "x", paths: ["x/"] }),
      call("4", "propose_contract", { path: "shared/types.ts", description: "Snack and Rating types" }),
      call("5", "propose_first_task", { agent: "a", title: "Rating form", details: "build it", files: ["web/rate.tsx"] }),
      call("6", "finish_kickoff", { architecture: "A web client and an API.", summary: "Two owners." }),
    ] }]),
  })(kickoffInput, () => {});
  assert.equal(proposal.kind, "proposal");
  if (proposal.kind === "proposal") {
    assert.deepEqual(proposal.proposal.owners.map((o) => o.agent), ["a", "b"]);
    assert.equal(proposal.proposal.summary, "Two owners.");
  }
  const asked = await createOpenRouterKickoff({
    apiKey: "k",
    fetch: fakeFetch([{ tool_calls: [call("1", "ask_clarification", { questions: ["Which stack?"] })] }]),
  })(kickoffInput, () => {});
  assert.deepEqual(asked, { kind: "questions", questions: ["Which stack?"] });
});

test("the cheap model keeps an easy plan and the strong model takes over for hard ones", async () => {
  const easy = [call("1", "assign_task", { agent: "a", title: "Add isNewUser", details: "d", files: ["src/users/user.ts"], major: false }), call("2", "finish_plan", { summary: "One small task." })];
  const hard = [call("1", "assign_task", { agent: "a", title: "Change the contract", details: "d", files: ["src/contracts/user.ts"], major: true }), call("2", "finish_plan", { summary: "Major." })];
  const models: string[] = [];
  const route = (turnsByModel: Record<string, unknown[]>) => (async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { model: string };
    models.push(body.model);
    const next = turnsByModel[body.model]!.shift() as { tool_calls?: unknown[]; status?: number; error?: string };
    if (next.status) return { ok: false, status: next.status, json: async () => ({ error: { message: next.error } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: next }] }) };
  }) as unknown as typeof fetch;
  const planFor = (turns: Record<string, unknown[]>) => createTieredPlanner({ apiKey: "k", model: "strong/m", fastModel: "fast/m", fetch: route(turns) });
  const status: string[] = [];
  const onStep = (kind: string, detail: string) => { if (kind === "status") status.push(detail); };

  // easy request: only the cheap model is called
  let plan = await planFor({ "fast/m": [{ tool_calls: easy }], "strong/m": [] })(inputFor(worktree()), onStep as never);
  assert.deepEqual(models, ["fast/m"]);
  assert.equal(plan.tasks[0]!.major, false);
  assert.ok(status.some((s) => /kept the plan from fast\/m/.test(s)));

  // a major change: the cheap plan is discarded and the strong model plans
  models.length = 0;
  plan = await planFor({ "fast/m": [{ tool_calls: hard }], "strong/m": [{ tool_calls: hard }] })(inputFor(worktree()), onStep as never);
  assert.deepEqual(models, ["fast/m", "strong/m"]);
  assert.ok(status.some((s) => /saw a major change; planning again with strong\/m/.test(s)));

  // the cheap model failing hands over to the strong one
  models.length = 0;
  plan = await planFor({ "fast/m": [{ status: 500, error: "boom" }], "strong/m": [{ tool_calls: easy }] })(inputFor(worktree()), onStep as never);
  assert.deepEqual(models, ["fast/m", "strong/m"]);
  assert.equal(plan.tasks.length, 1);

  // no fast model configured: just the strong one
  models.length = 0;
  await createTieredPlanner({ apiKey: "k", model: "strong/m", fastModel: "", fetch: route({ "strong/m": [{ tool_calls: easy }] }) })(inputFor(worktree()), () => {});
  assert.deepEqual(models, ["strong/m"]);
});

test("needsStrongModel flags major changes, conflicts and multi-agent work only", () => {
  const base = { summary: "", tasks: [{ agent: "a", title: "t", details: "", files: [], major: false }], reviews: [], conflicts: [] };
  assert.equal(needsStrongModel(base), null);
  assert.match(needsStrongModel({ ...base, tasks: [{ ...base.tasks[0]!, major: true }] })!, /major/);
  assert.match(needsStrongModel({ ...base, conflicts: [{ agentA: "a", agentB: "b", topic: "t", details: "d", suggested: "a" }] })!, /conflict/);
  assert.match(needsStrongModel({ ...base, tasks: [base.tasks[0]!, { ...base.tasks[0]!, agent: "b" }] })!, /several agents/);
});
