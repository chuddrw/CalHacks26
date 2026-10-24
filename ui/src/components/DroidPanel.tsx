/** WHAT IT'S FOR: live diagnosis feed with source labels, failure visibility, and optional following. Owner: D. */
import { useEffect, useRef, useState } from "react";
import type { ConflictRow } from "../../../shared/src/schema.ts";
import { useRows } from "../stdb";
import { absoluteTime } from "../time";
import { Icon } from "./Icon";
export function DroidPanel({ conflict }: { conflict?: ConflictRow }) {
  const rows = useRows("diagnosis_step");
  const steps = rows
    .filter((s) => s.conflictId === conflict?.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const [follow, setFollow] = useState(true);
  const feed = useRef<HTMLDivElement>(null);
  const latest = steps.at(-1);
  useEffect(() => {
    setFollow(true);
  }, [conflict?.id]);
  useEffect(() => {
    if (follow && feed.current)
      feed.current.scrollTop = feed.current.scrollHeight;
  }, [follow, steps.length, conflict?.id]);
  const running =
    conflict &&
    conflict.status !== "resolved" &&
    latest?.kind !== "final" &&
    latest?.kind !== "error";
  const status = !conflict
    ? "Standby"
    : !latest
      ? "Waiting"
      : latest.kind === "error"
        ? "Error"
        : latest.kind === "final"
          ? "Complete"
          : running
            ? "Investigating"
            : "Steps recorded";
  return (
    <aside className="diagnosis-content" aria-labelledby="diagnosis-title">
      <div className="section-heading">
        <h2 id="diagnosis-title">
          <Icon name="sparkle" />
          Diagnosis
        </h2>
        <span className={`pill ${running ? "tone-cyan" : "muted"}`}>
          <span className="dot" />
          {status}
        </span>
      </div>
      <div className="diagnosis-subheading">
        <span>
          {latest
            ? latest.source === "droid"
              ? "Factory Droid"
              : "Claude fallback"
            : "Waiting for investigator"}
        </span>
        <button
          type="button"
          className="text-button"
          onClick={() => setFollow(!follow)}
          aria-pressed={follow}
        >
          {follow ? "Following" : "Follow latest"}
          <Icon name={follow ? "check" : "arrow"} size={13} />
        </button>
      </div>
      <div
        className="diagnosis-feed"
        ref={feed}
        tabIndex={0}
        role="log"
        aria-label="Diagnosis steps"
        aria-live="off"
        onScroll={() => {
          const el = feed.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 55)
            setFollow(false);
        }}
      >
        {steps.length === 0 ? (
          <div className="diagnosis-empty">
            <Icon name="sparkle" size={26} />
            <p>
              {conflict
                ? "Waiting for diagnosis steps…"
                : "An investigator starts when a combined check fails."}
            </p>
          </div>
        ) : (
          <ol className="diagnosis-steps">
            {steps.map((step, i) => (
              <li key={step.id} className={`step-${step.kind}`}>
                <span className="step-marker">
                  {step.kind === "final" ? (
                    <Icon name="check" size={13} />
                  ) : step.kind === "error" ? (
                    <Icon name="alert" size={13} />
                  ) : (
                    <span>{String(i + 1).padStart(2, "0")}</span>
                  )}
                </span>
                <div>
                  <div className="step-heading">
                    <strong>{step.kind.replaceAll("_", " ")}</strong>
                    <span title={absoluteTime(step.createdAt)}>
                      {step.source === "droid" ? "Droid" : "Claude"}
                    </span>
                  </div>
                  <pre>{step.detail}</pre>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
      <p className="sr-only" role="status">
        {latest
          ? `Latest diagnosis step: ${latest.kind.replaceAll("_", " ")}`
          : "No diagnosis steps yet"}
      </p>
      <div className="diagnosis-footer">
        <Icon name="info" size={14} />
        <span>Checks decide red or green. AI explains.</span>
      </div>
    </aside>
  );
}
