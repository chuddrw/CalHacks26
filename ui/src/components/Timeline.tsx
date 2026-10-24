/**
 * ui/src/components/Timeline.tsx
 *
 * WHAT IT'S FOR
 *   Every event in order, newest first: snapshots pushed, check runs (green or red), intents posted
 *   and conflicts opened. In Q&A it's the proof that what judges saw really happened, and when.
 *
 * OWNER: D. WHEN: Sat 14:00-19:00.
 * TODO (D): show times as "12 s ago", and color only the word "red" or "green", not whole lines.
 */
import { useRows } from "../stdb";

interface TimelineEvent {
  key: string;
  at: number;
  text: string;
}

export function Timeline() {
  const snapshots = useRows("snapshot");
  const runs = useRows("check_run");
  const intents = useRows("intent");
  const conflicts = useRows("conflict");

  const events: TimelineEvent[] = [
    ...snapshots.map((s) => ({ key: `s${s.id}`, at: s.createdAt, text: `${s.agent} pushed a snapshot (${s.files.length} files)` })),
    ...runs.map((r) => ({ key: `r${r.runKey}`, at: r.createdAt, text: `check ${r.agents.join(" + ")}: ${r.result}` })),
    ...intents.map((i) => ({ key: `i${i.id}`, at: i.createdAt, text: `${i.verified ? "fact" : i.agent}: ${i.summary}` })),
    ...conflicts.map((c) => ({ key: `c${c.id}`, at: c.createdAt, text: `conflict #${c.id} (${c.kind}), fixer ${c.fixer}` })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 30);

  return (
    <section className="panel">
      <h2>Timeline</h2>
      {events.length === 0 && <p className="empty">No events yet.</p>}
      <ol className="events">
        {events.map((e) => (
          <li key={e.key}>
            {new Date(e.at).toLocaleTimeString()} {e.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
