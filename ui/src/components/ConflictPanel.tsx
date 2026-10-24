/** WHAT IT'S FOR: conflict selection, both source excerpts, fixer assignment, and human-review state. Owner: D. */
import { useState } from "react";
import type { ConflictRow } from "../../../shared/src/schema.ts";
import { excerptFromDiff } from "../diff";
import { reviewTestChange, useRows } from "../stdb";
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
            When the watcher finds a failure, the affected changes and assigned
            fixer appear here.
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
                    ? "Changes verified"
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
                    : "This conflict needs a teammate’s attention"}
                </strong>
                <p>
                  {selected.status === "needs_human"
                    ? reviewNote?.message ||
                      "The proposed fix touched existing tests. Review those changes before accepting the result."
                    : "The conflict is still unresolved. Coordinate with the assigned fixer on the next step."}
                </p>
                {selected.status === "needs_human" && (
                  <ReviewActions key={selected.id} conflict={selected} />
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
                  {selected.error ||
                    "The watcher has not provided error output."}
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
                    ? "Verified fix"
                    : "Assigned fixer"}
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
              <p>
                {selected.explanation ||
                  (selected.status === "resolved"
                    ? "The combined check passed. No diagnosis was recorded for this conflict."
                    : "The watcher has assigned the fix. The explanation will appear as diagnosis progresses.")}
              </p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
