/**
 * ui/src/components/DroidPanel.tsx
 *
 * WHAT IT'S FOR
 *   Shows Droid's work on the current conflict as it happens: each tool call (e.g. running the
 *   failing test), what came back, and the final explanation. Factory's judges dock points when
 *   "you can't see what the agent did", so this panel is what makes the Droid prize possible.
 *   It shows the Claude fallback's single step the same way.
 *
 * OWNER: D. WHEN: Sat 14:00-19:00.
 * DONE WHEN: during the demo conflict, steps appear one by one while Droid works, newest at the bottom.
 *
 * TODO (D): auto-scroll to the newest step, and label the source ("Droid" or "Claude fallback").
 */
import type { ConflictRow } from "../../../shared/src/schema.ts";
import { useRows } from "../stdb";

export function DroidPanel({ conflict }: { conflict: ConflictRow | undefined }) {
  const steps = useRows("diagnosis_step").filter((s) => conflict && s.conflictId === conflict.id);

  return (
    <section className="panel">
      <h2>Droid diagnosis</h2>
      {!conflict && <p className="empty">Starts when a check turns red.</p>}
      {conflict && steps.length === 0 && <p className="empty">Waiting for Droid…</p>}
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.id}>
            <strong>{s.kind}</strong> {s.detail}
          </li>
        ))}
      </ol>
    </section>
  );
}
