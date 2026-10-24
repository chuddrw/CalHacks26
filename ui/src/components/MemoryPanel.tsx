/**
 * ui/src/components/MemoryPanel.tsx
 *
 * WHAT IT'S FOR
 *   Shows the team's shared memory: verified facts at the top (what the watcher proved with a green
 *   check, e.g. "User.lastLogin is milliseconds"), then teammates' recent intents. Demo beat 4 points
 *   at this panel: a fact appears here, and the next agent gets it right the first time.
 *
 * OWNER: D. WHEN: Sat 20:00-24:00.
 * TODO (D): highlight a fact for a few seconds when it first appears.
 */
import { useRows } from "../stdb";

export function MemoryPanel() {
  const intents = useRows("intent");
  const facts = intents.filter((i) => i.verified);
  const plans = intents.filter((i) => !i.verified).slice(-8).reverse();

  return (
    <section className="panel">
      <h2>Shared memory</h2>
      {facts.length === 0 && plans.length === 0 && <p className="empty">Nothing yet.</p>}
      <ul className="events">
        {facts.map((f) => (
          <li key={f.id}>
            <strong>verified:</strong> {f.summary}
          </li>
        ))}
        {plans.map((p) => (
          <li key={p.id}>
            {p.agent}: {p.summary}
          </li>
        ))}
      </ul>
    </section>
  );
}
