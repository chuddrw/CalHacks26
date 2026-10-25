/** WHAT IT'S FOR: the bar at the top that appears only when a human has to act (review, decision, test change). */
import type { HumanAction, Selection } from "../team";

export function NeedsYou({
  actions,
  select,
}: {
  actions: HumanAction[];
  select: (s: Selection) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <section className="needs-you" role="status" aria-label="Needs a human">
      <strong className="needs-title">Needs you</strong>
      <ul>
        {actions.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className={`needs-item tone-${a.tone}`}
              onClick={() => select(a.select)}
            >
              <span className="needs-who">{a.who}</span>
              <span>{a.text}</span>
              <span className="needs-open">Open →</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
