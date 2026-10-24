/**
 * ui/src/components/AgentCard.tsx
 *
 * WHAT IT'S FOR
 *   One card per teammate's agent: name, online or offline, its check state (working, green, red),
 *   what it says it's doing (latest intent), and the files in its latest snapshot. In the demo, the
 *   cards are how judges see that four separate laptops are all being watched at once.
 *
 * OWNER: D. WHEN: Sat 9:20-13:00.
 * TODO (D): show "last snapshot 12 s ago" (lastSnapshotAt), and briefly flash the card when a
 *           new snapshot arrives so judges can see edits flowing in.
 */
import type { AgentRow } from "../../../shared/src/schema.ts";

export function AgentCard({ agent }: { agent: AgentRow }) {
  return (
    <article className={`card status-${agent.status}${agent.online ? "" : " offline"}`}>
      <h2>{agent.name}</h2>
      <p className="badge">{agent.online ? agent.status : "offline"}</p>
      <p className="intent">{agent.intent || "No intent posted yet"}</p>
      <ul className="files">
        {agent.files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </article>
  );
}
