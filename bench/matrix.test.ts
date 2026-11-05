import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { offlineRows, recordedRows, type Matrix } from "./run-matrix.ts";
import { median, quantile, report, spread } from "./report.ts";
import type { ScenarioResult } from "./seeded-bugs/run.ts";

test("quantiles, median and spread ignore nulls", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(quantile([], 0.5), null);
  const s = spread([10, null, 20, 30, 40]);
  assert.deepEqual([s.n, s.median, s.min, s.max, s.iqr], [4, 25, 10, 40, 15]);
});

test("offline rows: three conditions per scenario, no live-only fields invented", () => {
  const r: ScenarioResult = { id: "x", kind: "", validAlone: true, mergeClean: true, tscErrors: 0, testFails: 1, hiddenFails: 1, bug: true, wallMs: 5,
    detected: { "plain-git": false, "shared-context": false, orchestrated: true } };
  const rows = offlineRows([r], 2);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((x) => x.detected), [false, false, true]);
  for (const row of rows) assert.deepEqual([row.wallMs, row.tokens, row.costUsd, row.humanPrompts, row.source, row.trial], [null, null, null, null, "measured", 2]);
});

test("recorded rows read files, mark absent ones missing, and ignore junk values", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bench-rec-"));
  try {
    writeFileSync(path.join(dir, "tasks.json"), JSON.stringify({ tasks: ["flappy"], trials: 2 }));
    mkdirSync(path.join(dir, "orchestrated/flappy"), { recursive: true });
    writeFileSync(path.join(dir, "orchestrated/flappy/1.json"), JSON.stringify({ wallMs: 1000, humanPrompts: 4, tokens: "lots", costUsd: 0.5, hiddenTestPass: true }));
    const rows = recordedRows(dir);
    assert.equal(rows.length, 6);
    const rec = rows.filter((r) => r.source === "recorded");
    assert.equal(rec.length, 1);
    assert.deepEqual([rec[0]!.wallMs, rec[0]!.tokens, rec[0]!.humanPrompts, rec[0]!.hiddenTestPass], [1000, null, 4, true]);
    assert.equal(rows.filter((r) => r.source === "missing").length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordedRows with no tasks.json is empty", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bench-rec-"));
  try { assert.deepEqual(recordedRows(dir), []); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("report prints a markdown table, excludes missing rows from stats and says so", () => {
  const base = { task: "t", source: "recorded", humanPrompts: null, tokens: null, costUsd: null, bugPresent: null, detected: null, harnessMs: null } as const;
  const matrix: Matrix = { createdAt: "now", trials: 3, note: "n", rows: [
    { ...base, condition: "orchestrated", trial: 1, wallMs: 100, hiddenTestPass: true },
    { ...base, condition: "orchestrated", trial: 2, wallMs: 300, hiddenTestPass: false },
    { ...base, condition: "orchestrated", trial: 3, source: "missing", wallMs: null, hiddenTestPass: null },
  ] };
  const text = report(matrix);
  assert.match(text, /1 planned runs missing, excluded/);
  assert.match(text, /\| orchestrated \| 2 \|/);
  assert.match(text, /200 \[100-300\]/);
  assert.match(text, /1\/2 \(50%\)/);
});
