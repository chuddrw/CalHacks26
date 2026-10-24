/** WHAT IT'S FOR: time-ordered snapshot, check, intent, conflict, and resolution events. Owner: D. */
import { useState } from "react";
import { timelineEvents } from "../dashboard";
import { useDashboard } from "../stdb";
import { absoluteTime, relativeTime } from "../time";
import { useNow } from "../useNow";
import { Icon } from "./Icon";
export function Timeline() {
  const { tables } = useDashboard();
  const now = useNow();
  const [filter, setFilter] = useState("all");
  const events = timelineEvents(tables).filter(
    (e) =>
      filter === "all" ||
      (filter === "checks"
        ? e.kind === "check"
        : e.kind === "conflict" || e.kind === "resolved"),
  );
  return (
    <section
      className="panel timeline-panel"
      id="activity"
      aria-labelledby="activity-title"
    >
      <div className="section-heading">
        <h2 id="activity-title">
          <Icon name="activity" />
          Team activity
        </h2>
        <label className="event-filter">
          <span className="sr-only">Filter activity</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All events</option>
            <option value="checks">Checks</option>
            <option value="conflicts">Conflicts</option>
          </select>
        </label>
      </div>
      <p className="panel-description">
        A shared history of what changed and what passed.
      </p>
      {events.length ? (
        <ol className="activity-list" tabIndex={0} aria-label="Activity events">
          {events.map((e) => (
            <li key={e.id}>
              <span className={`activity-icon tone-${e.tone}`}>
                <Icon
                  size={14}
                  name={
                    e.kind === "check" || e.kind === "resolved"
                      ? e.tone === "green"
                        ? "check"
                        : "alert"
                      : e.kind === "snapshot"
                        ? "branch"
                        : e.kind === "fact"
                          ? "sparkle"
                          : e.kind === "conflict"
                            ? "alert"
                            : "code"
                  }
                />
              </span>
              <div>
                <strong>{e.title}</strong>
                <p>{e.detail}</p>
              </div>
              <time title={absoluteTime(e.at)}>{relativeTime(e.at, now)}</time>
            </li>
          ))}
        </ol>
      ) : (
        <div className="empty-message">
          <Icon name="activity" />
          <p>
            {filter === "all"
              ? "Snapshots and checks will appear as your agents work."
              : "No events match this filter yet."}
          </p>
        </div>
      )}
    </section>
  );
}
