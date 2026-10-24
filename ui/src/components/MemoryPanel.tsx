/** WHAT IT'S FOR: verified team knowledge and recent intents, including new-fact emphasis. Owner: D. */
import { useState } from "react";
import { useRows } from "../stdb";
import { relativeTime, absoluteTime } from "../time";
import { useNow } from "../useNow";
import { Icon } from "./Icon";
export function MemoryPanel() {
  const intents = useRows("intent");
  const now = useNow();
  const [showAll, setShowAll] = useState(false);
  const facts = intents
    .filter((i) => i.verified)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const plans = intents
    .filter((i) => !i.verified)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  return (
    <section
      className="panel memory-panel"
      id="memory"
      aria-labelledby="memory-title"
    >
      <div className="section-heading">
        <h2 id="memory-title">
          <Icon name="memory" />
          Shared memory
        </h2>
        <span className="count">{facts.length} verified</span>
      </div>
      <p className="panel-description">Context that travels with your team.</p>
      <div className="facts-list">
        {facts.length ? (
          facts.map((f) => (
            <article
              key={f.id}
              className={`fact-card${now - f.createdAt < 15000 ? " new-fact" : ""}`}
            >
              <Icon name="check" size={17} />
              <div>
                <span className="eyebrow">VERIFIED FACT</span>
                <p>{f.summary}</p>
                <div className="fact-meta">
                  {f.symbols.map((s) => (
                    <code key={s}>{s}</code>
                  ))}
                  <time title={absoluteTime(f.createdAt)}>
                    {relativeTime(f.createdAt, now)}
                  </time>
                </div>
              </div>
            </article>
          ))
        ) : (
          <div className="empty-message">
            <Icon name="memory" />
            <p>
              Verified knowledge appears after a conflict is resolved with a
              passing check.
            </p>
          </div>
        )}
      </div>
      <div className="subsection-heading">
        <h3>Team intentions</h3>
        <span className="small muted">Before the next change</span>
      </div>
      <ul className="intent-list">
        {(showAll ? plans : plans.slice(0, 4)).map((p) => (
          <li key={p.id}>
            <span className="avatar-mini">
              {p.agent.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <p>{p.summary}</p>
              <div className="small muted">
                <time title={absoluteTime(p.createdAt)}>
                  {relativeTime(p.createdAt, now)}
                </time>
                {p.files.length > 0 && (
                  <span>
                    {" "}
                    · {p.files.length} file{p.files.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {!plans.length && <p className="small muted">No plans shared yet.</p>}
      {plans.length > 4 && (
        <button
          className="text-button"
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll
            ? "Show fewer intentions"
            : `Show all ${plans.length} intentions`}
          <Icon name="chevron" size={12} />
        </button>
      )}
    </section>
  );
}
