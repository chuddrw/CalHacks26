import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { useRepo } from "../../checks/src/git.ts";
import { applyEdits, runScenario, summarize, type ScenarioResult } from "./run.ts";
import { scenarios } from "./scenarios.ts";

const demo = path.resolve(import.meta.dirname, "../../demo-app");

test("at least twelve scenarios with unique ids", () => {
  assert.ok(scenarios.length >= 12);
  assert.equal(new Set(scenarios.map((s) => s.id)).size, scenarios.length);
});

test("applyEdits replaces exactly one match and refuses ambiguous or missing text", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bench-edit-"));
  try {
    mkdirSyncFile(dir, "x.ts", "a b a");
    assert.throws(() => applyEdits(dir, [{ file: "x.ts", from: "a", to: "z" }]), /found 2/);
    assert.throws(() => applyEdits(dir, [{ file: "x.ts", from: "q", to: "z" }]), /found 0/);
    applyEdits(dir, [{ file: "x.ts", from: "b", to: "$&" }, { file: "y/n.ts", create: "new" }]);
    assert.equal(readFileSync(path.join(dir, "x.ts"), "utf8"), "a $& a");
    assert.equal(readFileSync(path.join(dir, "y/n.ts"), "utf8"), "new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
function mkdirSyncFile(dir: string, name: string, text: string) {
  writeFileSync(path.join(dir, name), text);
}

test("summarize counts detections over buggy scenarios and false positives over clean ones", () => {
  const mk = (bug: boolean, d: [boolean, boolean, boolean]): ScenarioResult => ({
    id: "x", kind: "", validAlone: true, mergeClean: true, tscErrors: 0, testFails: 0, hiddenFails: 0, bug, wallMs: 1,
    detected: { "plain-git": d[0], "shared-context": d[1], orchestrated: d[2] },
  });
  const s = summarize([mk(true, [false, true, true]), mk(true, [false, false, true]), mk(false, [false, false, true])]);
  assert.deepEqual(s.map((x) => [x.layer, x.detected, x.bugs, x.falsePositives, x.clean]), [
    ["plain-git", 0, 2, 0, 1], ["shared-context", 1, 2, 0, 1], ["orchestrated", 2, 2, 1, 1],
  ]);
});

test("every scenario behaves as designed on a real merge + tsc + vitest (slow, ~20 s)", { timeout: 180_000 }, async () => {
  useRepo(demo);
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    const r = await runScenario(s);
    assert.equal(r.problem, undefined, `${s.id}: ${r.problem}`);
    assert.equal(r.validAlone, true, `${s.id} must be green alone`);
    assert.equal(r.mergeClean, s.expect.mergeClean, `${s.id} mergeClean`);
    assert.equal(r.bug, s.expect.bug, `${s.id} bug`);
    assert.equal(r.detected.orchestrated && r.bug, s.expect.visibleChecksCatch, `${s.id} orchestrated detection`);
    results.push(r);
  }
  const by = Object.fromEntries(summarize(results).map((x) => [x.layer, x]));
  assert.ok(by.orchestrated!.detected >= by["shared-context"]!.detected);
  assert.ok(by["shared-context"]!.detected >= by["plain-git"]!.detected);
  assert.equal(by.orchestrated!.falsePositives, 0);
});
