/**
 * WHAT IT'S FOR: pure numbers for the Metrics drawer: tokens and cost (per agent, request, phase),
 * conflict stats, check pass rate, build green rate and human load. No React, so tests can check it.
 * The `usage` table is added by the module separately; every reader here treats it as optional.
 */
import type { Tables } from "./dashboard";

/** Mirrors the module's `usage` table (shared/src/schema.ts UsageRow, with a looser `phase`). */
export interface UsageRow {
  id: number;
  agent: string;
  requestId: number;
  taskId: number;
  conflictId: number;
  phase: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  createdAt: number;
}

/** The usage rows, or [] while the table (or its subscription) doesn't exist yet. */
export function usageRows(tables: Tables): UsageRow[] {
  const rows = (tables as unknown as { usage?: unknown }).usage;
  return Array.isArray(rows) ? (rows as UsageRow[]) : [];
}

export interface UsageTotals {
  key: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cache tokens. */
  tokens: number;
  costUsd: number;
  calls: number;
}
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export type Prices = Record<string, Price>;

/**
 * Parses VITE_PRICES_JSON: a JSON map of model-name prefix -> dollars per million tokens, e.g.
 * {"<model prefix>": {"input": <$>, "output": <$>, "cacheRead": <$>, "cacheWrite": <$>}}.
 * Anything malformed (bad JSON, a negative or non-numeric price, a missing field) is dropped, never
 * guessed at, so a typo shows up as "cost not priced" instead of a wrong number.
 */
