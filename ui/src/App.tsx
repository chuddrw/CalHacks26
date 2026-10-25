/**
 * WHAT IT'S FOR: a quiet symbolic overview with progressively disclosed inspector drawers.
 * Owner: D. User direction: connected agents feed a health indicator; details stay off the landing view.
 */
import { useEffect, useState } from "react";
import { DemoControls } from "./components/DemoControls";
import { Icon } from "./components/Icon";
import { Overview, type Inspection } from "./components/Overview";
import { Inspector } from "./components/Inspector";
import { useDashboard } from "./stdb";

export function App() {
  const { tables, connection } = useDashboard();
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [navExpanded, setNavExpanded] = useState(
    () => !matchMedia("(max-width: 760px)").matches,
  );
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  useEffect(() => {
    function dismiss(event: KeyboardEvent) {
      if (event.key === "Escape" && matchMedia("(max-width: 760px)").matches)
        setNavExpanded(false);
    }
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);
  function inspect(target: Inspection) {
    if (matchMedia("(max-width: 760px)").matches) setNavExpanded(false);
    setInspection(target);
    setInspectorCollapsed(false);
  }
  const [big, setBig] = useState(
    new URLSearchParams(location.search).has("big"),
  );
  const demo = connection.phase === "demo";
  const ready = connection.phase === "live" || demo;
  const presenceLabel = ready
    ? `${tables.agent.filter((agent) => agent.online).length} agents online`
    : tables.agent.length
      ? "Cached state �� connection unavailable"
      : "Awaiting connection";
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
      className={`app-shell overview-shell office-shell${big ? " big" : ""}${navExpanded ? " nav-expanded" : " nav-collapsed"}`}
    >
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <header className="app-header">
        <button
          type="button"
          className="button mobile-nav-toggle"
          aria-label="Toggle workspace navigation"
          aria-controls="workspace-navigation"
          aria-expanded={navExpanded}
          onClick={() => setNavExpanded((value) => !value)}
        >
          <Icon name="sidebar" size={20} />
        </button>
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
        <div className="header-context">
          <div className="header-context-title">
            <h1>Team overview</h1>
            <span className="header-project">{project}</span>
            <span className="header-branch">
              <Icon name="branch" size={13} />
              <code>main</code>
            </span>
          </div>
          <div className="header-context-status">
            <span>{presenceLabel}</span>
            <span>
              {demo ? "Simulated workspace" : "Shared integration state"}
            </span>
          </div>
        </div>
        <div className="header-actions">
          {!demo && (
            <a
              className="button simulation-link"
              href={big ? "/?demo&big" : "/?demo"}
            >
              <Icon name="play" size={15} />
              <span>Demo simulation</span>
            </a>
          )}
          <button
            type="button"
            className={`connection-pill ${demo ? "tone-violet" : connection.phase === "live" ? "tone-cyan" : "muted"}`}
            onClick={() => inspect({ kind: "connection" })}
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
        <nav
          id="workspace-navigation"
          className="side-rail"
          aria-label="Workspace sections"
        >
          <button
            type="button"
            className="nav-toggle"
            aria-label={
              navExpanded ? "Collapse navigation" : "Expand navigation"
            }
            aria-expanded={navExpanded}
            onClick={() => setNavExpanded((value) => !value)}
          >
            <Icon name="sidebar" size={20} />
            <span className="nav-label">Workspace</span>
            <Icon name="chevron" size={13} />
          </button>
          <button
            type="button"
            aria-label="Team overview"
            title="Team overview"
            aria-pressed={!inspection}
            className={!inspection ? "rail-active" : ""}
            onClick={() => {
              setInspection(null);
              if (matchMedia("(max-width: 760px)").matches)
                setNavExpanded(false);
            }}
          >
            <Icon name="grid" size={19} />
            <span className="nav-label">Team</span>
          </button>
          <button
            type="button"
            aria-label="Inspect the orchestrator's requests and reviews"
            title="Orchestrator"
            aria-pressed={inspection?.kind === "orchestrator"}
            onClick={() => inspect({ kind: "orchestrator" })}
          >
            <Icon name="sparkle" size={20} />
            <span className="nav-label">Orchestrator</span>
          </button>
          <button
            type="button"
            aria-label="Inspect integration"
            title="Integration"
            aria-pressed={inspection?.kind === "conflict"}
            onClick={() => inspect({ kind: "conflict" })}
          >
            <Icon name="branch" size={20} />
            <span className="nav-label">Integration</span>
          </button>
          <button
            type="button"
            aria-label="Inspect checks"
            title="Checks"
            aria-pressed={inspection?.kind === "checks"}
            onClick={() => inspect({ kind: "checks" })}
          >
            <Icon name="check" size={20} />
            <span className="nav-label">Checks</span>
          </button>
          <button
            type="button"
            aria-label="Inspect shared memory"
            title="Shared memory"
            aria-pressed={inspection?.kind === "memory"}
            onClick={() => inspect({ kind: "memory" })}
          >
            <Icon name="memory" size={20} />
            <span className="nav-label">Memory</span>
          </button>
          <button
            type="button"
            aria-label="Inspect activity"
            title="Activity"
            aria-pressed={inspection?.kind === "activity"}
            onClick={() => inspect({ kind: "activity" })}
          >
            <Icon name="activity" size={20} />
            <span className="nav-label">Activity</span>
          </button>
        </nav>
        <main id="main" className="workspace overview-workspace" tabIndex={-1}>
          {demo && <DemoControls />}
          <Overview inspect={inspect} />
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
          inspect={inspect}
          collapsed={inspectorCollapsed}
          collapse={() => setInspectorCollapsed(true)}
        />
      )}
      {inspection && inspectorCollapsed && (
        <button
          type="button"
          className="inspector-restore"
          onClick={() => setInspectorCollapsed(false)}
          aria-label="Expand inspector"
        >
          <Icon name="sidebar" size={19} />
          <span>
            Open{" "}
            {inspection.kind === "conflict" ? "integration" : inspection.kind}{" "}
            inspector
          </span>
          <Icon name="chevron" size={15} />
        </button>
      )}
    </div>
  );
}
