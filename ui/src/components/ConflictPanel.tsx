/**
 * WHAT IT'S FOR: conflict selection, both source excerpts, the two agents' conversation, and the
 * states that need people: a test-change review, or both humans' decision on an escalated
 * conflict (branch feat/orchestrator: the agents settle conflicts themselves). Owner: D.
 */
import { useState } from "react";
import type { ConflictRow } from "../../../shared/src/schema.ts";
import { excerptFromDiff } from "../diff";
import { decideConflict, reviewTestChange, useRows } from "../stdb";
import { absoluteTime, relativeTime } from "../time";
import { useNow } from "../useNow";
import { Icon } from "./Icon";
const statusText: Record<ConflictRow["status"], string> = {
  open: "Agents talking it out",
  escalated: "Both humans decide",
  needs_human: "Human review required",
  resolved: "Resolved",
};
const kindText: Record<ConflictRow["kind"], string> = {
  self: "This snapshot fails on its own.",
  merge: "The snapshots contain overlapping edits that Git cannot merge.",
  pair: "Each snapshot passes alone; the combined changes fail.",
  potential: "The orchestrator expects these two agents' work to clash.",
};
function SourceExcerpt({
  agent,
  location,
}: {
  agent: string;
  location: string;
}) {
  const snapshots = useRows("snapshot");
  const latest = snapshots
    .filter((s) => s.agent === agent)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0];
  const lines = excerptFromDiff(latest?.diff ?? "", location);
  return (
    <div className="source-excerpt">
      <div className="source-title">
        <span className="avatar-mini">{agent.toUpperCase()}</span>
        <code>{location || "Location unavailable"}</code>
      </div>
      <pre
        tabIndex={0}
        aria-label={`Latest snapshot excerpt for agent ${agent}`}
        className="diff-code"
      >
        {lines.length ? (
          lines.map((line, i) => (
            <span className={`diff-line ${line.kind}`} key={i}>
              <span className="line-number">
                {line.newLine ?? line.oldLine}
              </span>
              <span className="diff-marker">
                {line.kind === "added"
                  ? "+"
                  : line.kind === "removed"
                    ? "−"
                    : " "}
              </span>
              <code>{line.text || " "}</code>
            </span>
          ))
        ) : (
          <span className="excerpt-empty">
            No matching lines in the latest snapshot diff.
          </span>
        )}
      </pre>
      <span className="source-caption">
        Latest snapshot · line numbers may shift after merging
      </span>
    </div>
  );
}
/** A person's answer to a fix that changed existing tests (Part C's review_test_change). Owner: A. */
function ReviewActions({ conflict }: { conflict: ConflictRow }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"" | "approve" | "reject">("");
  const [error, setError] = useState("");
  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "reject");
    setError("");
    try {
      await reviewTestChange(conflict.id, approve, comment.trim());
      setComment("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The database refused the review.",
      );
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="review-actions">
      <input
        className="review-comment"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder={`Note for ${conflict.fixer} (optional)`}
        maxLength={500}
        aria-label={`Note for ${conflict.fixer}`}
        disabled={busy !== ""}
      />
      <div className="review-buttons">
        <button
          type="button"
          className="button compact review-accept"
          disabled={busy !== ""}
          onClick={() => void decide(true)}
        >
          <Icon name="check" size={14} />
          {busy === "approve" ? "Accepting…" : "Accept test change"}
        </button>
        <button
          type="button"
          className="button compact review-reject"
          disabled={busy !== ""}
          onClick={() => void decide(false)}
        >
          <Icon name="arrow" size={14} />
          {busy === "reject" ? "Sending back…" : `Send back to ${conflict.fixer}`}
        </button>
      </div>
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
      <p className="review-hint">
        Accept keeps the changed tests and needs the combined check to be green.
        Send back wakes {conflict.fixer} to put the tests back and fix the code.
      </p>
    </div>
  );
}

