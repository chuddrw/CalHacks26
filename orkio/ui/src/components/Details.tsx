/**
 * WHAT IT'S FOR: the drawer on the right that opens when you click a node, edge, row or event.
 * One view per selection kind: agent, request (the orchestrator's plan, reviews, tasks, Droid's
 * steps), conflict (thread, human actions, code and failing output), checks, memory, activity,
 * connection. Not modal: the graph stays live and clickable beside it. Esc closes it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ConflictRow, RequestRow } from "../../../shared/src/schema.ts";
import {
  latestCombinedCheck,
  sortConflicts,
  teamHealth,
  type ConnectionState,
  type Tables,
} from "../dashboard";
import { excerptFromDiff } from "../diff";
import { connect } from "../stdb";
import {
  activity,
  agentNow,
  conflictStatusLabel,
  requestStatusLabel,
  requestTone,
  taskStatusLabel,
  threadState,
  upper,
  type Selection,
} from "../team";
import { absoluteTime, relativeTime } from "../time";
import { useNow } from "../useNow";
import { ActivityList } from "./Activity";
import { DecisionBox, ReviewActions, TestChangeActions } from "./Actions";

const titles: Record<Selection["kind"], string> = {
  agent: "Agent",
  request: "Orchestrator",
  conflict: "Conflict",
  checks: "Checks",
  memory: "Shared memory",
  activity: "Activity",
  connection: "Connection",
};

export function Details({
  selection,
  tables,
  connection,
  select,
  close,
}: {
  selection: Selection;
  tables: Tables;
  connection: ConnectionState;
  select: (s: Selection) => void;
  close: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    closeButton.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);
  const title =
    selection.kind === "agent"
      ? `Agent ${upper(selection.name)}`
      : titles[selection.kind];
  return (
    <aside className="details" aria-labelledby="details-title">
      <header>
        <h2 id="details-title">{title}</h2>
        {connection.phase === "demo" && <span className="chip">simulated</span>}
        <button
          type="button"
          className="btn btn-ghost"
          ref={closeButton}
          onClick={close}
          aria-label="Close details"
        >
          ✕
        </button>
      </header>
      <div className="details-body">
        <Body
          key={JSON.stringify(selection)}
          selection={selection}
          tables={tables}
          connection={connection}
          select={select}
        />
      </div>
    </aside>
  );
}

function Body({
  selection,
  tables,
  connection,
  select,
}: {
  selection: Selection;
  tables: Tables;
  connection: ConnectionState;
  select: (s: Selection) => void;
}) {
  switch (selection.kind) {
    case "agent":
      return <AgentView name={selection.name} t={tables} select={select} />;
    case "request":
      return <RequestView id={selection.id} t={tables} select={select} />;
    case "conflict":
      return <ConflictView id={selection.id} t={tables} select={select} />;
    case "checks":
      return <ChecksView t={tables} connection={connection} />;
    case "memory":
      return <MemoryView t={tables} />;
    case "activity":
      return <ActivityList events={activity(tables)} select={select} />;
    case "connection":
      return <ConnectionView connection={connection} />;
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="d-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function When({ at }: { at: number }) {
  const now = useNow();
  return <time title={absoluteTime(at)}>{relativeTime(at, now)}</time>;
}

function Files({ files }: { files: string[] }) {
  return files.length ? (
    <span className="files">
      {files.map((f) => (
        <code key={f}>{f}</code>
      ))}
    </span>
  ) : null;
}

function Picker<T extends { id: number }>({
  rows,
  selected,
  label,
  onPick,
}: {
  rows: T[];
  selected: T;
  label: (row: T) => string;
  onPick: (row: T) => void;
}) {
  if (rows.length < 2) return null;
  return (
    <div className="picker">
      {rows.map((r) => (
        <button
          type="button"
          key={r.id}
          aria-pressed={r.id === selected.id}
          onClick={() => onPick(r)}
        >
          {label(r)}
        </button>
      ))}
    </div>
  );
}

// ---- Agent -----------------------------------------------------------------------------------

function AgentView({
  name,
  t,
  select,
}: {
  name: string;
  t: Tables;
  select: (s: Selection) => void;
}) {
  const agent = t.agent.find((a) => a.name === name);
  if (!agent) return <p className="muted">This agent is no longer in the shared state.</p>;
  const n = agentNow(t, agent);
  const tasks = t.task
    .filter((x) => x.agent === name)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
  const conflicts = sortConflicts(
    t.conflict.filter((c) => c.agentA === name || c.agentB === name),
  );
  const snapshots = t.snapshot
    .filter((s) => s.agent === name)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
    .slice(0, 5);
  return (
    <>
      <div className="d-lead">
        <span className={`chip tone-${n.stateTone}`}>{n.state}</span>
        <p className="d-doing">{n.doing}</p>
        {agent.intent && n.source === "task" && (
          <p className="muted small">Its own plan: {agent.intent}</p>
        )}
        <Files files={agent.files} />
      </div>
      <Section title="Tasks from the orchestrator">
        {tasks.length === 0 ? (
          <p className="muted small">None.</p>
        ) : (
          <ul className="rows">
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="row"
                  onClick={() => select({ kind: "request", id: task.requestId })}
                >
                  <span className="row-main">
                    #{task.id} {task.title}
                    {task.note && <span className="muted small"> · {task.note}</span>}
                  </span>
                  <span className={`chip tone-${task.status === "assigned" ? "accent" : task.status === "done" ? "green" : "neutral"}`}>
                    {taskStatusLabel[task.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Conflicts">
        {conflicts.length === 0 ? (
          <p className="muted small">None.</p>
        ) : (
          <ul className="rows">
            {conflicts.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="row"
                  onClick={() => select({ kind: "conflict", id: c.id })}
                >
                  <span className="row-main">
                    #{c.id} with{" "}
                    {upper((c.agentA === name ? c.agentB : c.agentA) || "nobody")}
                    <span className="muted small"> · {threadState(t, c)}</span>
                  </span>
                  <span className={`chip tone-${c.status === "resolved" ? "green" : "red"}`}>
                    {conflictStatusLabel[c.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Latest snapshots">
        {snapshots.length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          snapshots.map((s) => (
            <details key={s.id} className="disclosure">
              <summary>
                <code>{s.sha.slice(0, 10)}</code> · {s.files.length} file
                {s.files.length === 1 ? "" : "s"} · <When at={s.createdAt} />
              </summary>
              <Files files={s.files} />
              <pre>{s.diff || "No diff was stored for this snapshot."}</pre>
            </details>
          ))
        )}
      </Section>
    </>
  );
}

// ---- Request (the orchestrator) --------------------------------------------------------------

function RequestView({
  id,
  t,
  select,
}: {
  id?: number;
  t: Tables;
  select: (s: Selection) => void;
}) {
  const requests = [...t.request].sort((a, b) => b.id - a.id);
  const selected = requests.find((r) => r.id === id) ?? requests[0];
  if (!selected)
    return (
      <>
        <FullStack t={t} />
        <p className="muted">
          No requests yet. A human tells their own agent what they want; the
          agent forwards it with ask_orchestrator. Droid plans it and assigns
          each part to the agent that owns that feature.
        </p>
      </>
    );
  const reviews = t.review
    .filter((r) => r.requestId === selected.id)
    .sort((a, b) => a.id - b.id);
  const tasks = t.task
    .filter((x) => x.requestId === selected.id)
    .sort((a, b) => a.id - b.id);
  return (
    <>
      <Picker
        rows={requests}
        selected={selected}
        label={(r: RequestRow) => `#${r.id} · ${upper(r.agent)}`}
        onPick={(r) => select({ kind: "request", id: r.id })}
      />
      <div className="d-lead">
        <p className="eyebrow">
          Request #{selected.id} · from {upper(selected.agent)}'s human ·{" "}
          <When at={selected.createdAt} />
        </p>
        <p className="d-quote">“{selected.body}”</p>
        <span className={`chip tone-${requestTone[selected.status]}`}>
          {requestStatusLabel[selected.status]}
        </span>
      </div>
      {selected.summary && (
        <Section title={selected.status === "failed" ? "Why planning failed" : "The plan"}>
          <p>{selected.summary}</p>
        </Section>
      )}
      {reviews.length > 0 && (
        <Section title="Reviews by the humans whose features change">
          <ul className="cards">
            {reviews.map((r) => (
              <li key={r.id} className={r.status === "pending" ? "card attention" : "card"}>
                <p>
                  <strong>{upper(r.reviewer)}'s human</strong>{" "}
                  <span className={`chip tone-${r.status === "pending" ? "amber" : r.status === "approved" ? "green" : r.status === "rejected" ? "red" : "neutral"}`}>
                    {r.status === "pending" ? "review needed" : r.status}
                  </span>
                </p>
                <p>{r.summary}</p>
                {r.answer && <p className="muted small">Note: {r.answer}</p>}
                {r.status === "pending" && <ReviewActions key={r.id} review={r} />}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Tasks">
        {tasks.length === 0 ? (
          <p className="muted small">
            {selected.status === "planning" || selected.status === "new"
              ? "Droid hasn't assigned anything yet."
              : "No tasks."}
          </p>
        ) : (
          <ul className="cards">
            {tasks.map((task) => (
              <li key={task.id} className="card">
                <p>
                  <button
                    type="button"
                    className="link"
                    onClick={() => select({ kind: "agent", name: task.agent })}
                  >
                    {upper(task.agent)}
                  </button>{" "}
                  <strong>
                    #{task.id} {task.title}
                  </strong>{" "}
                  {task.major && <span className="chip tone-amber">major</span>}{" "}
                  <span className={`chip tone-${task.status === "assigned" ? "accent" : task.status === "done" ? "green" : "neutral"}`}>
                    {taskStatusLabel[task.status]}
                  </span>
                </p>
                {task.details && <p className="small">{task.details}</p>}
                <Files files={task.files} />
                {task.note && <p className="small">Result: {task.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <PlanSteps request={selected} t={t} />
      <FullStack t={t} />
    </>
  );
}

function PlanSteps({ request, t }: { request: RequestRow; t: Tables }) {
  const steps = t.plan_step
    .filter((s) => s.requestId === request.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const live = request.status === "planning" || request.status === "new";
  const feed = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [steps.length]);
  return (
    <details className="disclosure" open={live}>
      <summary>
        Droid's steps ({steps.length}){live && <span className="chip tone-accent">live</span>}
      </summary>
      {steps.length === 0 ? (
        <p className="muted small">No steps yet.</p>
      ) : (
        <ol className="steps" ref={feed}>
          {steps.map((s) => (
            <li key={s.id} className={`step step-${s.kind}`}>
              <span className="step-kind">{s.kind.replaceAll("_", " ")}</span>
              <code>{s.detail}</code>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function FullStack({ t }: { t: Tables }) {
  const builds = [...t.build].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const green = builds.find((b) => b.result === "green");
  const red = builds[0]?.result === "red" ? builds[0] : undefined;
  return (
    <Section title="Full stack (the team's working main)">
      {green ? (
        <>
          <p>
            <span className="chip tone-green">checks pass</span>{" "}
            <code>
              {green.branch} @ {green.sha.slice(0, 8)}
            </code>{" "}
            · {green.agents.length ? `main + ${green.agents.map(upper).join(", ")}` : "main only"} ·{" "}
            <When at={green.createdAt} />
          </p>
          <p className="muted small">
            Run it on any laptop: ask your agent for get_full_stack, or{" "}
            <code>npm run full-stack -- --demo &lt;clone&gt;</code>. It lands in{" "}
            <code>&lt;clone&gt;-full-stack</code>; your own work isn't touched.
          </p>
        </>
      ) : (
        <p className="muted small">
          No full stack yet. The orchestrator pushes cowork/full-stack once
          everyone's work passes the checks together.
        </p>
      )}
      {red && (
        <p className="small">
          <span className="chip tone-red">red</span> Latest build: {red.log.split("\n")[0]}
        </p>
      )}
    </Section>
  );
}

// ---- Conflict --------------------------------------------------------------------------------

const kindText: Record<ConflictRow["kind"], string> = {
  self: "This snapshot fails on its own.",
  merge: "The snapshots contain overlapping edits that Git cannot merge.",
  pair: "Each snapshot passes alone; the combined changes fail.",
  potential: "The orchestrator expects these two agents' work to clash.",
};

function ConflictView({
  id,
  t,
  select,
}: {
  id?: number;
  t: Tables;
  select: (s: Selection) => void;
}) {
  const conflicts = sortConflicts(t.conflict);
  const c = conflicts.find((x) => x.id === id) ?? conflicts[0];
  if (!c)
    return (
      <p className="muted">
        No conflicts. When an agent's check finds a clash, or the orchestrator
        expects one, the two agents' changes and their conversation appear here.
      </p>
    );
  const messages = t.message
    .filter((m) => m.conflictId === c.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const note = t.inbox
    .filter((n) => n.conflictId === c.id && n.kind === "info")
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const steps = t.diagnosis_step
    .filter((s) => s.conflictId === c.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const author = (a: string) =>
    a === "orchestrator" ? "Orchestrator" : a === "human" ? "Both humans" : upper(a);
  return (
    <>
      <Picker
        rows={conflicts}
        selected={c}
        label={(x: ConflictRow) =>
          `#${x.id} · ${upper(x.agentA)}${x.agentB ? ` × ${upper(x.agentB)}` : ""}`
        }
        onPick={(x) => select({ kind: "conflict", id: x.id })}
      />
      <div className="d-lead">
        <p className="eyebrow">
          Conflict #{c.id} · {c.kind} · <When at={c.status === "resolved" ? c.resolvedAt : c.createdAt} />
        </p>
        <p className="d-quote">
          {upper(c.agentA)}
          {c.agentB ? ` × ${upper(c.agentB)}` : ""}
        </p>
        <span className={`chip tone-${c.status === "resolved" ? "green" : c.status === "needs_human" ? "amber" : "red"}`}>
          {conflictStatusLabel[c.status]}
        </span>{" "}
        <span className="muted small">{kindText[c.kind]} Suggested to adapt: {upper(c.fixer)}.</span>
      </div>
      {c.status === "escalated" && c.agentB && (
        <div className="card attention">
          <p>
            <strong>
              {upper(c.agentA)}'s and {upper(c.agentB)}'s humans decide.
            </strong>{" "}
            The agents couldn't settle it. Read the thread, decide together, send the decision.
          </p>
          <DecisionBox key={c.id} conflict={c} />
        </div>
      )}
      {c.status === "needs_human" && (
        <div className="card attention">
          <p>
            <strong>A person must review the test changes.</strong>{" "}
            {note?.message ||
              "The proposed fix touched existing tests. Review those changes before accepting the result."}
          </p>
          <TestChangeActions key={c.id} conflict={c} />
        </div>
      )}
      <Section title={c.agentB ? `Thread: ${upper(c.agentA)} and ${upper(c.agentB)}` : "Thread"}>
        {messages.length === 0 ? (
          <p className="muted small">
            {c.status === "resolved"
              ? "No messages were exchanged."
              : `Agent ${upper(c.fixer)} was woken first and will open the conversation.`}
          </p>
        ) : (
          <ol className="thread">
            {messages.map((m) => (
              <li key={m.id} className={`msg msg-${m.kind}`}>
                <p className="msg-meta">
                  <strong>{author(m.author)}</strong>
                  {m.kind !== "message" && (
                    <span className={`chip tone-${m.kind === "agree" ? "green" : m.kind === "decision" ? "accent" : "red"}`}>
                      {m.kind === "agree" ? "agrees" : m.kind === "escalate" ? "asks the humans" : "decided"}
                    </span>
                  )}
                  <When at={m.createdAt} />
                </p>
                <p>{m.body}</p>
              </li>
            ))}
          </ol>
        )}
      </Section>
      {c.explanation && (
        <Section title={c.status === "resolved" ? "Diagnosis (resolved)" : "Diagnosis"}>
          <p>{c.explanation}</p>
        </Section>
      )}
      <details className="disclosure">
        <summary>Code and failing output</summary>
        <Excerpt t={t} agent={c.agentA} location={c.locA} />
        {c.agentB && <Excerpt t={t} agent={c.agentB} location={c.locB} />}
        <p className="eyebrow">Failing check output</p>
        <pre>{c.error || "No output was recorded."}</pre>
      </details>
      {steps.length > 0 && (
        <details className="disclosure">
          <summary>Droid's diagnosis steps ({steps.length})</summary>
          <ol className="steps">
            {steps.map((s) => (
              <li key={s.id} className={`step step-${s.kind}`}>
                <span className="step-kind">{s.kind.replaceAll("_", " ")}</span>
                <code>{s.detail}</code>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

function Excerpt({ t, agent, location }: { t: Tables; agent: string; location: string }) {
  const latest = t.snapshot
    .filter((s) => s.agent === agent)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0];
  const lines = excerptFromDiff(latest?.diff ?? "", location);
  return (
    <div className="excerpt">
      <p className="eyebrow">
        {upper(agent)} · <code>{location || "location unavailable"}</code> · latest snapshot, lines may shift after merging
      </p>
      <pre>
        {lines.length
          ? lines.map((line, i) => (
              <span key={i} className={`diff diff-${line.kind}`}>
                {String(line.newLine ?? line.oldLine).padStart(4)}{" "}
                {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} {line.text}
                {"\n"}
              </span>
            ))
          : "No matching lines in the latest snapshot diff."}
      </pre>
    </div>
  );
}

// ---- Checks, memory, connection --------------------------------------------------------------

function ChecksView({ t, connection }: { t: Tables; connection: ConnectionState }) {
  const check = latestCombinedCheck(t);
  const health = teamHealth(t, connection);
  return (
    <>
      <div className="d-lead">
        <span className={`chip tone-${health.tone}`}>{health.title}</span>
        <p className="muted small">{health.detail}</p>
      </div>
      <Section title="Latest combined check">
        {!check ? (
          <p className="muted small">No check covering all contributing agents yet.</p>
        ) : (
          <>
            <p>
              <span className={`chip tone-${check.result === "green" ? "green" : "red"}`}>
                {check.result === "green" ? "passed" : "failed"}
              </span>{" "}
              {check.agents.map(upper).join(" + ")} · <When at={check.createdAt} />
            </p>
            <pre>{check.log || "No output was recorded."}</pre>
          </>
        )}
      </Section>
      <FullStack t={t} />
    </>
  );
}

function MemoryView({ t }: { t: Tables }) {
  const facts = t.intent
    .filter((i) => i.verified)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const plans = t.intent
    .filter((i) => !i.verified)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  return (
    <>
      <Section title={`Verified facts (${facts.length})`}>
        {facts.length === 0 ? (
          <p className="muted small">
            A fact is added when a conflict is resolved with a passing check.
          </p>
        ) : (
          <ul className="cards">
            {facts.map((f) => (
              <li key={f.id} className="card">
                <p>{f.summary}</p>
                <p className="muted small">
                  {f.symbols.map((s) => (
                    <code key={s}>{s} </code>
                  ))}
                  <When at={f.createdAt} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="What each agent said it would do">
        {plans.length === 0 ? (
          <p className="muted small">No plans shared yet.</p>
        ) : (
          <ul className="rows">
            {plans.map((p) => (
              <li key={p.id} className="row static">
                <span className="row-main">
                  <strong>{upper(p.agent)}</strong> {p.summary}
                </span>
                <span className="muted small">
                  <When at={p.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function ConnectionView({ connection }: { connection: ConnectionState }) {
  return (
    <>
      <div className="d-lead">
        <p>{connection.detail}</p>
      </div>
      <Section title="Setup">
        <p className="small">
          On each dashboard laptop, sign in with SpacetimeDB's CLI and ask the
          database owner to approve your public identity for reader access.
        </p>
        <pre>
          spacetime login{"\n"}spacetime login show{"\n\n"}VITE_STDB_HOST=https://maincloud.spacetimedb.com
          {"\n"}VITE_STDB_DB=your-database
        </pre>
        <p className="small">
          Put the VITE settings in the root .env and restart Vite. This laptop's
          dev server signs the page in with your own CLI session. Never paste a
          token into .env or share the output of <code>login show --token</code>.
        </p>
      </Section>
      <div className="action-buttons">
        <button type="button" className="btn" onClick={() => connect()}>
          Retry connection
        </button>
        {connection.phase !== "demo" && (
          <a className="btn" href="/?demo">
            Open the simulated demo
          </a>
        )}
      </div>
    </>
  );
}
