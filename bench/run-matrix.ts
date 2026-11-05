/**
 * bench/run-matrix.ts
 *
 * WHAT IT'S FOR: the condition matrix, conditions x tasks x trials, written to one results JSON.
 *
 * CONDITIONS
 *   plain-git        agents work independently; a human merges. Nothing but git notices problems.
 *   shared-context   agents see each other's intent/snapshots, but nothing checks the combination
 *                    except the type checker.
 *   orchestrated     Orkio: shared state + check_with_team (tsc + tests on the combined tree).
 *
 * TWO KINDS OF ROWS
 *   source "measured"  OFFLINE and real: the seeded-bug scenarios (bench/seeded-bugs) run through a
 *                      real git merge, tsc and vitest. The three conditions are verification layers
 *                      (see seeded-bugs/run.ts), a proxy for what each setup would catch, NOT a
 *                      run of live agents. humanPrompts, tokens, costUsd and wallMs are null here.
 *   source "recorded"  LIVE-AGENT STUBS. This harness cannot drive Claude Code sessions. A human
 *                      (or a driver script) runs a task under a condition and drops
 *                      bench/recorded/<condition>/<task>/<trial>.json with the fields below. If
 *                      bench/recorded/tasks.json ({ "tasks": [...], "trials": N }) lists a task
 *                      whose file is absent, the row is source "missing" and is excluded from stats.
 *
 * USAGE: node bench/run-matrix.ts [--trials N] [--recorded bench/recorded] [--out bench/results/latest.json] [--skip-seeded]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAYERS, runScenario, type ScenarioResult } from "./seeded-bugs/run.ts";
import { scenarios } from "./seeded-bugs/scenarios.ts";

export const CONDITIONS = LAYERS;
export type Condition = (typeof CONDITIONS)[number];

export interface Row {
  condition: Condition;
  task: string;
  trial: number;
  source: "measured" | "recorded" | "missing";
  /** Wall-clock time to finish the task, ms. null when not measured (offline rows). */
  wallMs: number | null;
  /** Prompts a human had to type. */
  humanPrompts: number | null;
  tokens: number | null;
  costUsd: number | null;
  /** Hidden end-to-end tests pass on the final integrated result. */
  hiddenTestPass: boolean | null;
  /** Offline rows only: a bug exists in the integrated result / the condition noticed it. */
  bugPresent: boolean | null;
  detected: boolean | null;
  /** Time the harness spent on this scenario (offline rows), not a condition comparison. */
  harnessMs: number | null;
}

export interface Matrix {
  createdAt: string;
  trials: number;
  note: string;
  rows: Row[];
}

const NOTE =
  "measured rows are offline verification-layer proxies on seeded bugs (not live agents); recorded rows come from bench/recorded; missing rows are excluded from statistics.";

export function offlineRows(results: ScenarioResult[], trial: number): Row[] {
  return results.flatMap((r) =>
    CONDITIONS.map((condition): Row => ({
      condition, task: `seeded:${r.id}`, trial, source: "measured", wallMs: null, humanPrompts: null, tokens: null, costUsd: null,
      hiddenTestPass: r.mergeClean ? r.hiddenFails === 0 : false, bugPresent: r.bug, detected: r.detected[condition], harnessMs: r.wallMs,
    })),
  );
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Reads bench/recorded. Exported for tests. */
export function recordedRows(dir: string): Row[] {
  const rows: Row[] = [];
  const planFile = path.join(dir, "tasks.json");
  const plan = existsSync(planFile) ? (JSON.parse(readFileSync(planFile, "utf8")) as { tasks: string[]; trials: number }) : null;
  for (const task of plan?.tasks ?? []) {
    for (const condition of CONDITIONS) {
      for (let trial = 1; trial <= (plan?.trials ?? 1); trial++) {
        const file = path.join(dir, condition, task, `${trial}.json`);
        const base = { condition, task, trial, bugPresent: null, detected: null, harnessMs: null } as const;
        if (!existsSync(file)) {
          rows.push({ ...base, source: "missing", wallMs: null, humanPrompts: null, tokens: null, costUsd: null, hiddenTestPass: null });
          continue;
        }
        const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        rows.push({
          ...base, source: "recorded", wallMs: num(data.wallMs), humanPrompts: num(data.humanPrompts), tokens: num(data.tokens),
          costUsd: num(data.costUsd), hiddenTestPass: typeof data.hiddenTestPass === "boolean" ? data.hiddenTestPass : null,
        });
      }
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback);
  const trials = Math.max(1, Number(arg("--trials", "1")));
  const out = path.resolve(arg("--out", path.join(here, "results/latest.json")));
  const { useRepo } = await import("../checks/src/git.ts");
  useRepo(path.join(here, "../demo-app"));
  const rows: Row[] = [];
  if (!process.argv.includes("--skip-seeded")) {
    for (let trial = 1; trial <= trials; trial++) {
      const results: ScenarioResult[] = [];
      for (const s of scenarios) results.push(await runScenario(s));
      rows.push(...offlineRows(results, trial));
      console.error(`trial ${trial}/${trials} done`);
    }
  }
  rows.push(...recordedRows(path.resolve(arg("--recorded", path.join(here, "recorded")))));
  const matrix: Matrix = { createdAt: new Date().toISOString(), trials, note: NOTE, rows };
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(matrix, null, 2));
  console.log(`wrote ${rows.length} rows to ${out}`);
}