/** Both humans' answer to a conflict their agents couldn't settle (Part C's decide_conflict). Owner: A. */
function DecisionBox({ conflict }: { conflict: ConflictRow }) {
  const [decision, setDecision] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pair = `${conflict.agentA.toUpperCase()} and ${conflict.agentB.toUpperCase()}`;
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await decideConflict(conflict.id, decision.trim());
      setDecision("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The database refused the decision.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="review-actions decision-box">
      <textarea
        className="review-comment"
        value={decision}
        onChange={(event) => setDecision(event.target.value)}
        placeholder={`What ${pair}'s humans decided, e.g. "Use milliseconds; B converts at the session store."`}
        maxLength={1000}
        rows={3}
        aria-label={`Decision for conflict ${conflict.id}`}
        disabled={busy}
      />
      <div className="review-buttons">
        <button type="button" className="button compact review-accept" disabled={busy || !decision.trim()} onClick={() => void send()}>
          <Icon name="check" size={14} />
          {busy ? "Sending…" : "Send decision to both agents"}
        </button>
      </div>
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
      <p className="review-hint">
        The decision reopens the conflict and wakes both agents. They implement it, run their checks, and agree.
      </p>
    </div>
  );
}

/** The two agents' conversation inside a conflict, oldest first. */
function Thread({ conflict }: { conflict: ConflictRow }) {
  const now = useNow();
  const messages = useRows("message")
    .filter((m) => m.conflictId === conflict.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const who = (author: string) =>
    author === "orchestrator" ? "Orchestrator" : author === "human" ? "Both humans" : `Agent ${author.toUpperCase()}`;
  const verb: Record<string, string> = { message: "", agree: "agrees", escalate: "asks the humans", decision: "decided" };
  return (
    <div className="thread" aria-label={`Conversation in conflict ${conflict.id}`}>
      <div className="thread-heading">
        <Icon name="activity" size={16} />
        <strong>
          {conflict.agentB ? `${conflict.agentA.toUpperCase()} and ${conflict.agentB.toUpperCase()} talk it out` : "Conversation"}
        </strong>
      </div>
      {messages.length === 0 ? (
        <p className="muted small">
          {conflict.status === "resolved" ? "No messages were exchanged." : `Agent ${conflict.fixer.toUpperCase()} was woken first and will open the conversation.`}
        </p>
      ) : (
        <ol className="thread-messages">
          {messages.map((m) => (
            <li key={m.id} className={`thread-${m.kind} thread-author-${m.author === "orchestrator" || m.author === "human" ? m.author : "agent"}`}>
              <div className="thread-meta">
                <span className="avatar-mini">{m.author === "orchestrator" ? "O" : m.author === "human" ? "H" : m.author.toUpperCase()}</span>
                <strong>{who(m.author)}</strong>
                {verb[m.kind] && <span className={`pill tone-${m.kind === "agree" ? "green" : m.kind === "decision" ? "violet" : "amber"}`}>{verb[m.kind]}</span>}
                <time title={absoluteTime(m.createdAt)}>{relativeTime(m.createdAt, now)}</time>
              </div>
              <p>{m.body}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function ConflictPanel({
  conflicts,
  selected,
  onSelect,
  showEvidence = true,
}: {
  conflicts: ConflictRow[];
  selected?: ConflictRow;
  onSelect: (id: number) => void;
  showEvidence?: boolean;
}) {
  const now = useNow();
  const inbox = useRows("inbox");
  const reviewNote =
    selected &&
    inbox
      .filter((note) => note.conflictId === selected.id && note.kind === "info")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  return (
    <section className="conflict-content" aria-labelledby="conflicts-title">
      <div className="section-heading">
        <h2 id="conflicts-title">
          <Icon name="branch" />
          Integration workspace
        </h2>
        <span className="eyebrow">UNCOMMITTED → VERIFIED</span>
      </div>
      {conflicts.length > 1 && (
        <div className="conflict-tabs" aria-label="Select a conflict">
          {conflicts.map((c) => (
            <button
              type="button"
              key={c.id}
              aria-pressed={selected?.id === c.id}
              onClick={() => onSelect(c.id)}
            >
              #{c.id} · {c.agentA.toUpperCase()}
              {c.agentB ? ` × ${c.agentB.toUpperCase()}` : ""}
              <span
                className={`dot tone-${c.status === "resolved" ? "green" : "red"}`}
              />
            </button>
          ))}
        </div>
      )}
      {!selected ? (
        <div className="workspace-empty">
          <span className="empty-orbit">
            <Icon name="branch" size={30} />
          </span>
          <h3>No conflicts to inspect</h3>
          <p>
            When an agent's check finds a clash, or the orchestrator expects
            one, the two agents' changes and their conversation appear here.
          </p>
        </div>
      ) : (
        <>
          <div className="conflict-title-row">
            <div>
              <p className="eyebrow">
                CONFLICT #{selected.id} · {selected.kind.toUpperCase()}
              </p>
              <h3>
                {selected.agentA.toUpperCase()}
                {selected.agentB ? ` × ${selected.agentB.toUpperCase()}` : ""}
                <span className="conflict-subtitle">
                  {selected.status === "resolved"
                    ? "Agreed and verified"
                    : selected.kind === "potential"
                      ? "Expected clash"
                      : selected.kind === "pair"
                        ? "Changes collide"
                        : selected.kind === "merge"
                          ? "Overlapping edits"
                          : "Snapshot failed"}
                </span>
              </h3>
            </div>
            <span
              className={`pill tone-${selected.status === "resolved" ? "green" : "red"}`}
            >
              <Icon
                name={selected.status === "resolved" ? "check" : "alert"}
                size={14}
              />
              {statusText[selected.status]}
            </span>
          </div>
          <p className="muted conflict-description">
            {selected.status === "resolved" ? "Original failure: " : ""}
            {kindText[selected.kind]}
          </p>
          {(selected.status === "needs_human" ||
            selected.status === "escalated") && (
            <div className="human-callout" role="status">
              <Icon name="alert" />
              <div>
                <strong>
                  {selected.status === "needs_human"
                    ? "A person must review the test changes"
                    : `${selected.agentA.toUpperCase()}'s and ${selected.agentB.toUpperCase()}'s humans decide`}
                </strong>
                <p>
                  {selected.status === "needs_human"
                    ? reviewNote?.message ||
                      "The proposed fix touched existing tests. Review those changes before accepting the result."
                    : "The agents couldn't settle this between them. Read their conversation below, decide together, and send the decision."}
                </p>
                {selected.status === "needs_human" && (
                  <ReviewActions key={selected.id} conflict={selected} />
                )}
                {selected.status === "escalated" && selected.agentB && (
                  <DecisionBox key={selected.id} conflict={selected} />
                )}
              </div>
            </div>
          )}
          {showEvidence && (
            <>
              <div className={`source-pair ${selected.agentB ? "" : "single"}`}>
                <SourceExcerpt
                  agent={selected.agentA}
                  location={selected.locA}
                />
                {selected.agentB && (
                  <SourceExcerpt
                    agent={selected.agentB}
                    location={selected.locB}
                  />
                )}
              </div>
              <details
                className="failure-output"
                open={selected.status !== "resolved"}
              >
                <summary>
                  <Icon name="code" size={15} />
                  Failing check output
                  <Icon name="chevron" size={13} />
                </summary>
                <pre tabIndex={0}>
                  {selected.error || "No output was recorded."}
                </pre>
              </details>
            </>
          )}
          <div className="fixer-row">
            <div>
              <span className="avatar-mini fixer-avatar">
                {selected.fixer.toUpperCase()}
              </span>
              <span>
                <strong>Agent {selected.fixer.toUpperCase()}</strong>
                <span className="small muted">
                  {selected.status === "resolved"
                    ? "Was suggested to adapt · both agreed"
                    : "Suggested to adapt · the agents decide"}
                </span>
              </span>
            </div>
            <time
              title={absoluteTime(
                selected.status === "resolved"
                  ? selected.resolvedAt
                  : selected.createdAt,
              )}
            >
              {relativeTime(
                selected.status === "resolved"
                  ? selected.resolvedAt
                  : selected.createdAt,
                now,
              )}
            </time>
          </div>
          <Thread conflict={selected} />
          {selected.explanation && (
            <div
              className={`explanation ${selected.status === "resolved" ? "resolved" : ""}`}
            >
              <Icon name={selected.status === "resolved" ? "check" : "sparkle"} />
              <div>
                <strong>
                  {selected.status === "resolved"
                    ? "Original diagnosis · now resolved"
                    : "Diagnosis"}
                </strong>
                <p>{selected.explanation}</p>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
