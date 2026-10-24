/**
 * WHAT IT'S FOR: a quiet symbolic overview with progressively disclosed inspector drawers.
 * Owner: D. User direction: connected agents feed a health indicator; details stay off the landing view.
 */
import { useState } from "react";
import { DemoControls } from "./components/DemoControls";
import { Icon } from "./components/Icon";
import { Overview, type Inspection } from "./components/Overview";
import { Inspector } from "./components/Inspector";
import { useDashboard } from "./stdb";

export function App() {
  const { connection } = useDashboard();
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [big, setBig] = useState(
    new URLSearchParams(location.search).has("big"),
  );
  const demo = connection.phase === "demo";
  const project =
    import.meta.env.VITE_PROJECT_LABEL ||
    (demo ? "demo-app" : "Team workspace");
  const status = demo
    ? "Simulated"
    : connection.phase === "live"
      ? "Live"
      : connection.phase === "unconfigured"
        ? "Not connected"
        : connection.phase === "error"
          ? "Connection error"
          : connection.phase === "syncing"
            ? "Syncing"
            : "Connecting";
  function toggleBig() {
    const next = !big;
    setBig(next);
    const url = new URL(location.href);
    next ? url.searchParams.set("big", "") : url.searchParams.delete("big");
    history.replaceState(null, "", url);
  }
  return (
    <div
      className={`app-shell overview-shell${big ? " big" : ""}${inspection ? " inspecting" : ""}`}
    >
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <header className="app-header">
        <a
          className="brand"
          href="#main"
          aria-label="Agent Cowork home"
          onClick={() => setInspection(null)}
        >
          <span className="brand-symbol">
            <Icon name="link" size={23} />
          </span>
          <span>
            cowork<span className="brand-sub">AGENT WORKSPACE</span>
          </span>
        </a>
        <div className="workspace-breadcrumb">
          <span className="muted">Workspace</span>
          <Icon name="chevron" size={12} />
          <strong>{project}</strong>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={`connection-pill ${demo ? "tone-violet" : connection.phase === "live" ? "tone-cyan" : "muted"}`}
            onClick={() => setInspection({ kind: "connection" })}
            aria-label={`Inspect connection: ${status}`}
            title={connection.detail}
          >
            <span className="dot" />
            {status}
          </button>
          <button
            type="button"
            className="button"
            onClick={toggleBig}
            aria-pressed={big}
            aria-label={
              big ? "Switch to standard view" : "Switch to big-screen view"
            }
          >
            <Icon name="expand" size={15} />
            <span>{big ? "Standard view" : "Big-screen view"}</span>
          </button>
        </div>
      </header>
      <div className="workspace-layout">
        <nav className="side-rail" aria-label="Workspace sections">
          <button
            type="button"
            aria-label="Team overview"
            title="Team overview"
            aria-pressed={!inspection}
            className={!inspection ? "rail-active" : ""}
            onClick={() => setInspection(null)}
          >
            <Icon name="grid" size={19} />
          </button>
          <button
            type="button"
            aria-label="Inspect integration"
            title="Integration"
            aria-pressed={inspection?.kind === "conflict"}
            onClick={() => setInspection({ kind: "conflict" })}
          >
            <Icon name="branch" size={20} />
          </button>
          <button
            type="button"
            aria-label="Inspect shared memory"
            title="Shared memory"
            aria-pressed={inspection?.kind === "memory"}
            onClick={() => setInspection({ kind: "memory" })}
          >
            <Icon name="memory" size={20} />
          </button>
          <button
            type="button"
            aria-label="Inspect activity"
            title="Activity"
            aria-pressed={inspection?.kind === "activity"}
            onClick={() => setInspection({ kind: "activity" })}
          >
            <Icon name="activity" size={20} />
          </button>
          <span className="rail-bottom">
            <Icon name="signal" size={19} />
          </span>
        </nav>
        <main id="main" className="workspace overview-workspace" tabIndex={-1}>
          {demo && <DemoControls />}
          <div className="overview-heading">
            <h1>Team overview</h1>
            <span>
              <Icon name="branch" size={14} />
              <code>main</code>
            </span>
          </div>
          <Overview inspect={setInspection} />
          <footer className="workspace-footer">
            <span>
              <span className="brand-dot" />
              Agent Cowork
            </span>
            <span>Inspect a symbol to explore its context</span>
            <span>
              {demo
                ? "SIMULATED DATA"
                : connection.phase === "live"
                  ? "CONNECTED"
                  : "OFFLINE"}
            </span>
          </footer>
        </main>
      </div>
      {inspection && (
        <Inspector
          target={inspection}
          close={() => setInspection(null)}
          inspect={setInspection}
        />
      )}
    </div>
  );
}
