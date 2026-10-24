/**
 * ui/src/components/ConflictPanel.tsx
 *
 * WHAT IT'S FOR
 *   The demo's money shot: which two lines clash ("src/users/user.ts:14 x src/sessions/idle.ts:7"),
 *   who is fixing it, the first error, the explanation once it arrives, and the status
 *   (open, escalated, needs a human, resolved).
 *
 * OWNER: D. WHEN: Sat 9:20-13:00, polish Sat 14:00-19:00.
 * DONE WHEN: on the demo conflict, a judge can read both locations and the fixer from a meter away.
 *
 * TODO (D): show 3 lines of code around each location, taken from the agents' latest snapshot diffs
 *           (useRows("snapshot")), so judges see the two clashing lines side by side.
 * TODO (D): make "escalated" and "needs_human" impossible to miss; that's when a person must act.
 */
import type { ConflictRow } from "../../../shared/src/schema.ts";

const STATUS_TEXT: Record<ConflictRow["status"], string> = {
  open: "open: agent is fixing",
  escalated: "escalated: a person should look",
  needs_human: "needs a person: the fix changed tests",
  resolved: "resolved",
};

export function ConflictPanel({ conflicts }: { conflicts: ConflictRow[] }) {
  return (
    <section className="panel">
      <h2>Conflicts</h2>
      {conflicts.length === 0 && <p className="empty">No open conflicts.</p>}
      {conflicts.map((c) => (
        <article key={c.id}>
          <p className="badge">
            #{c.id} {c.kind}: {STATUS_TEXT[c.status]}
          </p>
          <p>
            {c.locA || c.agentA}
            {c.agentB ? ` × ${c.locB || c.agentB}` : ""}
          </p>
          <p>Fixer: {c.fixer}</p>
          <pre>{c.error}</pre>
          {c.explanation && <p>{c.explanation}</p>}
        </article>
      ))}
    </section>
  );
}
