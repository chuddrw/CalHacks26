/** Part C regression checks for publication boundaries, supersession, cleanup and command permissions. */
import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnosisRunner, type DiagnosisDependencies, type DiagnosisInput } from "./index.ts";
import { isReadOnlyCommand } from "./permissions.ts";
import { parseDiagnosis } from "./droid.ts";
import type { Diagnosis } from "./prompt.ts";

const diagnosis: Diagnosis = { summary: "Unit mismatch", cause: "Seconds meets milliseconds", suggestion: "Convert B's calculation", fact: "lastLogin is milliseconds" };
function input(error = "unit mismatch"): DiagnosisInput {
  return {
    conflict: { id: 1, pair: "a+b", kind: "pair", agentA: "a", agentB: "b", locA: "a.ts:1", locB: "b.ts:1", error, explanation: "", fixer: "b", status: "open", runKey: "one", createdAt: 1, resolvedAt: 0 },
    sides: [], failingOutput: error,
  };
}
function harness(overrides: Partial<DiagnosisDependencies> = {}) {
  const steps: Array<{ at: number; args: unknown[] }> = [];
  const explanations: string[] = [];
  let leases = 0;
  let cleaned = 0;
  const runner = createDiagnosisRunner({
    mode: "droid",
    acquireWorktree: async () => { leases++; return { path: "/tmp/owned-diagnosis", cleanup: async () => { cleaned++; } }; },
    addDiagnosisStep: async (...args) => { steps.push({ at: Date.now(), args }); },
    setExplanationIfCurrent: async (_id, _runKey, _error, _fixer, explanation) => { explanations.push(explanation); },
    isCurrent: () => true,
    droid: async () => diagnosis,
    claude: async () => null,
    ...overrides,
  });
  return { runner, steps, explanations, counts: () => ({ leases, cleaned }) };
}

test("duplicate errors share one run, return proposed fact and clean only their lease", async () => {
  const h = harness();
  const first = h.runner.diagnose(input());
  assert.equal(first, h.runner.diagnose(input()));
  assert.deepEqual(await first, diagnosis);
  assert.deepEqual(h.counts(), { leases: 1, cleaned: 1 });
  assert.equal(h.explanations.length, 1);
  assert.match(h.explanations[0]!, /Seconds meets milliseconds/);
  assert.equal(h.steps.some(step => step.args[2] === "fact"), false);
});

test("Droid failure falls back and both failures produce unavailable status with cleanup", async () => {
  let fallback = 0;
  const h = harness({ droid: async () => { throw new Error("SDK down"); }, claude: async () => { fallback++; return null; } });
  assert.equal(await h.runner.diagnose(input()), null);
  assert.equal(fallback, 1);
  assert.equal(h.steps.at(-1)?.args[3], "diagnosis unavailable");
  assert.equal(h.explanations.length, 0);
  assert.deepEqual(h.counts(), { leases: 1, cleaned: 1 });
});

test("changed error supersedes old publication and waits for its cleanup", async () => {
  let release!: (value: Diagnosis) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const h = harness({ droid: async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    if (calls === 1) { started(); const result = await new Promise<Diagnosis>(resolve => { release = resolve; }); active--; return result; }
    active--; return { ...diagnosis, summary: "New error" };
  } });
  const old = h.runner.diagnose(input());
  await ready;
  const next = h.runner.diagnose(input("changed error"));
  release(diagnosis);
  assert.equal(await old, null);
  assert.equal((await next)?.summary, "New error");
  assert.equal(maximum, 1);
  assert.deepEqual(h.counts(), { leases: 2, cleaned: 2 });
  assert.equal(h.explanations.length, 1);
  assert.match(h.explanations[0]!, /New error/);
});

