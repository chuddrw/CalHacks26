/** WHAT IT'S FOR: an agent node showing presence, plan, snapshot activity, and check status. Owner: D. */
import { useEffect, useRef, useState } from "react";
import type { AgentRow } from "../../../shared/src/schema.ts";
import { wipBranch } from "../../../shared/src/schema.ts";
import { useRows } from "../stdb";
import { absoluteTime, relativeTime } from "../time";
import { useNow } from "../useNow";
import { Icon } from "./Icon";
export function AgentCard({ agent }: { agent: AgentRow }) {
  const now = useNow();
  const latest = useRows("snapshot")
    .filter((s) => s.agent === agent.name)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0];
  const previous = useRef(agent.lastSnapshotAt);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (agent.lastSnapshotAt <= previous.current) {
      previous.current = agent.lastSnapshotAt;
      return;
    }
    previous.current = agent.lastSnapshotAt;
    setFresh(true);
    const timer = setTimeout(() => setFresh(false), 2400);
    return () => clearTimeout(timer);
  }, [agent.lastSnapshotAt]);
  const label =
    agent.status === "red"
      ? "Check failed"
      : agent.status === "green"
        ? "Check passed"
        : "Working";
  return (
    <article
      className={`agent-node status-${agent.status}${agent.online ? "" : " offline"}${fresh ? " fresh" : ""}`}
    >
      <div className="agent-top">
        <span className="agent-avatar">
          {agent.name.slice(0, 2).toUpperCase()}
          <span className={`presence ${agent.online ? "online" : ""}`} />
        </span>
        <div>
          <h3>Agent {agent.name.toUpperCase()}</h3>
          <span className="small muted">
            {agent.online ? "Connected" : "Offline"}
          </span>
        </div>
        <span
          className={`agent-state tone-${agent.status === "red" ? "red" : agent.status === "green" ? "green" : "amber"}`}
        >
          <span className="dot" />
          {label}
        </span>
      </div>
      <p className="agent-intent">{agent.intent || "Waiting for an intent"}</p>
      <div className="agent-meta">
        <span>
          <Icon name="branch" size={12} />
          <code>{wipBranch(agent.name)}</code>
        </span>
        <code className="snapshot-sha" title={latest?.sha}>
          {latest ? latest.sha.slice(0, 7) : "No snapshot"}
        </code>
      </div>
      <div className="agent-footer">
        {agent.files.length > 0 ? (
          <details className="agent-files">
            <summary>
              {agent.files.length} file{agent.files.length === 1 ? "" : "s"}{" "}
              changed
            </summary>
            <ul>
              {agent.files.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <span className="small muted">No changed files</span>
        )}
        <time
          dateTime={
            agent.lastSnapshotAt
              ? new Date(agent.lastSnapshotAt).toISOString()
              : undefined
          }
          title={absoluteTime(agent.lastSnapshotAt)}
        >
          {relativeTime(agent.lastSnapshotAt, now)}
        </time>
      </div>
    </article>
  );
}
