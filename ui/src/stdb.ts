/** WHAT IT'S FOR: React table access and the live database connection. Owner: D. */
import { useSyncExternalStore } from "react";
import type { TableName, TableRows } from "../../shared/src/schema.ts";
import { emptyTables } from "./dashboard";
import { getSnapshot, replaceTables, setConnection, subscribe } from "./store";
import { liveConnection, startLive, type Bindings } from "./live";
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
 * Part C's review_test_change; approve needs a green check, reject wakes the fixer.
 */
export async function reviewTestChange(
  conflictId: number,
  approve: boolean,
  comment: string,
): Promise<void> {
  const call = liveConnection()?.reducers?.reviewTestChange;
  if (!call)
    throw new Error(
      "The dashboard isn't connected. Run `npm run review` on a signed-in laptop instead.",
    );
  await call({ conflictId, approve, comment });
}

/**
 * A person's answer to a review the orchestrator asked for (a major change to their feature).
 * Part C's decide_review; approving the last pending review releases the request's tasks.
 */
export async function decideReview(reviewId: number, approve: boolean, answer: string): Promise<void> {
  const call = liveConnection()?.reducers?.decideReview;
  if (!call) throw new Error("The dashboard isn't connected to the team database.");
  await call({ reviewId, approve, answer });
}

/**
 * Both humans' decision on a conflict their agents couldn't settle (status escalated).
 * Part C's decide_conflict, which reopens it and wakes both agents with the decision.
 */
export async function decideConflict(conflictId: number, decision: string): Promise<void> {
  const call = liveConnection()?.reducers?.decideConflict;
  if (!call) throw new Error("The dashboard isn't connected to the team database.");
  await call({ conflictId, decision });
}

/**
 * A person's request to the orchestrator, typed on the dashboard. The module's submit_request_as_me(body)
 * works out the agent from the signed-in identity (member_profile), so nobody can ask as someone else.
 * It needs the Editor role and a name given when the owner approved the identity.
 */
export async function submitRequestAsMe(body: string): Promise<void> {
  const call = liveConnection()?.reducers?.submitRequestAsMe;
  if (!call) throw new Error("The dashboard isn't connected with an account that can send requests.");
  await call({ body });
}

/** Starts a kickoff: the goal, constraints and team (JSON from membersJson). Needs the Editor role and a profile. */
export async function submitKickoff(goal: string, constraints: string, members: string): Promise<void> {
  const call = liveConnection()?.reducers?.submitKickoff;
  if (!call) throw new Error("The dashboard isn't connected with an account that can start a kickoff.");
  await call({ goal, constraints, members });
}

/** The answers to the orchestrator's kickoff questions (JSON from answersJson). */
export async function answerKickoff(kickoffId: number, answers: string): Promise<void> {
  const call = liveConnection()?.reducers?.answerKickoff;
  if (!call) throw new Error("The dashboard isn't connected with an account that can answer a kickoff.");
  await call({ kickoffId, answers });
}

/** Approve or send back a proposed kickoff. Approving never writes main: a person commits the owners file. */
export async function decideKickoff(kickoffId: number, approve: boolean, note: string): Promise<void> {
  const call = liveConnection()?.reducers?.decideKickoff;
  if (!call) throw new Error("The dashboard isn't connected with an account that can decide a kickoff.");
  await call({ kickoffId, approve, note });
}
