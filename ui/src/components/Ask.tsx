/**
 * WHAT IT'S FOR: "Ask the orchestrator": a text box for requests, plus a short first-time choice
 * (responsibilities already decided, or only a goal). Sending uses the signed-in dashboard
 * connection; with no such connection the form is read-only and says why.
 */
import { useState } from "react";
import { draftProblem, requestBody, type RoleRow, type Setup } from "../ask";
import type { ConnectionState, Tables } from "../dashboard";
import { myProfile } from "../members";
import { submitRequestAsMe } from "../stdb";
import { useIdentity, useMembers } from "../useMembers";
import { KickoffCard, KickoffForm, kickoffRows } from "./Kickoff";
import { latestKickoff } from "../kickoff";

const emptyRole = (): RoleRow => ({ person: "", feature: "", paths: "" });

export function AskView({ tables, connection }: { tables: Tables; connection: ConnectionState }) {
  const members = useMembers();
  const profile = myProfile(members, useIdentity());
  const [text, setText] = useState("");
  const [has, setHas] = useState<"" | "yes" | "no">("");
  const [roles, setRoles] = useState<RoleRow[]>([emptyRole()]);
  const { rows, sample } = kickoffRows(tables);
  const latest = latestKickoff(rows);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const live = connection.phase === "live";
  const named = !!profile;
  const setup: Setup = has === "yes" ? { mode: "roles", roles } : { mode: "none" };
  const draft = { text, setup };
  const problem = draftProblem(draft);

  async function send() {
    setBusy(true);
    setStatus(null);
    try {
      await submitRequestAsMe(requestBody(draft));
      setStatus({ tone: "ok", text: "Sent. The orchestrator's plan will appear under Orchestrator." });
      setText("");
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not send." });
    } finally {
      setBusy(false);
    }
  }
  const editRole = (index: number, patch: Partial<RoleRow>) =>
    setRoles(roles.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  if (has === "no") {
    return (
      <div className="ask">
        <fieldset className="d-section">
          <legend className="eyebrow">Do you already have responsibilities?</legend>
          <label>
            <input type="radio" name="has" checked={false} onChange={() => setHas("yes")} /> Yes, each person has a feature
          </label>
          <label>
            <input type="radio" name="has" checked onChange={() => setHas("no")} /> No, we only have a goal
          </label>
          <label>
            <input type="radio" name="has" checked={false} onChange={() => setHas("")} /> Skip: just a request
          </label>
        </fieldset>
        <KickoffForm connection={connection} />
        {latest && <KickoffCard row={latest} connection={connection} sample={sample} />}
      </div>
    );
  }

  return (
    <form
      className="ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && live && named && !busy) void send();
      }}
    >
      {!live && (
        <p className="muted" role="status">
          Read-only: sending needs a live connection from a signed-in account with the Editor role.
        </p>
      )}
      {live && !named && (
        <p className="ask-error" role="status">
          Your account has no name yet. Ask the database owner to approve you with --name &lt;your name&gt;
          (grant &lt;your identity&gt; editor --name &lt;your name&gt;), then reload.
        </p>
      )}
      <fieldset className="d-section" disabled={!live || !named || busy}>
        <legend className="eyebrow">Do you already have responsibilities?</legend>
        <label>
          <input type="radio" name="has" checked={has === "yes"} onChange={() => setHas("yes")} /> Yes, each person has a feature
        </label>
        <label>
          <input type="radio" name="has" checked={false} onChange={() => setHas("no")} /> No, we only have a goal
        </label>
        <label>
          <input type="radio" name="has" checked={has === ""} onChange={() => setHas("")} /> Skip: just a request
        </label>
        {has === "yes" && (
          <div className="ask-roles">
            {roles.map((r, i) => (
              <div className="ask-role" key={i}>
                <input aria-label="Person" placeholder="Person" value={r.person} onChange={(e) => editRole(i, { person: e.target.value })} />
                <input aria-label="Feature" placeholder="Feature" value={r.feature} onChange={(e) => editRole(i, { feature: e.target.value })} />
                <input aria-label="Paths" placeholder="Paths (optional)" value={r.paths} onChange={(e) => editRole(i, { paths: e.target.value })} />
              </div>
            ))}
            <button type="button" className="btn btn-ghost" onClick={() => setRoles([...roles, emptyRole()])}>
              + Add person
            </button>
          </div>
        )}
      </fieldset>
      <fieldset className="d-section" disabled={!live || !named || busy}>
        <label className="eyebrow" htmlFor="ask-text">
          {has ? "Anything else? (optional)" : "What do you want done?"}
        </label>
        <textarea id="ask-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        {profile && (
          <p className="muted">Asking as {profile.displayName} ({profile.handle})</p>
        )}
        <button type="submit" className="btn btn-primary" disabled={!live || !named || busy || problem !== ""}>
          {busy ? "Sending…" : "Send to the orchestrator"}
        </button>
        {problem && live && <p className="muted">{problem}</p>}
      </fieldset>
      {status && (
        <p role="status" className={status.tone === "error" ? "ask-error" : "muted"}>
          {status.text}
        </p>
      )}
    </form>
  );
}
