/**
 * WHAT IT'S FOR: the kickoff flow for a team with only a goal: a form, the orchestrator's live
 * status, its questions, and its proposal for a human to approve. Orkio never writes main: the
 * proposed cowork.owners.json is shown with a copy button for a person to commit. Without a live,
 * named, signed-in connection the form is read-only and says why.
 */
import { useState } from "react";
import type { ConnectionState, Tables } from "../dashboard";
import {
  answersJson,
  answersProblem,
  kickoffProblem,
  latestKickoff,
  membersJson,
  parseMembers,
  parseProposal,
  parseQuestions,
  sampleKickoffs,
  statusLabel,
  type KickoffMember,
  type KickoffRow,
} from "../kickoff";
import { myProfile } from "../members";
import { answerKickoff, decideKickoff, submitKickoff } from "../stdb";
import { useIdentity, useMembers } from "../useMembers";

function demoRequested(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").has("demo");
  } catch {
    return false;
  }
}

/** Kickoff rows from the database (newest first), or the samples in ?demo when there are none. */
export function kickoffRows(tables: Tables, demo = demoRequested()): { rows: KickoffRow[]; sample: boolean } {
  const real = [...(tables.kickoff ?? [])].sort((a, b) => b.id - a.id);
  if (demo && real.length === 0) return { rows: sampleKickoffs(Date.now()), sample: true };
  return { rows: real, sample: false };
}

function Notice({ status }: { status: { tone: "ok" | "error"; text: string } | null }) {
  return status ? (
    <p role="status" className={status.tone === "error" ? "ask-error" : "muted"}>
      {status.text}
    </p>
  ) : null;
}

