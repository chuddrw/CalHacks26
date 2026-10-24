/**
 * ui/src/App.tsx
 *
 * WHAT IT'S FOR
 *   The dashboard layout: agent cards across the top, the open conflict and Droid's live work in
 *   the middle, memory and the event timeline at the bottom. Add ?big to the URL for big-screen
 *   mode (larger type, built for reading from across a table).
 *
 * OWNER: D. WHEN: Sat 9:20-13:00 (layout), Sat 14:00-19:00 (big-screen polish).
 * DONE WHEN: judges standing a meter from the monitor can read the two clashing locations and the
 *            one-line summary without leaning in.
 *
 * The header line is the demo's headline: "all green", or the number of open conflicts in red text
 * (always text as well as color, so it reads for color-blind viewers and on any projector).
 */
import { AgentCard } from "./components/AgentCard";
import { ConflictPanel } from "./components/ConflictPanel";
import { DroidPanel } from "./components/DroidPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { Timeline } from "./components/Timeline";
import { useRows } from "./stdb";

export function App() {
  const agents = useRows("agent");
  const conflicts = useRows("conflict");
  const open = conflicts.filter((c) => c.status !== "resolved");
  const big = new URLSearchParams(window.location.search).has("big");

  return (
    <main className={big ? "app big" : "app"}>
      <header className="topbar">
        <h1>Agent Cowork</h1>
        <p className={open.length ? "headline red" : "headline green"}>
          {open.length ? `${open.length} open conflict${open.length > 1 ? "s" : ""}` : "All green"}
        </p>
      </header>

      <section className="agents">
        {agents.length ? agents.map((a) => <AgentCard key={a.name} agent={a} />) : <p className="empty">Waiting for agents…</p>}
      </section>

      <section className="middle">
        <ConflictPanel conflicts={open} />
        <DroidPanel conflict={open[0]} />
      </section>

      <section className="bottom">
        <MemoryPanel />
        <Timeline />
      </section>
    </main>
  );
}
