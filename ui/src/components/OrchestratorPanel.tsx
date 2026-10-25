/**
 * WHAT IT'S FOR: the orchestrator, on the dashboard (branch feat/orchestrator). For each request a
 * human made through their own agent: Droid's plan as it forms (plan_step rows, live), the reviews
 * a major change needs, with the Approve / Send back buttons for the human whose feature it affects
 * (Part C's decide_review), and the tasks each owner's agent got. Owner: A (for D's dashboard).
 */
import { useEffect, useRef, useState } from "react";
import type { RequestRow, ReviewRow, TaskRow } from "../../../shared/src/schema.ts";
import { decideReview, useRows } from "../stdb";
import { absoluteTime, relativeTime } from "../time";
import { useNow } from "../useNow";
import { Icon } from "./Icon";

const requestStatus: Record<RequestRow["status"], { label: string; tone: string }> = {
  new: { label: "Waiting for the orchestrator", tone: "neutral" },
  planning: { label: "Droid is planning", tone: "cyan" },
  waiting_review: { label: "Waiting for review", tone: "amber" },
  assigned: { label: "Tasks assigned", tone: "cyan" },
  done: { label: "Done", tone: "green" },
  rejected: { label: "Sent back", tone: "red" },
  failed: { label: "Planning failed", tone: "red" },
};
const taskStatus: Record<TaskRow["status"], { label: string; tone: string }> = {
  waiting_review: { label: "Waits for review", tone: "amber" },
  assigned: { label: "Working", tone: "cyan" },
  done: { label: "Done", tone: "green" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

function ReviewButtons({ review }: { review: ReviewRow }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState<"" | "approve" | "reject">("");
  const [error, setError] = useState("");
  const who = review.reviewer.toUpperCase();
  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "reject");
    setError("");
    try {
      await decideReview(review.id, approve, answer.trim());
      setAnswer("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The database refused the review.");
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="review-actions">
      <input
        className="review-comment"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder={`${who}'s note (optional; say why when sending back)`}
        maxLength={500}
        aria-label={`${who}'s note on review ${review.id}`}
        disabled={busy !== ""}
      />
      <div className="review-buttons">
        <button type="button" className="button compact review-accept" disabled={busy !== ""} onClick={() => void decide(true)}>
          <Icon name="check" size={14} />
          {busy === "approve" ? "Approving…" : `Approve as ${who}`}
        </button>
        <button type="button" className="button compact review-reject" disabled={busy !== ""} onClick={() => void decide(false)}>
          <Icon name="arrow" size={14} />
          {busy === "reject" ? "Sending back…" : "Send back"}
        </button>
      </div>
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PlanSteps({ request }: { request: RequestRow }) {
  const steps = useRows("plan_step")
    .filter((step) => step.requestId === request.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const feed = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [steps.length]);
  return (
    <details className="orchestrator-steps" open={request.status === "planning" || request.status === "new"}>
      <summary>
        <Icon name="sparkle" size={15} />
        Droid's plan, step by step ({steps.length})
        {request.status === "planning" && (
          <span className="pill tone-cyan">
            <span className="dot" />
            live
          </span>
        )}
      </summary>
      <div className="diagnosis-feed" ref={feed} tabIndex={0} role="log" aria-label="Orchestrator steps" aria-live="off">
        {steps.length === 0 ? (
          <p className="muted small">No steps yet.</p>
        ) : (
          <ol className="diagnosis-steps">
            {steps.map((step, i) => (
              <li key={step.id} className={`step-${step.kind}`}>
                <span className="step-marker">
                  {step.kind === "final" ? <Icon name="check" size={13} /> : step.kind === "error" ? <Icon name="alert" size={13} /> : <span>{String(i + 1).padStart(2, "0")}</span>}
                </span>
                <div>
                  <div className="step-heading">
                    <strong>{step.kind.replaceAll("_", " ")}</strong>
                    <span title={absoluteTime(step.createdAt)}>{step.detail.startsWith("Rule:") ? "Contract rule" : "Droid"}</span>
                  </div>
                  <pre>{step.detail}</pre>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

export function OrchestratorPanel({ requestId }: { requestId?: number }) {
  const requests = useRows("request");
  const tasks = useRows("task");
  const reviews = useRows("review");
  const now = useNow();
  const sorted = [...requests].sort((a, b) => b.id - a.id);
  const [selectedId, setSelectedId] = useState<number | undefined>(requestId);
  const selected = sorted.find((r) => r.id === selectedId) ?? sorted[0];
  if (!selected) {
    return (
      <div className="workspace-empty">
        <span className="empty-orbit">
          <Icon name="sparkle" size={30} />
        </span>
        <h3>No requests yet</h3>
        <p>
          A human tells their own agent what they want; the agent forwards it with ask_orchestrator. Droid then plans it and assigns
          each part to the agent that owns that feature.
        </p>
      </div>
    );
  }
  const mineReviews = reviews.filter((r) => r.requestId === selected.id).sort((a, b) => a.id - b.id);
  const mineTasks = tasks.filter((t) => t.requestId === selected.id).sort((a, b) => a.id - b.id);
  const status = requestStatus[selected.status];
  return (
    <section className="orchestrator-content" aria-labelledby="orchestrator-title">
      <div className="section-heading">
        <h2 id="orchestrator-title">
          <Icon name="sparkle" />
          Orchestrator
        </h2>
        <span className="eyebrow">REQUEST → PLAN → TASKS</span>
      </div>
      {sorted.length > 1 && (
        <div className="conflict-tabs" aria-label="Select a request">
          {sorted.map((r) => (
            <button type="button" key={r.id} aria-pressed={selected.id === r.id} onClick={() => setSelectedId(r.id)}>
              #{r.id} · {r.agent.toUpperCase()}
              <span className={`dot tone-${requestStatus[r.status].tone}`} />
            </button>
          ))}
        </div>
      )}
      <div className="conflict-title-row">
        <div>
          <p className="eyebrow">
            REQUEST #{selected.id} · FROM {selected.agent.toUpperCase()}'S HUMAN ·{" "}
            <time title={absoluteTime(selected.createdAt)}>{relativeTime(selected.createdAt, now)}</time>
          </p>
          <h3 className="request-body">“{selected.body}”</h3>
        </div>
        <span className={`pill tone-${status.tone}`}>{status.label}</span>
      </div>
      {selected.summary && (
        <div className={`explanation ${selected.status === "done" ? "resolved" : ""}`}>
          <Icon name={selected.status === "failed" || selected.status === "rejected" ? "alert" : "sparkle"} />
          <div>
            <strong>{selected.status === "failed" ? "Why planning failed" : "The plan"}</strong>
            <p>{selected.summary}</p>
          </div>
        </div>
      )}
      {mineReviews.length > 0 && (
        <section className="inspector-section">
          <h3>Reviews by the humans whose features change</h3>
          {mineReviews.map((review) => (
            <div key={review.id} className={review.status === "pending" ? "human-callout" : "review-done"} role={review.status === "pending" ? "status" : undefined}>
              <Icon name={review.status === "approved" ? "check" : review.status === "pending" ? "alert" : "arrow"} />
              <div>
                <strong>
                  {review.reviewer.toUpperCase()}'s human
                  {review.status === "pending" ? " · review needed" : ` · ${review.status}`}
                </strong>
                <p>{review.summary}</p>
                {review.answer && <p className="small muted">Note: {review.answer}</p>}
                {review.status === "pending" && <ReviewButtons key={review.id} review={review} />}
              </div>
            </div>
          ))}
        </section>
      )}
      <section className="inspector-section">
        <h3>Tasks</h3>
        {mineTasks.length === 0 ? (
          <p className="muted small">{selected.status === "planning" || selected.status === "new" ? "Droid hasn't assigned anything yet." : "No tasks."}</p>
        ) : (
          <ul className="task-list">
            {mineTasks.map((task) => (
              <li key={task.id}>
                <span className="avatar-mini">{task.agent.toUpperCase()}</span>
                <div>
                  <strong>
                    #{task.id} {task.title}
                    {task.major && <span className="pill tone-violet">major</span>}
                  </strong>
                  {task.details && <p className="small">{task.details}</p>}
                  {task.files.length > 0 && <p className="small muted">{task.files.join(", ")}</p>}
                  {task.note && <p className="small">Result: {task.note}</p>}
                </div>
                <span className={`pill tone-${taskStatus[task.status].tone}`}>{taskStatus[task.status].label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <PlanSteps request={selected} />
    </section>
  );
}
