/**
 * bench/planner-golden/score.ts
 *
 * WHAT IT'S FOR: scores plans against the labels in cases.json. Pure functions, no model, no git.
 * A "plan" is the shape the orchestrator publishes (PlanInput): tasks, reviews, conflicts.
 * Metrics are micro-averaged: true/false positives are summed over all cases, then divided.
 *   owners     predicted = agents with a task; expected = label "owners"
 *   reviewers  predicted = plan.reviews[].reviewer; expected = label "reviewers"
 *   conflicts  unordered agent pairs
 *   major      per case: any(task.major) must equal label "major" (accuracy)
 * A case missing from the plans file counts as an empty plan (all misses) and is listed in `missing`.
 */
export interface GoldenCase {
  id: string;
  request: string;
  requester: string;
  /** What a naive planner would draft: tasks assigned by file ownership, never marked major by itself. */
  draft: Array<{ agent: string; files: string[]; major: boolean }>;
  expect: { major: boolean; reviewers: string[]; owners: string[]; conflicts: string[][] };
  note?: string;
}

export interface PlanLike {
  tasks: Array<{ agent: string; files?: string[]; major: boolean }>;
  reviews?: Array<{ reviewer: string }>;
  conflicts?: Array<{ agentA: string; agentB: string }>;
}

export type Metric = "owners" | "reviewers" | "conflicts" | "major";
export const ALL_METRICS: Metric[] = ["owners", "reviewers", "conflicts", "major"];

export interface PR {
  precision: number | null;
  recall: number | null;
  tp: number;
  fp: number;
  fn: number;
}

export interface Score {
  cases: number;
  missing: string[];
  owners?: PR;
  reviewers?: PR;
  conflicts?: PR;
  major?: { accuracy: number; correct: number; total: number; wrong: string[] };
}

const pairKey = (a: string, b: string) => [a, b].sort().join("|");

function pr(tp: number, fp: number, fn: number): PR {
  return { tp, fp, fn, precision: tp + fp === 0 ? null : tp / (tp + fp), recall: tp + fn === 0 ? null : tp / (tp + fn) };
}

function compare(predicted: Set<string>, expected: Set<string>): [number, number, number] {
  let tp = 0;
  for (const item of predicted) if (expected.has(item)) tp++;
  return [tp, predicted.size - tp, expected.size - tp];
}

export function scorePlans(cases: GoldenCase[], plans: Record<string, PlanLike>, metrics: Metric[] = ALL_METRICS): Score {
  const total: Record<"owners" | "reviewers" | "conflicts", [number, number, number]> = {
    owners: [0, 0, 0], reviewers: [0, 0, 0], conflicts: [0, 0, 0],
  };
  const missing: string[] = [];
  const wrong: string[] = [];
  let majorCorrect = 0;
  for (const c of cases) {
    const plan = plans[c.id];
    if (!plan) missing.push(c.id);
    const p: PlanLike = plan ?? { tasks: [], reviews: [], conflicts: [] };
    const sets = {
      owners: [new Set(p.tasks.map((t) => t.agent)), new Set(c.expect.owners)],
      reviewers: [new Set((p.reviews ?? []).map((r) => r.reviewer)), new Set(c.expect.reviewers)],
      conflicts: [
        new Set((p.conflicts ?? []).map((x) => pairKey(x.agentA, x.agentB))),
        new Set(c.expect.conflicts.map(([a, b]) => pairKey(a!, b!))),
      ],
    } as const;
    for (const key of ["owners", "reviewers", "conflicts"] as const) {
      const [tp, fp, fn] = compare(sets[key][0], sets[key][1]);
      total[key][0] += tp; total[key][1] += fp; total[key][2] += fn;
    }
    if (p.tasks.some((t) => t.major) === c.expect.major) majorCorrect++;
    else wrong.push(c.id);
  }
  const score: Score = { cases: cases.length, missing };
  for (const key of ["owners", "reviewers", "conflicts"] as const) if (metrics.includes(key)) score[key] = pr(...total[key]);
  if (metrics.includes("major")) {
    score.major = { accuracy: cases.length ? majorCorrect / cases.length : 0, correct: majorCorrect, total: cases.length, wrong };
  }
  return score;
}

const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);

export function formatScore(label: string, s: Score): string {
  const lines = [`${label} (${s.cases} cases${s.missing.length ? `, ${s.missing.length} missing plans` : ""})`];
  for (const key of ["owners", "reviewers", "conflicts"] as const) {
    const v = s[key];
    if (v) lines.push(`  ${key.padEnd(10)} precision ${pct(v.precision)}  recall ${pct(v.recall)}  (tp ${v.tp}, fp ${v.fp}, fn ${v.fn})`);
  }
  if (s.major) lines.push(`  major      accuracy ${pct(s.major.accuracy)} (${s.major.correct}/${s.major.total})${s.major.wrong.length ? `  wrong: ${s.major.wrong.join(", ")}` : ""}`);
  return lines.join("\n");
}
