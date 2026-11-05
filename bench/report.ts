/**
 * bench/report.ts
 *
 * WHAT IT'S FOR: reads a results JSON from run-matrix.ts and prints, per condition and source,
 * medians with spread (min-max and interquartile range) as a markdown table. Missing rows are
 * counted but never averaged. Fields that are null for every row show as "n/a".
 *
 * USAGE: node bench/report.ts [bench/results/latest.json]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONDITIONS, type Matrix, type Row } from "./run-matrix.ts";

export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
export const median = (values: number[]) => quantile(values, 0.5);

export interface Spread { n: number; median: number | null; min: number | null; max: number | null; iqr: number | null }
export function spread(values: Array<number | null>): Spread {
  const v = values.filter((x): x is number => x !== null);
  const q1 = quantile(v, 0.25);
  const q3 = quantile(v, 0.75);
  return { n: v.length, median: median(v), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null, iqr: q1 === null || q3 === null ? null : q3 - q1 };
}

const fmt = (s: Spread, digits = 0) =>
  s.n === 0 ? "n/a" : `${s.median!.toFixed(digits)} [${s.min!.toFixed(digits)}-${s.max!.toFixed(digits)}]`;
const rate = (hit: number, total: number) => (total === 0 ? "n/a" : `${hit}/${total} (${((100 * hit) / total).toFixed(0)}%)`);

export function report(matrix: Matrix): string {
  const out: string[] = [`Results from ${matrix.createdAt}, ${matrix.trials} trial(s).`, `> ${matrix.note}`, ""];
  for (const source of ["measured", "recorded"] as const) {
    const rows = matrix.rows.filter((r) => r.source === source);
    const missing = matrix.rows.filter((r) => r.source === "missing");
    if (rows.length === 0 && (source === "measured" || missing.length === 0)) continue;
    out.push(source === "measured"
      ? "### Offline seeded bugs (verification layers, not live agents)"
      : `### Recorded live runs (${missing.length} planned runs missing, excluded)`);
    out.push("", "| condition | rows | bugs caught | false alarms | wall ms [min-max] | prompts | tokens | cost USD | hidden tests pass |", "|---|---|---|---|---|---|---|---|---|");
    for (const condition of CONDITIONS) {
      const set = rows.filter((r) => r.condition === condition);
      if (set.length === 0) continue;
      const bugs = set.filter((r) => r.bugPresent === true);
      const clean = set.filter((r) => r.bugPresent === false);
      const hid = set.filter((r) => r.hiddenTestPass !== null);
      out.push(`| ${condition} | ${set.length} | ${bugs.length ? rate(bugs.filter((r) => r.detected).length, bugs.length) : "n/a"} | ${clean.length ? rate(clean.filter((r) => r.detected).length, clean.length) : "n/a"} | ${fmt(spread(set.map((r) => r.wallMs)))} | ${fmt(spread(set.map((r) => r.humanPrompts)))} | ${fmt(spread(set.map((r) => r.tokens)))} | ${fmt(spread(set.map((r) => r.costUsd)), 2)} | ${hid.length ? rate(hid.filter((r) => r.hiddenTestPass).length, hid.length) : "n/a"} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "results/latest.json");
  console.log(report(JSON.parse(readFileSync(file, "utf8")) as Matrix));
}
export type { Row };
