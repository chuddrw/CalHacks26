/**
 * WHAT IT'S FOR: the dashboard's one screen. Header (project, Live/Simulated, team health), a
 * "Needs you" bar only when a person must act, the team graph next to the "Now" list, recent
 * activity, and a details drawer for whatever was clicked. All data comes from team.ts.
 */
import { useCallback, useState } from "react";
import { teamHealth } from "./dashboard";
import { useDashboard } from "./stdb";
import { activity, hiveStats, needsYou, teamGraph, type Selection } from "./team";
import { useNow } from "./useNow";
import { ActivityStrip } from "./components/Activity";
import { DemoBar } from "./components/DemoBar";
import { Details } from "./components/Details";
import { Graph } from "./components/Graph";
import { NeedsYou } from "./components/NeedsYou";
import { NowList } from "./components/NowList";
import { useFlights } from "./components/useFlights";

const phaseLabel = {
  demo: "Simulated",
  live: "Live",
  unconfigured: "Not connected",
  error: "Connection error",
  syncing: "Syncing",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
} as const;

export function App() {
  const { tables, connection } = useDashboard();
  const now = useNow();
  const [selection, setSelection] = useState<Selection | null>(null);
  const close = useCallback(() => setSelection(null), []);
  const demo = connection.phase === "demo";
  const flights = useFlights(tables, connection.phase);
  const health = teamHealth(tables, connection);
  const facts = tables.intent.filter((i) => i.verified).length;
  const project =
    import.meta.env.VITE_PROJECT_LABEL || (demo ? "demo-app" : "team workspace");
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">cowork</span>
        <span className="muted">{project}</span>
        <button
          type="button"
          className={`chip chip-button tone-${demo ? "amber" : connection.phase === "live" ? "green" : "neutral"}`}
          onClick={() => setSelection({ kind: "connection" })}
          title={connection.detail}
        >
          <span className="dot" />
          {phaseLabel[connection.phase]}
        </button>
        <button
          type="button"
          className={`chip chip-button tone-${health.tone}`}
          onClick={() => setSelection({ kind: "checks" })}
          title={health.detail}
        >
          {health.title}
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setSelection({ kind: "memory" })}
        >
          Memory{facts ? ` (${facts})` : ""}
        </button>
      </header>
      {demo && <DemoBar />}
      <NeedsYou actions={needsYou(tables)} select={setSelection} />
      <main className="layout">
        <section className="panel graph-panel" aria-label="Team graph">
          <Graph
            graph={teamGraph(tables, now)}
            hive={hiveStats(tables)}
            flights={flights}
            selection={selection}
            select={setSelection}
          />
        </section>
        <NowList tables={tables} selection={selection} select={setSelection} />
        <ActivityStrip events={activity(tables)} select={setSelection} />
      </main>
      {selection && (
        <Details
          selection={selection}
          tables={tables}
          connection={connection}
          select={setSelection}
          close={close}
        />
      )}
    </div>
  );
}