test("invalidation suppresses an in-flight diagnosis, including queued steps", async () => {
  let release!: (value: Diagnosis) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const h = harness({ droid: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const pending = h.runner.diagnose(input());
  await ready;
  h.runner.invalidate(1);
  release(diagnosis);
  assert.equal(await pending, null);
  assert.equal(h.explanations.length, 0);
  assert.equal(h.counts().cleaned, 1);
});

test("DB failure propagates and still releases diagnosis worktree", async () => {
  const h = harness({ addDiagnosisStep: async () => { throw new Error("DB unavailable"); } });
  await assert.rejects(h.runner.diagnose(input()), /DB unavailable/);
  assert.equal(h.counts().cleaned, 1);
  assert.equal(h.explanations.length, 0);
});

test("steps are serialized at no more than five per second", async () => {
  const h = harness({ droid: async (_ctx, onStep) => { onStep("tool_call", "Read"); onStep("tool_result", "source"); return diagnosis; } });
  await h.runner.diagnose(input());
  for (let i = 1; i < h.steps.length; i++) assert.ok(h.steps[i]!.at - h.steps[i - 1]!.at >= 190);
});

test("permissions permit narrowly scoped read/check commands and reject writes or shell injection", () => {
  for (const command of ["cat src/user.ts", "ls -la", "rg -n lastLogin src", "git diff --no-ext-diff --no-textconv --stat", "./node_modules/.bin/tsc --noEmit --incremental false", "./node_modules/.bin/vitest run src/user.test.ts"]) assert.equal(isReadOnlyCommand(command), true, command);
  for (const command of ["git push", "git diff --output=src/user.ts", "git show --ext-diff", "cat x; rm x", "ls && git push", "cat $(touch x)", "cat `touch x`", "cat x > y", "ls\nrm x", "node -e code", "npm install", "npx evil", "./node_modules/.bin/vitest run --update", "./node_modules/.bin/tsc --outDir src", "cat ../secret", "ls -la /tmp"]) assert.equal(isReadOnlyCommand(command), false, command);
});

test("Droid parses structured output, tolerates plain text, and rejects empty answers", () => {
  assert.deepEqual(parseDiagnosis(JSON.stringify(diagnosis)), diagnosis);
  assert.deepEqual(parseDiagnosis("```json\n" + JSON.stringify(diagnosis) + "\n```"), diagnosis);
  assert.equal(parseDiagnosis("plain explanation")?.summary, "plain explanation");
  assert.equal(parseDiagnosis("  "), null);
});

test("identical error on a different run/fixer never reuses a cached fact", async () => {
  const h = harness();
  assert.deepEqual(await h.runner.diagnose(input()), diagnosis);
  const later = input(); later.conflict.runKey = "new run"; later.conflict.fixer = "a";
  assert.equal(await h.runner.diagnose(later), null);
  assert.equal(h.counts().leases, 1);
});

test("UTF-8 step limit preserves whole Unicode characters", async () => {
  const h = harness({ droid: async (_ctx, onStep) => { onStep("thought", "🙂".repeat(1024)); return diagnosis; } });
  await h.runner.diagnose(input());
  const detail = h.steps.find(step => step.args[2] === "thought")?.args[3] as string;
  assert.equal(Buffer.byteLength(detail), 2048);
  assert.equal(detail.includes("�"), false);
});

test("Droid deadline aborts work and closes the owned SDK session", async () => {
  const { createDroidDiagnoser } = await import("./droid.ts");
  let closed = 0;
  let disabled: string[] = [];
  const create: typeof import("@factory/droid-sdk/node").createSession = (async (options: import("@factory/droid-sdk/node").CreateSessionOptions) => ({
    listTools: async () => [{ id: "Read" }, { id: "Execute" }, { id: "NewWriteTool" }],
    updateSettings: async (settings: { disabledToolIds: string[] }) => { disabled = settings.disabledToolIds; },
    stream: async function* () {
      await new Promise<void>((_resolve, reject) => {
        if (options.abortSignal?.aborted) reject(options.abortSignal.reason);
        else options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true });
      });
      yield { type: "assistant", text: "unreachable" };
    },
    close: async () => { closed++; },
  })) as unknown as typeof import("@factory/droid-sdk/node").createSession;
  const run = createDroidDiagnoser({ create, apiKey: "test-only", timeoutMs: 15 });
  const steps: string[] = [];
  assert.equal(await run({ ...input(), worktree: "/tmp/owned" }, (_kind, detail) => { steps.push(detail); }), null);
  assert.equal(closed, 1);
  assert.deepEqual(disabled, ["NewWriteTool"]);
  assert.ok(steps.includes("Droid diagnosis timed out"));
});
