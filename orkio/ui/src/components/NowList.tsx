/** WHAT IT'S FOR: one row per agent: what it is doing right now, its check state, files and last activity. */
import { sortAgents, type Tables } from "../dashboard";
import { agentNow, upper, type Selection } from "../team";
import { absoluteTime, relativeTime } from "../time";
import { useNow } from "../useNow";
import { sameSelection } from "./select";

const MAX_FILES = 3;

export function NowList({
  tables,
  selection,
  select,
}: {
  tables: Tables;
  selection: Selection | null;
  select: (s: Selection) => void;
}) {
  const now = useNow();
  const agents = sortAgents(tables.agent);
  return (
    <section className="panel now" aria-labelledby="now-title">
      <h2 id="now-title">Now</h2>
      {agents.length === 0 ? (
        <p className="muted">No agents connected.</p>
      ) : (
        <ul>
          {agents.map((agent) => {
            const n = agentNow(tables, agent);
            const files = n.task?.files.length ? n.task.files : agent.files;
            const target: Selection = { kind: "agent", name: agent.name };
            return (
              <li key={agent.name}>
                <button
                  type="button"
                  className={`now-row${agent.online ? "" : " offline"}${sameSelection(selection, target) ? " selected" : ""}`}
                  onClick={() => select(target)}
                >
                  <span className="now-top">
                    <span className={`avatar tone-${n.stateTone}`}>
                      {upper(agent.name)}
                    </span>
                    {/* Passing needs no word: the green dot says it. */}
                    {n.stateTone === "green" ? (
                      <span className="dot tone-green" title="Green" />
                    ) : (
                      <span className={`chip tone-${n.stateTone}`}>{n.state}</span>
                    )}
                    {n.task && <span className="chip">task #{n.task.id}</span>}
                    <time
                      title={absoluteTime(n.lastActive)}
                      className="muted"
                    >
                      {relativeTime(n.lastActive, now)}
                    </time>
                  </span>
                  <span className="now-doing">{n.doing}</span>
                  {n.badges.length > 0 && (
                    <span className="now-badges">
                      {n.badges.map((b) => (
                        <span key={b} className="chip tone-amber">
                          {b}
                        </span>
                      ))}
                    </span>
                  )}
                  {files.length > 0 && (
                    <span className="now-files">
                      {files.slice(0, MAX_FILES).map((f) => (
                        <code key={f}>{f}</code>
                      ))}
                      {files.length > MAX_FILES && (
                        <span className="muted">+{files.length - MAX_FILES}</span>
                      )}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
