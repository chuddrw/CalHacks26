/** WHAT IT'S FOR: symbolic team status; inspect a node to progressively reveal details. Owner: D. */
import type { AgentRow } from "../../../shared/src/schema.ts";
import { isActiveConflict, sortAgents, teamHealth } from "../dashboard";
import { useDashboard } from "../stdb";
import { Icon } from "./Icon";

export type Inspection =
  | { kind: "agent"; name: string }
  | { kind: "conflict"; id?: number }
  | { kind: "orchestrator"; id?: number }
  | { kind: "memory" }
  | { kind: "activity" }
  | { kind: "checks" }
  | { kind: "connection" };
function agentTone(agent: AgentRow) {
  return !agent.online
    ? "neutral"
    : agent.status === "red"
      ? "red"
      : agent.status === "green"
        ? "green"
        : "cyan";
}
export function Overview({
  inspect,
}: {
  inspect: (target: Inspection) => void;
}) {
  const { tables, connection } = useDashboard();
  const agents = sortAgents(tables.agent);
  const health = teamHealth(tables, connection);
  const active = tables.conflict.filter(isActiveConflict);
  // People the orchestrator is waiting for: reviews of major changes, and escalated conflicts.
  const pendingReviews = tables.review.filter((review) => review.status === "pending");
  const planning = tables.request.filter((request) => request.status === "planning" || request.status === "new");
  const ready = connection.phase === "live" || connection.phase === "demo";
  const hubLabel = !ready
    ? "Not connected"
    : active.length
      ? `${active.length} conflict${active.length === 1 ? "" : "s"}`
      : health.tone === "green"
        ? "In sync"
        : health.tone === "red"
          ? "Check failed"
          : health.tone === "amber"
            ? "Checking"
            : "Awaiting check";
  const hubIcon = !ready
    ? "link"
    : health.tone === "red"
      ? "alert"
      : health.tone === "green"
        ? "check"
        : "activity";
  const hubAction = () =>
    inspect(
      !ready
        ? { kind: "connection" }
        : active.length || (health.tone === "green" && tables.conflict.length)
          ? { kind: "conflict" }
          : { kind: "checks" },
    );
  return (
    <section className="visual-overview" aria-label="Connected agent map">
      {!agents.length && (
        <div className="empty-team-announcement" role="status">
          <strong>No agents yet</strong>
          <span>Connected agents will appear at the desk.</span>
        </div>
      )}
      <div
        className={`constellation${agents.length > 4 ? " many-agents" : ""}`}
      >
        <div className="map-halo" aria-hidden="true" />
        {agents.length > 0 && (
          <svg
            className="constellation-links"
            viewBox="0 0 1000 400"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="link-fade" x1="0" y1="0" x2="0" y2="1">
                <stop stopColor="#6cdded" stopOpacity=".65" />
                <stop offset="1" stopColor="#6cdded" stopOpacity=".12" />
              </linearGradient>
            </defs>
            {agents.map((agent, i) => {
              const x = ((i + 0.5) / agents.length) * 1000;
              const route = `M${x} 91 C${x} 215 500 150 500 255`;
              return (
                <g
                  key={agent.name}
                  className={`tone-${ready ? agentTone(agent) : "neutral"}`}
                >
                  <path d={route} className="constellation-track" />
                  <path
                    d={route}
                    className={`constellation-flow ${agent.status === "working" && ready ? "flowing" : ""}`}
                  />
                </g>
              );
            })}
          </svg>
        )}
        <div
          className="map-agents"
          style={{
            gridTemplateColumns: `repeat(${Math.min(Math.max(agents.length, 1), 6)}, minmax(0, 1fr))`,
          }}
        >
          {agents.map((agent, index) => (
            <button
              key={agent.name}
              type="button"
              className={`map-agent seat-${index} ${index === 2 || index === 3 ? "screen-back" : "screen-front"} tone-${ready ? agentTone(agent) : "neutral"}`}
              onClick={() => inspect({ kind: "agent", name: agent.name })}
              aria-label={`Inspect agent ${agent.name.toUpperCase()}, ${!ready ? "cached state" : agent.online ? (agent.status === "red" ? "check failed" : agent.status === "green" ? "check passed" : "working") : "offline"}`}
              title={`Agent ${agent.name.toUpperCase()} · ${agent.intent || "No intent yet"}`}
            >
              <span className="map-agent-symbol">
                <Icon name="agent" size={26} />
                <span className="map-status-mark">
                  <Icon
                    name={
                      !ready || !agent.online
                        ? "pause"
                        : agent.status === "red"
                          ? "alert"
                          : agent.status === "green"
                            ? "check"
                            : "code"
                    }
                    size={11}
                  />
                </span>
                <span className="screen-face-content" aria-hidden="true">
                  <strong>Agent {agent.name.toUpperCase()}</strong>
                  <span>
                    {!ready
                      ? "Cached state"
                      : !agent.online
                        ? "Offline"
                        : agent.status === "red"
                          ? "Check failed"
                          : agent.status === "green"
                            ? "Check passed"
                            : "Working"}
                  </span>
                  {agent.files.slice(0, 2).map((file) => (
                    <span className="screen-file" key={file}>
                      <Icon name="code" size={11} />
                      {file}
                    </span>
                  ))}
                </span>
              </span>
              <span className="screen-base" aria-hidden="true" />
              <span className="map-agent-name">
                Agent {agent.name.toUpperCase()}
                <small>
                  {!ready
                    ? "Cached state"
                    : !agent.online
                      ? "Offline"
                      : agent.status === "red"
                        ? "Check failed"
                        : agent.status === "green"
                          ? "Check passed"
                          : "Working"}
                </small>
              </span>
            </button>
          ))}
        </div>
        <div className={`map-center tone-${health.tone}`}>
          <button
            type="button"
            className="health-orb"
            onClick={hubAction}
            aria-label={`Inspect team status: ${health.title}`}
            title={health.title}
          >
            <span className="orb-ring outer" />
            <span className="orb-ring inner" />
            <Icon name={hubIcon} size={37} />
            {active.length > 0 && (
              <span className="orb-count">{active.length}</span>
            )}
          </button>
          <h2 role="status">{hubLabel}</h2>
          {(pendingReviews.length > 0 || planning.length > 0) && (
            <button
              type="button"
              className="orchestrator-callout"
              onClick={() => inspect({ kind: "orchestrator", id: (pendingReviews[0]?.requestId ?? planning[0]?.id) })}
            >
              <Icon name="sparkle" size={14} />
              {pendingReviews.length > 0
                ? `${pendingReviews.length} review${pendingReviews.length === 1 ? "" : "s"} waiting for ${[...new Set(pendingReviews.map((r) => r.reviewer.toUpperCase()))].join(", ")}`
                : "Droid is planning a request"}
            </button>
          )}
          <span className="orb-caption">
            {health.tone === "red" &&
            active.some(
              (c) => c.status === "needs_human" || c.status === "escalated",
            )
              ? "Human attention needed"
              : "Team health"}
          </span>
        </div>
      </div>
      <div className="map-legend" aria-label="Status symbol legend">
        <span>
          <Icon name="check" size={12} />
          Passing
        </span>
        <span>
          <Icon name="alert" size={12} />
          Needs attention
        </span>
        <span>
          <Icon name="code" size={12} />
          Working
        </span>
        <span>
          <Icon name="pause" size={12} />
          Offline
        </span>
      </div>
    </section>
  );
}
