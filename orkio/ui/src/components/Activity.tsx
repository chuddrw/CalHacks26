/** WHAT IT'S FOR: the latest team events (requests, tasks, thread messages, checks), newest first. */
import type { ActivityEvent, Selection } from "../team";
import { absoluteTime, relativeTime } from "../time";
import { useNow } from "../useNow";

export function ActivityList({
  events,
  select,
}: {
  events: ActivityEvent[];
  select: (s: Selection) => void;
}) {
  const now = useNow();
  if (events.length === 0) return <p className="muted">Nothing has happened yet.</p>;
  return (
    <ol className="activity">
      {events.map((e) => {
        const body = (
          <>
            <time title={absoluteTime(e.at)}>{relativeTime(e.at, now)}</time>
            <span className={`dot tone-${e.tone}`} />
            <span className="activity-text">
              {e.who && <strong>{e.who} </strong>}
              {e.text}
            </span>
          </>
        );
        const target = e.select;
        return (
          <li key={e.id}>
            {target ? (
              <button type="button" onClick={() => select(target)}>
                {body}
              </button>
            ) : (
              <div>{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function ActivityStrip({
  events,
  select,
}: {
  events: ActivityEvent[];
  select: (s: Selection) => void;
}) {
  return (
    <section className="panel activity-strip" aria-labelledby="activity-title">
      <div className="panel-head">
        <h2 id="activity-title">Activity</h2>
        <button
          type="button"
          className="link"
          onClick={() => select({ kind: "activity" })}
        >
          All activity
        </button>
      </div>
      <ActivityList events={events.slice(0, 5)} select={select} />
    </section>
  );
}
