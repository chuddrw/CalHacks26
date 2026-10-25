/**
 * WHAT IT'S FOR: the only three things a person does on the dashboard, each a reducer in Part C's
 * module (stdb.ts):
 *   - approve or send back a review the orchestrator asked for (decide_review)
 *   - both humans' decision on an escalated conflict (decide_conflict)
 *   - accept or send back a fix that changed existing tests (review_test_change)
 */
import { useState } from "react";
import type { ConflictRow, ReviewRow } from "../../../shared/src/schema.ts";
import { decideConflict, decideReview, reviewTestChange } from "../stdb";
import { upper } from "../team";

function useSubmit() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const run = async (which: string, call: () => Promise<void>) => {
    setBusy(which);
    setError("");
    try {
      await call();
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "The database refused it.",
      );
      return false;
    } finally {
      setBusy("");
    }
  };
  return { busy, error, run };
}

function ErrorLine({ error }: { error: string }) {
  return error ? (
    <p className="action-error" role="alert">
      {error}
    </p>
  ) : null;
}

export function ReviewActions({ review }: { review: ReviewRow }) {
  const [answer, setAnswer] = useState("");
  const { busy, error, run } = useSubmit();
  const who = upper(review.reviewer);
  const decide = (approve: boolean) =>
    void run(approve ? "approve" : "reject", () =>
      decideReview(review.id, approve, answer.trim()),
    ).then((ok) => ok && setAnswer(""));
  return (
    <div className="actions">
      <input
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder={`${who}'s note (optional; say why when sending back)`}
        maxLength={500}
        aria-label={`${who}'s note on review ${review.id}`}
        disabled={busy !== ""}
      />
      <div className="action-buttons">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== ""}
          onClick={() => decide(true)}
        >
          {busy === "approve" ? "Approving…" : `Approve as ${who}`}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== ""}
          onClick={() => decide(false)}
        >
          {busy === "reject" ? "Sending back…" : "Send back"}
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

export function DecisionBox({ conflict }: { conflict: ConflictRow }) {
  const [decision, setDecision] = useState("");
  const { busy, error, run } = useSubmit();
  const solo = !conflict.agentB;
  const pair = solo
    ? upper(conflict.agentA)
    : `${upper(conflict.agentA)} and ${upper(conflict.agentB)}`;
  return (
    <div className="actions">
      <textarea
        value={decision}
        onChange={(e) => setDecision(e.target.value)}
        placeholder={
          solo
            ? `What ${pair}'s human decided, e.g. "Keep the old field name; update the caller instead."`
            : `What ${pair}'s humans decided, e.g. "Use milliseconds; B converts at the session store."`
        }
        maxLength={1000}
        rows={3}
        aria-label={`Decision for conflict ${conflict.id}`}
        disabled={busy !== ""}
      />
      <div className="action-buttons">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== "" || !decision.trim()}
          onClick={() =>
            void run("send", () =>
              decideConflict(conflict.id, decision.trim()),
            ).then((ok) => ok && setDecision(""))
          }
        >
          {busy
            ? "Sending…"
            : solo
              ? `Send decision to ${pair}`
              : "Send decision to both agents"}
        </button>
      </div>
      <ErrorLine error={error} />
      <p className="muted small">
        {solo
          ? `The decision reopens the conflict and wakes ${pair}. It implements it and runs the check.`
          : "The decision reopens the conflict and wakes both agents. They implement it, run their checks, and agree."}
      </p>
    </div>
  );
}

export function TestChangeActions({ conflict }: { conflict: ConflictRow }) {
  const [comment, setComment] = useState("");
  const { busy, error, run } = useSubmit();
  const fixer = upper(conflict.fixer);
  const decide = (approve: boolean) =>
    void run(approve ? "approve" : "reject", () =>
      reviewTestChange(conflict.id, approve, comment.trim()),
    ).then((ok) => ok && setComment(""));
  return (
    <div className="actions">
      <input
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={`Note for ${fixer} (optional)`}
        maxLength={500}
        aria-label={`Note for ${fixer}`}
        disabled={busy !== ""}
      />
      <div className="action-buttons">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== ""}
          onClick={() => decide(true)}
        >
          {busy === "approve" ? "Accepting…" : "Accept test change"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== ""}
          onClick={() => decide(false)}
        >
          {busy === "reject" ? "Sending back…" : `Send back to ${fixer}`}
        </button>
      </div>
      <ErrorLine error={error} />
      <p className="muted small">
        Accept keeps the changed tests and needs the combined check to be green.
        Send back wakes {fixer} to put the tests back and fix the code.
      </p>
    </div>
  );
}