/** Runs an async action with a busy flag and a one-line result. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    setStatus(null);
    try {
      await action();
      setStatus({ tone: "ok", text: done });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "That did not work." });
    } finally {
      setBusy(false);
    }
  }
  return { busy, status, run };
}

export function KickoffForm({ connection, sample = false }: { connection: ConnectionState; sample?: boolean }) {
  const profiles = useMembers();
  const me = myProfile(profiles, useIdentity());
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const [edited, setEdited] = useState<KickoffMember[] | null>(null);
  const team: KickoffMember[] = edited ?? profiles.map((p) => ({ handle: p.handle, displayName: p.displayName }));
  const { busy, status, run } = useAction();
  const live = connection.phase === "live" && !sample;
  const problem = kickoffProblem(goal, team);
  const edit = (index: number, patch: Partial<KickoffMember>) => setEdited(team.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  return (
    <form
      className="ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && live && me && !busy)
          void run(() => submitKickoff(goal.trim(), constraints.trim(), membersJson(team)), "Sent. The orchestrator is working on a proposal.");
      }}
    >
      {!live && (
        <p className="muted" role="status">
          Read-only: starting a kickoff needs a live connection from a signed-in account with the Editor role.
        </p>
      )}
      {live && !me && (
        <p className="ask-error" role="status">
          Your account has no name yet. Ask the database owner to approve you with --name &lt;your name&gt;, then reload.
        </p>
      )}
      <fieldset className="d-section" disabled={!live || !me || busy}>
        <legend className="eyebrow">Kickoff: we only have a goal</legend>
        <textarea aria-label="Goal" placeholder="Goal (required)" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
        <textarea aria-label="Constraints" placeholder="Stack, deadline, demo (optional)" rows={2} value={constraints} onChange={(e) => setConstraints(e.target.value)} />
        <p className="eyebrow">Team</p>
        {team.map((m, i) => (
          <div className="ask-role" key={`${m.handle}-${i}`}>
            <input aria-label="Handle" placeholder="Handle" value={m.handle} onChange={(e) => edit(i, { handle: e.target.value })} />
            <input aria-label="Name" placeholder="Name" value={m.displayName} onChange={(e) => edit(i, { displayName: e.target.value })} />
            <input aria-label="Strengths" placeholder="Strengths (optional)" value={m.strengths ?? ""} onChange={(e) => edit(i, { strengths: e.target.value })} />
          </div>
        ))}
        <button type="button" className="btn btn-ghost" onClick={() => setEdited([...team, { handle: "", displayName: "" }])}>
          + Add person
        </button>
        {me && <p className="muted">Starting as {me.displayName} ({me.handle})</p>}
        <button type="submit" className="btn btn-primary" disabled={!live || !me || busy || problem !== ""}>
          {busy ? "Sending…" : "Ask the orchestrator for a proposal"}
        </button>
        {problem && live && <p className="muted">{problem}</p>}
      </fieldset>
      <Notice status={status} />
    </form>
  );
}

function Questions({ row, live }: { row: KickoffRow; live: boolean }) {
  const questions = parseQuestions(row);
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const { busy, status, run } = useAction();
  const problem = answersProblem(questions, answers);
  return (
    <form
      className="ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && live && !busy) void run(() => answerKickoff(row.id, answersJson(questions, answers)), "Sent. The orchestrator is continuing.");
      }}
    >
      <fieldset className="d-section" disabled={!live || busy}>
        {questions.map((q, i) => (
          <label key={i} className="ask-question">
            <span>{q}</span>
            <textarea aria-label={q} rows={2} value={answers[i] ?? ""} onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))} />
          </label>
        ))}
        <button type="submit" className="btn btn-primary" disabled={!live || busy || problem !== ""}>
          {busy ? "Sending…" : "Send answers"}
        </button>
        {problem && live && <p className="muted">{problem}</p>}
      </fieldset>
      <Notice status={status} />
    </form>
  );
}

function Proposed({ row, live }: { row: KickoffRow; live: boolean }) {
  const proposal = parseProposal(row);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState("");
  const { busy, status, run } = useAction();
  async function copy() {
    try {
      await navigator.clipboard.writeText(row.ownersJson);
      setCopied("Copied.");
    } catch {
      setCopied("Could not copy; select the text and copy it by hand.");
    }
  }
  return (
    <>
      {proposal && (
        <>
          <section className="d-section">
            <h3>Who owns what</h3>
            <ul>
              {proposal.owners.map((o) => (
                <li key={o.agent}>
                  <strong>{o.human || o.agent}</strong> ({o.agent}): {o.feature}
                  {o.paths.length > 0 && <> · {o.paths.join(", ")}</>}
                </li>
              ))}
            </ul>
          </section>
          {proposal.contracts.length > 0 && (
            <section className="d-section">
              <h3>Shared contracts</h3>
              <ul>
                {proposal.contracts.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </section>
          )}
          <section className="d-section">
            <h3>First tasks</h3>
            <ul>
              {proposal.tasks.map((t, i) => (
                <li key={i}>
                  <strong>{t.agent}</strong>: {t.title}
                  {t.details && <> — {t.details}</>}
                </li>
              ))}
            </ul>
          </section>
          {proposal.notes && <p className="muted">{proposal.notes}</p>}
        </>
      )}
      {row.ownersJson && (
        <section className="d-section">
          <h3>cowork.owners.json</h3>
          <pre className="kickoff-json">{row.ownersJson}</pre>
          <button type="button" className="btn btn-ghost" onClick={() => void copy()}>
            Copy
          </button>
          {copied && <span className="muted"> {copied}</span>}
          <p className="muted">
            Orkio never writes to main. After you approve, commit this to cowork.owners.json on your team repo.
          </p>
        </section>
      )}
      {row.status === "proposed" && (
        <fieldset className="d-section" disabled={!live || busy}>
          <textarea aria-label="Note" placeholder="Note (what to change, if you send it back)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn btn-primary" onClick={() => void run(() => decideKickoff(row.id, true, note.trim()), "Approved.")}>
            Approve
          </button>{" "}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!note.trim()}
            onClick={() => void run(() => decideKickoff(row.id, false, note.trim()), "Sent back.")}
          >
            Send back
          </button>
          {!live && <p className="muted">Read-only: deciding needs a live, signed-in connection.</p>}
        </fieldset>
      )}
      <Notice status={status} />
    </>
  );
}

/** One kickoff: its goal, live status, and whatever it needs from a person next. */
export function KickoffCard({ row, connection, sample = false }: { row: KickoffRow; connection: ConnectionState; sample?: boolean }) {
  const live = connection.phase === "live" && !sample;
  const people = parseMembers(row);
  return (
    <section className="d-section kickoff-card" aria-label={`Kickoff #${row.id}`}>
      <p className="eyebrow">
        Kickoff #{row.id} · {statusLabel[row.status]}
      </p>
      <p>{row.goal}</p>
      {row.constraints && <p className="muted">Constraints: {row.constraints}</p>}
      {people.length > 0 && <p className="muted">Team: {people.map((m) => m.displayName || m.handle).join(", ")}</p>}
      {row.note && <p className="muted">Note: {row.note}</p>}
      {row.status === "needs_answers" && <Questions row={row} live={live} />}
      {(row.status === "proposed" || row.status === "approved" || row.status === "rejected") && <Proposed row={row} live={live} />}
    </section>
  );
}

/** The Kickoff section of the Orchestrator drawer: the newest kickoff, or a note that there is none. */
export function KickoffSection({ tables, connection }: { tables: Tables; connection: ConnectionState }) {
  const { rows, sample } = kickoffRows(tables);
  const latest = latestKickoff(rows);
  if (!latest) return null;
  return (
    <>
      {sample && <p className="muted">Sample kickoff (?demo).</p>}
      <KickoffCard row={latest} connection={connection} sample={sample} />
    </>
  );
}
