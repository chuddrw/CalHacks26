/** WHAT IT'S FOR: the Metrics drawer: tokens and cost, conflicts, checks, builds and human load. */
import type { Tables } from "../dashboard";
import {
  computeMetrics,
  formatCost,
  formatDuration,
  formatPercent,
  formatTokens,
  sampleUsage,
  usageRows,
  type UsageTotals,
} from "../metrics";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

function UsageTable({ title, rows }: { title: string; rows: UsageTotals[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="d-section">
      <h3>{title}</h3>
      <table className="metric-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Tokens</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.key}</th>
              <td title={`in ${r.input} · out ${r.output} · cache read ${r.cacheRead} · cache write ${r.cacheWrite}`}>
                {formatTokens(r.tokens)}
              </td>
              <td>{formatCost(r.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function MetricsView({ tables, demo = demoRequested() }: { tables: Tables; demo?: boolean }) {
  const real = usageRows(tables);
  const sample = demo && real.length === 0;
  const m = computeMetrics(sample ? ({ ...tables, usage: sampleUsage(Date.now()) } as unknown as Tables) : tables);
  const hasUsage = m.usage.total.calls > 0;
  return (
    <>
      {sample && <p className="muted">Sample usage numbers (?demo). Conflicts, checks and builds below are real.</p>}
      <section className="d-section">
        <h3>Tokens and cost</h3>
        {hasUsage ? (
          <div className="stats">
            <Stat label="Tokens" value={formatTokens(m.usage.total.tokens)} note={`${formatTokens(m.usage.total.output)} output`} />
            <Stat label="Cost" value={m.usage.unpriced && m.usage.total.costUsd === 0 ? "not priced" : formatCost(m.usage.total.costUsd)} note={`${m.usage.total.calls} calls`} />
          </div>
        ) : (
          <p className="muted">No usage reported yet. Agents report tokens when a turn ends.</p>
        )}
      </section>
 {hasUsage && m.usage.unpriced && (
        <p className="muted" role="status">
          Cost not priced (set VITE_PRICES_JSON): some tokens have no price, so their cost is not counted.
        </p>
      )}
      <UsageTable title="By agent" rows={m.usage.byAgent} />
      <UsageTable title="By request" rows={m.usage.byRequest} />
      <UsageTable title="By phase" rows={m.usage.byPhase} />
      <section className="d-section">
        <h3>Conflicts</h3>
        <div className="stats">
          <Stat label="Open" value={String(m.conflicts.open)} />
          <Stat label="Escalated" value={String(m.conflicts.escalated)} />
          <Stat label="Resolved" value={String(m.conflicts.resolved)} />
          <Stat label="Escalation rate" value={formatPercent(m.conflicts.escalationRate)} />
          <Stat label="Median time to resolve" value={formatDuration(m.conflicts.medianResolveMs)} />
        </div>
      </section>
      <section className="d-section">
        <h3>Checks and builds</h3>
        <div className="stats">
          <Stat label="Check pass rate" value={formatPercent(m.checks.passRate)} note={`${m.checks.green} of ${m.checks.total}`} />
          <Stat label="Build green rate" value={formatPercent(m.builds.greenRate)} note={`${m.builds.green} of ${m.builds.total}`} />
        </div>
      </section>
      <section className="d-section">
        <h3>Human load</h3>
        <div className="stats">
          <Stat label="Reviews pending" value={String(m.human.pendingReviews)} />
          <Stat label="Reviews decided" value={String(m.human.decidedReviews)} />
          <Stat label="Conflicts waiting on people" value={String(m.human.escalatedConflicts)} />
          <Stat label="Test changes to review" value={String(m.human.testChangesWaiting)} />
        </div>
      </section>
    </>
  );
}

function demoRequested(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").has("demo");
  } catch {
    return false;
  }
}
