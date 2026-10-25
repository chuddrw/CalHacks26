/** WHAT IT'S FOR: React table access and explicit live/demo startup. Owner: D. */
import { useSyncExternalStore } from "react";
import type { TableName, TableRows } from "../../shared/src/schema.ts";
import { emptyTables } from "./dashboard";
import { getSnapshot, replaceTables, setConnection, subscribe } from "./store";
import { liveConnection, startLive, type Bindings } from "./live";
import { decideDemoConflict, decideDemoReview, reviewDemoConflict, startDemo } from "./demo";
import { fetchSessionToken } from "./session";
export { setRows } from "./store";

export function useDashboard() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
export function useRows<T extends TableName>(table: T): TableRows[T][] {
  return useSyncExternalStore(subscribe, () => getSnapshot().tables[table]);
}
let stop: (() => void) | undefined;
let epoch = 0;
export function connect(): () => void {
  stop?.();
  const current = ++epoch;
  replaceTables(emptyTables());
  stop = undefined;
  if (new URLSearchParams(location.search).has("demo")) {
    setConnection({
      phase: "demo",
      detail: "Simulated data. No agents or database are connected.",
    });
    stop = startDemo();
  } else {
    const database = import.meta.env.VITE_STDB_DB?.trim();
    const host =
      import.meta.env.VITE_STDB_HOST?.trim() ||
      "https://maincloud.spacetimedb.com";
    // C's real generated index is discovered at build time. An empty glob is intentional today.
    const generated = import.meta.glob("../../shared/module_bindings/index.ts");
    const load = generated["../../shared/module_bindings/index.ts"];
    if (!database || !load) {
      setConnection({
        phase: "unconfigured",
        detail: !database
          ? "Set VITE_STDB_DB in the root .env, then restart the dashboard."
          : "Waiting for generated SpacetimeDB bindings from C. Generate them, then restart the dashboard.",
      });
    } else {
      setConnection({
        phase: "connecting",
        detail: "Loading the database client…",
      });
      // Sign in as this laptop's `spacetime login` user (ui/dev-session.ts). No token: live.ts
      // shows "Sign in with an approved reader account" instead of connecting anonymously.
      void Promise.all([load(), fetchSessionToken()])
        .then(([module, token]) => {
          if (current !== epoch) return;
          const bindings = module as Partial<Bindings>;
          if (!bindings.DbConnection?.builder)
            throw new Error(
              "Generated bindings must export DbConnection.builder().",
            );
          stop = startLive(bindings as Bindings, host, database, {
            getToken: () => token,
          });
        })
        .catch((error) => {
          if (current === epoch)
            setConnection({
              phase: "error",
              detail:
                error instanceof Error
                  ? error.message
                  : "Could not load database bindings.",
            });
        });
    }
  }
  return () => {
    if (current === epoch) {
      epoch++;
      stop?.();
      stop = undefined;
    }
  };
}

/**
 * A person's answer to a fix that changed existing tests (conflict status needs_human).
 * Live: Part C's review_test_change; approve needs a green check, reject wakes the fixer.
 * Demo (?demo): changes only the simulated rows on this page.
 */
export async function reviewTestChange(
  conflictId: number,
  approve: boolean,
  comment: string,
): Promise<void> {
  if (getSnapshot().connection.phase === "demo") {
    reviewDemoConflict(conflictId, approve);
    return;
  }
  const call = liveConnection()?.reducers?.reviewTestChange;
  if (!call)
    throw new Error(
      "The dashboard isn't connected. Run `npm run review` on a signed-in laptop instead.",
    );
  await call({ conflictId, approve, comment });
}

/**
 * A person's answer to a review the orchestrator asked for (a major change to their feature).
 * Live: Part C's decide_review; approving the last pending review releases the request's tasks.
 * Demo (?demo): changes only the simulated rows on this page.
 */
export async function decideReview(reviewId: number, approve: boolean, answer: string): Promise<void> {
  if (getSnapshot().connection.phase === "demo") {
    decideDemoReview(reviewId, approve, answer);
    return;
  }
  const call = liveConnection()?.reducers?.decideReview;
  if (!call) throw new Error("The dashboard isn't connected to the team database.");
  await call({ reviewId, approve, answer });
}

/**
 * Both humans' decision on a conflict their agents couldn't settle (status escalated).
 * Live: Part C's decide_conflict, which reopens it and wakes both agents with the decision.
 */
export async function decideConflict(conflictId: number, decision: string): Promise<void> {
  if (getSnapshot().connection.phase === "demo") {
    decideDemoConflict(conflictId, decision);
    return;
  }
  const call = liveConnection()?.reducers?.decideConflict;
  if (!call) throw new Error("The dashboard isn't connected to the team database.");
  await call({ conflictId, decision });
}