export function parsePrices(json: string | undefined): Prices {
  if (!json || !json.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Prices = {};
  for (const [prefix, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!prefix || !value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const fields = [v.input, v.output, v.cacheRead, v.cacheWrite];
    if (fields.every((f) => typeof f === "number" && Number.isFinite(f) && f >= 0))
      out[prefix] = { input: v.input as number, output: v.output as number, cacheRead: v.cacheRead as number, cacheWrite: v.cacheWrite as number };
  }
  return out;
}

/** Dollars per million tokens, from VITE_PRICES_JSON. Empty when it is unset: no prices are built in. */
export const PRICES: Prices = parsePrices(
  (import.meta as unknown as { env?: { VITE_PRICES_JSON?: string } }).env?.VITE_PRICES_JSON,
);

const priceFor = (model: string, prices: Prices): Price | undefined => {
  const key = Object.keys(prices).filter((prefix) => model.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
  return key === undefined ? undefined : prices[key];
};

/** The reported cost, or an estimate from `prices` when the row reports 0 and its model is priced. */
export function rowCost(row: UsageRow, prices: Prices = PRICES): number {
  if (num(row.costUsd) > 0) return num(row.costUsd);
  const p = priceFor(row.model ?? "", prices);
  if (!p) return 0;
  return (num(row.inputTokens) * p.input + num(row.outputTokens) * p.output + num(row.cacheReadTokens) * p.cacheRead + num(row.cacheWriteTokens) * p.cacheWrite) / 1_000_000;
}

/** True when some row has tokens but neither a reported cost nor a matching price (so its cost is unknown). */
export function hasUnpriced(rows: UsageRow[], prices: Prices = PRICES): boolean {
  return rows.some((r) => num(r.costUsd) <= 0 && (num(r.inputTokens) + num(r.outputTokens) + num(r.cacheReadTokens) + num(r.cacheWriteTokens)) > 0 && !priceFor(r.model ?? "", prices));
}

const blank = (key: string): UsageTotals => ({ key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, costUsd: 0, calls: 0 });
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function groupUsage(rows: UsageRow[], by: (row: UsageRow) => string): UsageTotals[] {
  const groups = new Map<string, UsageTotals>();
  for (const row of rows) {
    const key = by(row);
    const g = groups.get(key) ?? blank(key);
    g.input += num(row.inputTokens);
    g.output += num(row.outputTokens);
    g.cacheRead += num(row.cacheReadTokens);
    g.cacheWrite += num(row.cacheWriteTokens);
    g.costUsd += rowCost(row);
    g.calls += 1;
    g.tokens = g.input + g.output + g.cacheRead + g.cacheWrite;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.key.localeCompare(b.key));
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const rate = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

export interface Metrics {
  usage: {
    total: UsageTotals;
    byAgent: UsageTotals[];
    byRequest: UsageTotals[];
    byPhase: UsageTotals[];
    /** Some tokens have no price: set VITE_PRICES_JSON. */
    unpriced: boolean;
  };
  conflicts: {
    total: number;
    open: number;
    escalated: number;
    needsHuman: number;
    resolved: number;
    /** Share of all conflicts that ever went to people; null with no conflicts. */
    escalationRate: number | null;
    /** Median ms from opened to resolved; 0 when none resolved. */
    medianResolveMs: number;
  };
  checks: { total: number; green: number; passRate: number | null };
  builds: { total: number; green: number; greenRate: number | null };
  human: { pendingReviews: number; decidedReviews: number; escalatedConflicts: number; testChangesWaiting: number };
}

export function computeMetrics(tables: Tables): Metrics {
  const rows = usageRows(tables);
  const conflicts = tables.conflict;
  const resolved = conflicts.filter((c) => c.status === "resolved");
  const escalatedNow = conflicts.filter((c) => c.status === "escalated").length;
  // A conflict that was escalated and later resolved still counts as escalated, via its thread.
  const everEscalated = new Set<number>(conflicts.filter((c) => c.status === "escalated").map((c) => c.id));
  for (const m of tables.message) if (m.kind === "escalate") everEscalated.add(m.conflictId);
  const known = new Set(conflicts.map((c) => c.id));
  const escalatedCount = [...everEscalated].filter((id) => known.has(id)).length;
  const checks = tables.check_run;
  const builds = tables.build;
  const greenChecks = checks.filter((c) => c.result === "green").length;
  const greenBuilds = builds.filter((b) => b.result === "green").length;
  const total = groupUsage(rows, () => "all")[0] ?? blank("all");
  return {
    usage: {
      total,
      byAgent: groupUsage(rows, (r) => r.agent || "unknown"),
      byRequest: groupUsage(rows, (r) => (r.requestId ? `#${r.requestId}` : "no request")),
      byPhase: groupUsage(rows, (r) => r.phase || "unknown"),
      unpriced: hasUnpriced(rows),
    },
    conflicts: {
      total: conflicts.length,
      open: conflicts.filter((c) => c.status === "open").length,
      escalated: escalatedNow,
      needsHuman: conflicts.filter((c) => c.status === "needs_human").length,
      resolved: resolved.length,
      escalationRate: rate(escalatedCount, conflicts.length),
      medianResolveMs: median(resolved.filter((c) => c.resolvedAt > c.createdAt).map((c) => c.resolvedAt - c.createdAt)),
    },
    checks: { total: checks.length, green: greenChecks, passRate: rate(greenChecks, checks.length) },
    builds: { total: builds.length, green: greenBuilds, greenRate: rate(greenBuilds, builds.length) },
    human: {
      pendingReviews: tables.review.filter((r) => r.status === "pending").length,
      decidedReviews: tables.review.filter((r) => r.status === "approved" || r.status === "rejected").length,
      escalatedConflicts: escalatedNow,
      testChangesWaiting: conflicts.filter((c) => c.status === "needs_human").length,
    },
  };
}

export const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
export const formatCost = (usd: number): string => (usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);
export const formatPercent = (value: number | null): string => (value === null ? "–" : `${Math.round(value * 100)}%`);
export function formatDuration(ms: number): string {
  if (ms <= 0) return "–";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

/** Sample rows for `?demo`, so the panel can be seen without a live database. */
export function sampleUsage(now: number): UsageRow[] {
  const row = (id: number, agent: string, phase: string, requestId: number, input: number, output: number, costUsd: number): UsageRow => ({
    id, agent, requestId, taskId: 0, conflictId: 0, phase, model: "claude-sonnet-5-5",
    inputTokens: input, outputTokens: output, cacheReadTokens: Math.round(input * 2.5), cacheWriteTokens: Math.round(input * 0.2), costUsd, createdAt: now - id * 60_000,
  });
  return [
    row(1, "orchestrator", "planning", 1, 18_000, 2_400, 0.09),
    row(2, "a", "implementing", 1, 42_000, 6_800, 0.31),
    row(3, "b", "implementing", 1, 38_000, 5_100, 0.27),
    row(4, "a", "negotiating", 1, 6_000, 900, 0.04),
    row(5, "b", "negotiating", 1, 6_500, 1_100, 0.05),
    row(6, "b", "checking", 1, 3_000, 400, 0.02),
  ];
}
