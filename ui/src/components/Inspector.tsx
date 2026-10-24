/** WHAT IT'S FOR: nonmodal inspector, revealing summaries before code evidence. Owner: D. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isActiveConflict,
  latestCombinedCheck,
  sortConflicts,
  teamHealth,
} from "../dashboard";
import { connect, useDashboard } from "../stdb";
import { absoluteTime, relativeTime } from "../time";
import { useNow } from "../useNow";
import { AgentCard } from "./AgentCard";
import { ConflictPanel } from "./ConflictPanel";
import { DroidPanel } from "./DroidPanel";
import { MemoryPanel } from "./MemoryPanel";
import { Timeline } from "./Timeline";
import { Icon } from "./Icon";
import type { Inspection } from "./Overview";

export function Inspector({
  target,
  close,
  inspect,
  collapsed = false,
  collapse,
}: {
  target: Inspection;
  close: () => void;
  inspect: (target: Inspection) => void;
  collapsed?: boolean;
  collapse?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [exiting, setExiting] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const actions = useRef({ close, collapse });
  actions.current = { close, collapse };
  const requestDismiss = useCallback((minimize = false) => {
    if (exitTimer.current) return;
    const finish = () => {
      exitTimer.current = undefined;
      setExiting(false);
      if (minimize) actions.current.collapse?.();
      else actions.current.close();
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else {
      setExiting(true);
      exitTimer.current = setTimeout(finish, 160);
    }
  }, []);
  useEffect(() => {
    clearTimeout(exitTimer.current);
    exitTimer.current = undefined;
    setExiting(false);
    return () => clearTimeout(exitTimer.current);
  }, [target, collapsed]);
  const { connection } = useDashboard();
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const el = dialog.current;
    el?.show();
    return () => {
      el?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const el = dialog.current;
    if (collapsed) el?.close();
    else if (!el?.open) el?.show();
  }, [collapsed]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (!collapsed && event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        requestDismiss();
      }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [requestDismiss, collapsed]);
  const title =
    target.kind === "agent"
      ? `Agent ${target.name.toUpperCase()}`
      : target.kind === "conflict"
        ? "Integration"
        : target.kind === "memory"
          ? "Shared memory"
          : target.kind === "activity"
            ? "Team activity"
            : target.kind === "checks"
              ? "Combined checks"
              : "Connection";
  return (
    <dialog
      className={`inspector-drawer${exiting ? " inspector-exiting" : ""}`}
      ref={dialog}
      aria-labelledby="inspector-title"
    >
      <header className="inspector-header">
        <div>
          <span className="eyebrow">INSPECT</span>
          <h2 id="inspector-title">{title}</h2>
        </div>
        <div>
          {connection.phase === "demo" && (
            <span className="inspector-demo-label">SIMULATED DATA</span>
          )}
          {collapse && (
            <button
              type="button"
              className="drawer-close inspector-minimize"
              onClick={() => requestDismiss(true)}
              aria-label="Collapse inspector"
              title="Minimize, keeping these details"
            >
              <Icon name="chevron" size={18} />
            </button>
          )}
          <button
            type="button"
            className="drawer-close"
            ref={closeButton}
            onClick={() => requestDismiss()}
            aria-label="Close details"
            autoFocus
          >
            <Icon name="close" size={20} />
          </button>
        </div>
      </header>
      <div className="inspector-body">
        <InspectorContent
          key={JSON.stringify(target)}
          target={target}
          inspect={inspect}
        />
      </div>
      <footer className="inspector-footer">
        <span>Agent Cowork</span>
        <span>
          <kbd>Esc</kbd> to return to the map
        </span>
      </footer>
    </dialog>
  );
}

function InspectorContent({
  target,
  inspect,
}: {
  target: Inspection;
  inspect: (target: Inspection) => void;
}) {
  const { tables, connection } = useDashboard();
  const now = useNow();
  const [evidence, setEvidence] = useState(false);
  const evidenceTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (evidence) evidenceTab.current?.focus();
  }, [evidence]);
  const [selectedId, setSelectedId] = useState(
    target.kind === "conflict" ? target.id : undefined,
  );
  if (target.kind === "memory") return <MemoryPanel />;
  if (target.kind === "activity") return <Timeline />;
  if (target.kind === "agent") {
    const agent = tables.agent.find((a) => a.name === target.name);
    if (!agent)
      return (
        <p className="inspector-empty">
          This agent is no longer in the shared state.
        </p>
      );
    const snapshots = tables.snapshot
      .filter((s) => s.agent === agent.name)
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(0, 10);
    const related = sortConflicts(
      tables.conflict.filter(
        (c) => c.agentA === agent.name || c.agentB === agent.name,
      ),
    );
    return (
      <div className="agent-inspection">
        <AgentCard agent={agent} />
        <section className="inspector-section">
          <h3>Related conflicts</h3>
          {related.length ? (
            related.map((c) => (
              <button
                key={c.id}
                type="button"
                className="inspect-row"
                onClick={() => inspect({ kind: "conflict", id: c.id })}
              >
                <Icon
                  name={isActiveConflict(c) ? "alert" : "check"}
                  size={17}
                />
                <span>
                  Conflict #{c.id}
                  <small>
                    {c.status.replaceAll("_", " ")} · fixer{" "}
                    {c.fixer.toUpperCase()}
                  </small>
                </span>
                <Icon name="chevron" size={13} />
              </button>
            ))
          ) : (
            <p className="muted small">No conflicts recorded for this agent.</p>
          )}
        </section>
        <section className="inspector-section">
          <h3>Latest snapshots</h3>
          {snapshots.length ? (
            snapshots.map((s) => (
              <details className="snapshot-disclosure" key={s.id}>
                <summary>
                  <Icon name="branch" size={14} />
                  <code>{s.sha.slice(0, 10)}</code>
                  <span>{s.files.length} files</span>
                  <time title={absoluteTime(s.createdAt)}>
                    {relativeTime(s.createdAt, now)}
                  </time>
                </summary>
                <div>
                  <ul>
                    {s.files.map((file) => (
                      <li key={file}>
                        <code>{file}</code>
                      </li>
                    ))}
                  </ul>
                  <pre tabIndex={0}>
                    {s.diff || "No display diff was stored for this snapshot."}
                  </pre>
                </div>
              </details>
            ))
          ) : (
            <p className="muted small">No snapshots recorded yet.</p>
          )}
        </section>
      </div>
    );
  }
  if (target.kind === "conflict") {
    const conflicts = sortConflicts(tables.conflict);
    const selected = conflicts.find((c) => c.id === selectedId) ?? conflicts[0];
    return (
      <div className="conflict-inspection">
        <div className="inspector-tabs" aria-label="Detail level">
          <button
            type="button"
            aria-pressed={!evidence}
            onClick={() => setEvidence(false)}
          >
            Summary
          </button>
          <button
            type="button"
            aria-pressed={evidence}
            ref={evidenceTab}
            onClick={() => setEvidence(true)}
            disabled={!selected}
          >
            <Icon name="code" size={14} />
            Changes & diagnosis
          </button>
        </div>
        <div
          className={
            evidence
              ? "integration-workspace inspector-evidence"
              : "inspector-summary"
          }
        >
          <ConflictPanel
            conflicts={conflicts}
            selected={selected}
            onSelect={setSelectedId}
            showEvidence={evidence}
          />
          {evidence && <DroidPanel conflict={selected} />}
        </div>
        {!evidence && selected && (
          <button
            type="button"
            className="inspect-evidence-button"
            onClick={() => setEvidence(true)}
          >
            Inspect changes and failing output
            <Icon name="arrow" size={16} />
          </button>
        )}
      </div>
    );
  }
  if (target.kind === "checks") {
    const check = latestCombinedCheck(tables);
    const live = connection.phase === "live" || connection.phase === "demo";
    const overall = teamHealth(tables, connection);
    const newerWork = overall.tone === "amber" && check?.result === "green";
    return (
      <section className="inspector-section check-inspection">
        <h3>Latest combined result</h3>
        {!check ? (
          <div className="empty-message">
            <Icon name="clock" />
            <p>
              No check covering all contributing agents has been recorded yet.
            </p>
          </div>
        ) : (
          <>
            <div
              className={`check-summary tone-${!live ? "neutral" : newerWork ? "amber" : check.result === "green" ? "green" : "red"}`}
            >
              <Icon
                name={
                  !live
                    ? "link"
                    : newerWork
                      ? "clock"
                      : check.result === "green"
                        ? "check"
                        : "alert"
                }
                size={24}
              />
              <div>
                <strong>
                  {!live
                    ? "Cached result · connection unavailable"
                    : newerWork
                      ? "Previous check passed · newer work is pending"
                      : check.result === "green"
                        ? "Check passed"
                        : "Check failed"}
                </strong>
                <p>
                  {check.agents.map((a) => a.toUpperCase()).join(" + ")} ·{" "}
                  {relativeTime(check.createdAt, now)}
                </p>
              </div>
            </div>
            <details className="check-log-disclosure">
              <summary>View check output</summary>
              <pre tabIndex={0}>{check.log || "No output was recorded."}</pre>
            </details>
          </>
        )}
        {tables.conflict.length > 0 && (
          <button
            type="button"
            className="inspect-evidence-button"
            onClick={() => inspect({ kind: "conflict" })}
          >
            Inspect integration issues
            <Icon name="arrow" size={16} />
          </button>
        )}
      </section>
    );
  }
  return (
    <section className="inspector-section connection-inspection">
      <div className="connection-detail">
        <Icon name="link" size={26} />
        <h3>
          {connection.phase === "live" ? "Connected" : "Connection status"}
        </h3>
        <p>{connection.detail}</p>
      </div>
      <details className="check-log-disclosure">
        <summary>Connection setup</summary>
        <div>
          <p>
            On each dashboard laptop, sign in with SpacetimeDB's CLI and ask the
            database owner to approve your public identity for reader access.
          </p>
          <pre>
            spacetime login{"\n"}
            spacetime login show{"\n\n"}
            VITE_STDB_HOST=https://maincloud.spacetimedb.com{"\n"}
            VITE_STDB_DB=your-database
          </pre>
          <p>
            Set the VITE settings in the root .env and restart Vite. Open this
            laptop's localhost dashboard; its server reads your own CLI session.
            Never paste a token into .env or share the login show --token
            output.
          </p>
        </div>
      </details>
      <div className="connection-actions">
        <button type="button" className="button" onClick={() => connect()}>
          Retry connection
        </button>
        {connection.phase !== "demo" && (
          <a className="button" href="/?demo">
            Explore simulated demo
            <Icon name="arrow" size={13} />
          </a>
        )}
      </div>
    </section>
  );
}
