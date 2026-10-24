/** WHAT IT'S FOR: symbolic team status; inspect a node to progressively reveal details. Owner: D. */
import type { AgentRow } from "../../../shared/src/schema.ts";
import {
  isActiveConflict,
  latestCombinedCheck,
  sortAgents,
  teamHealth,
  timelineEvents,
} from "../dashboard";
import { useDashboard } from "../stdb";
import { Icon } from "./Icon";

export type Inspection =
  | { kind: "agent"; name: string }
  | { kind: "conflict"; id?: number }
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
  const check = latestCombinedCheck(tables);
  const facts = tables.intent.filter((i) => i.verified);
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
      <div className="map-caption">
        <span>
          <span className={`dot ${ready ? "tone-cyan" : "muted"}`} />
          {ready
            ? `${agents.filter((a) => a.online).length} agents online`
            : tables.agent.length
              ? "Cached state · connection unavailable"
              : "Awaiting connection"}
        </span>
        <span>
          {connection.phase === "demo"
            ? "Simulated workspace"
            : "Shared integration state"}
        </span>
      </div>
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
          {agents.map((agent) => (
            <button
              key={agent.name}
              type="button"
              className={`map-agent tone-${ready ? agentTone(agent) : "neutral"}`}
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
              </span>
              <span className="map-agent-name">
                Agent {agent.name.toUpperCase()}
              </span>
            </button>
          ))}
          {!agents.length && (
            <div className="map-no-agents">
              <span className="empty-agent">
                <Icon name="agent" size={27} />
              </span>
              <span>No agents yet</span>
            </div>
          )}
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
      <div className="overview-shortcuts">
        <button type="button" onClick={() => inspect({ kind: "checks" })}>
          <span
            className={`shortcut-symbol ${!ready || !check ? "muted" : health.tone === "amber" ? "tone-amber" : check.result === "green" ? "tone-green" : "tone-red"}`}
          >
            <Icon
              name={
                !ready || !check || health.tone === "amber"
                  ? "clock"
                  : check.result === "green"
                    ? "check"
                    : "alert"
              }
              size={21}
            />
          </span>
          <span>Checks</span>
          <span className="shortcut-value">
            {!ready
              ? "Offline"
              : !check || health.tone === "amber"
                ? "Pending"
                : check.result === "green"
                  ? "Passing"
                  : "Failed"}
          </span>
        </button>
        <button type="button" onClick={() => inspect({ kind: "memory" })}>
          <span className="shortcut-symbol tone-violet">
            <Icon name="memory" size={21} />
          </span>
          <span>Memory</span>
          <span className="shortcut-value">
            {facts.length} fact{facts.length === 1 ? "" : "s"}
          </span>
        </button>
        <button type="button" onClick={() => inspect({ kind: "activity" })}>
          <span className="shortcut-symbol tone-cyan">
            <Icon name="activity" size={21} />
          </span>
          <span>Activity</span>
          <span className="shortcut-value">
            {timelineEvents(tables).length} events
          </span>
        </button>
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
