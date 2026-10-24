/**
 * watcher/src/stdb.ts
 *
 * WHAT IT'S FOR
 *   The watcher's link to SpacetimeDB over the WebSocket SDK. It keeps a live, local copy of the
 *   snapshot, conflict and intent tables, calls back when a new snapshot arrives, and wraps every
 *   reducer the watcher calls so the rest of the watcher never touches the SDK directly.
 *
 * OWNER: B. WHEN: Sat 9:20-13:00.
 * DONE WHEN: seed-fake.ts inserting a snapshot makes onSnapshot fire within a second, and
 *            reportConflict() creates a row the UI shows.
 *            (Checked on a local 2.13 server: seed-fake's snapshots reach onSnapshot right away and
 *            reportConflict() rows land in the conflict table. The UI half waits for ui/src/stdb.ts.)
 *
 * WHAT IT EXPORTS
 *   connect(): Promise<void>       resolves once the first subscription has arrived. Retries until
 *                                  the server answers; after that the SDK reconnects by itself.
 *   onSnapshot(cb)                 every snapshot row inserted after the first sync
 *   onResync(cb)                   the subscription came back after a reconnect (catch up)
 *   latestSnapshots()              Map<AgentName, SnapshotRow>, the newest row per agent
 *   snapshotsOf(agent)             that agent's rows, oldest first
 *   conflicts(), openConflicts()   every conflict / the ones "open" or "escalated"
 *   unresolvedConflicts()          "open", "escalated" or "needs_human" (agents stay red)
 *   latestIntent(agent)            the newest intent row the agent posted itself, or null
 *   reportCheck, reportConflict, addDiagnosisStep, setExplanation, resolveConflict,
 *   flagNeedsHuman, sendNote       one wrapper per reducer, arguments in ReducerArgs order
 *                                  (shared/src/schema.ts). reportConflict returns the conflict row.
 *   disconnect()
 *
 * NOTES
 *   - SpacetimeDB 2.13 SDK: DbConnection.builder().withUri(STDB_HOST).withDatabaseName(STDB_DB)
 *     .withToken(this user's session token, shared/src/session-token.ts).withAutomaticReconnect(). The SDK only retries a
 *     connection that worked once, so connect() retries the first one itself (1 s up to 30 s).
 *   - Subscriptions: SELECT * FROM snapshot, conflict, intent. After a reconnect the SDK replays
 *     them and onResync fires, so snapshots pushed while the socket was down still trigger a run.
 *   - A reducer call's promise resolves once its row changes are in the local cache, so
 *     reportConflict reads the new conflict's id from the cache right after it.
 */
import { DbConnection } from "../../shared/module_bindings/index.ts";
// Part C's bindings expose the team tables as authenticated views. Their rows have exactly the
// fields of the *Data backing types (the view types themselves are empty placeholders).
import type { ConflictData as Conflict, IntentData as Intent, SnapshotData as Snapshot } from "../../shared/module_bindings/types.ts";
import { config } from "../../shared/src/config.ts";
import { sessionToken } from "../../shared/src/session-token.ts";
import {
  pairKey,
  type AgentName,
  type ConflictKind,
  type ConflictRow,
  type ConflictStatus,
  type IntentRow,
  type ReducerArgs,
  type SnapshotRow,
} from "../../shared/src/schema.ts";

const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const QUERIES = ["SELECT * FROM snapshot", "SELECT * FROM conflict", "SELECT * FROM intent"];

let connection: DbConnection | null = null;
let synced = false;
let closing = false;
const snapshotListeners: Array<(row: SnapshotRow) => void> = [];
const resyncListeners: Array<() => void> = [];

export async function connect(): Promise<void> {
  closing = false;
  // The watcher's own signed-in identity, which Part C's owner must approve as an Editor.
  const token = await sessionToken();
  if (!token) console.warn("[watcher] No SpacetimeDB session token: run `spacetime login` (see module/ACCESS.md).");
  return new Promise((resolve) => {
    let attempt = 0;
    const retry = (reason: string) => {
      if (closing) return;
      const wait = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]!;
      console.warn(`[watcher] SpacetimeDB ${config.stdbHost} ${config.stdbDb}: ${reason}. Retrying in ${wait / 1000} s.`);
      setTimeout(open, wait);
    };
    const open = () => {
      DbConnection.builder()
        .withUri(config.stdbHost)
        .withDatabaseName(config.stdbDb)
        .withToken(token || undefined)
        .withAutomaticReconnect()
        .onConnect((conn) => {
          connection = conn;
          attempt = 0;
          conn.db.snapshot.onInsert((ctx, row) => {
            if (!synced || ctx.event.tag === "SubscribeApplied") return;
            for (const listener of snapshotListeners) listener(toSnapshot(row));
          });
          conn
            .subscriptionBuilder()
            .onApplied(() => {
              if (!synced) {
                synced = true;
                console.log(`[watcher] connected to SpacetimeDB ${config.stdbHost} ${config.stdbDb}`);
                resolve();
                return;
              }
              for (const listener of resyncListeners) listener();
            })
            .onError((ctx) => {
              console.error(`[watcher] SpacetimeDB subscription failed: ${ctx.event?.message ?? "unknown error"}`);
            })
            .subscribe(QUERIES);
        })
        .onAutomaticReconnect(() => console.log("[watcher] reconnected to SpacetimeDB"))
        .onConnectError((_ctx, error, _attempt, delayMs) => {
          if (delayMs !== undefined) {
            console.warn(`[watcher] SpacetimeDB reconnect failed (${reason(error)}); next try in ${Math.round(delayMs / 1000)} s.`);
            return;
          }
          connection = null;
          retry(`can't connect (${reason(error)})`);
        })
        .onDisconnect((_ctx, error, _attempt, delayMs) => {
          if (closing) return;
          if (delayMs !== undefined) {
            console.warn(`[watcher] SpacetimeDB connection lost${error ? ` (${reason(error)})` : ""}; reconnecting.`);
            return;
          }
          connection = null;
          retry(`connection closed${error ? ` (${reason(error)})` : ""}`);
        })
        .build();
    };
    open();
  });
}

function reason(error: Error | undefined): string {
  return error?.message || "no answer";
}

export function disconnect(): void {
  closing = true;
  connection?.disconnect();
  connection = null;
}

export function onSnapshot(callback: (row: SnapshotRow) => void): void {
  snapshotListeners.push(callback);
}

export function onResync(callback: () => void): void {
  resyncListeners.push(callback);
}

// ---- Reading the local copy -------------------------------------------------------------------

function conn(): DbConnection {
  if (!connection) throw new Error("Not connected to SpacetimeDB");
  return connection;
}

export function latestSnapshots(): Map<AgentName, SnapshotRow> {
  const latest = new Map<AgentName, SnapshotRow>();
  for (const row of conn().db.snapshot.iter()) {
    const current = latest.get(row.agent);
    if (!current || row.id > current.id) latest.set(row.agent, toSnapshot(row));
  }
  return latest;
}

export function snapshotsOf(agent: AgentName): SnapshotRow[] {
  return [...conn().db.snapshot.iter()]
    .filter((row) => row.agent === agent)
    .map(toSnapshot)
    .sort((x, y) => x.id - y.id);
}

export function conflicts(): ConflictRow[] {
  return [...conn().db.conflict.iter()].map(toConflict).sort((x, y) => x.id - y.id);
}

export function openConflicts(): ConflictRow[] {
  return conflicts().filter((row) => row.status === "open" || row.status === "escalated");
}

export function unresolvedConflicts(): ConflictRow[] {
  return conflicts().filter((row) => row.status !== "resolved");
}

export function latestIntent(agent: AgentName): IntentRow | null {
  let latest: Intent | null = null;
  for (const row of conn().db.intent.iter()) {
    if (row.agent === agent && !row.verified && (!latest || row.id > latest.id)) latest = row;
  }
  return latest ? { ...latest } : null;
}

function toSnapshot(row: Snapshot): SnapshotRow {
  return { ...row, files: [...row.files] };
}

function toConflict(row: Conflict): ConflictRow {
  return { ...row, kind: row.kind as ConflictKind, status: row.status as ConflictStatus };
}

// ---- Reducers (argument order = ReducerArgs in shared/src/schema.ts) ---------------------------

export async function reportCheck(...[runKey, agents, result, log]: ReducerArgs["report_check"]): Promise<void> {
  await conn().reducers.reportCheck({ runKey, agents, result, log });
}

/** Records the conflict (or updates the pair's unresolved one) and returns its row. */
export async function reportConflict(...args: ReducerArgs["report_conflict"]): Promise<ConflictRow> {
  const [kind, agentA, agentB, locA, locB, error, fixer, runKey] = args;
  await conn().reducers.reportConflict({ kind, agentA, agentB, locA, locB, error, fixer, runKey });
  const pair = pairKey(agentA, agentB);
  const row = unresolvedConflicts()
    .filter((conflict) => conflict.pair === pair)
    .at(-1);
  if (!row) throw new Error(`report_conflict for ${pair} left no unresolved conflict in the cache`);
  return row;
}

export async function addDiagnosisStep(...[conflictId, source, kind, detail]: ReducerArgs["add_diagnosis_step"]): Promise<void> {
  await conn().reducers.addDiagnosisStep({ conflictId, source, kind, detail });
}

export async function setExplanation(...[conflictId, explanation]: ReducerArgs["set_explanation"]): Promise<void> {
  await conn().reducers.setExplanation({ conflictId, explanation });
}

export async function resolveConflict(...[conflictId, verifiedFact]: ReducerArgs["resolve_conflict"]): Promise<void> {
  await conn().reducers.resolveConflict({ conflictId, verifiedFact });
}

/** Part C's guarded write: ignored unless the conflict still has this run, error and fixer. */
export async function setExplanationIfCurrent(
  ...[conflictId, expectedRunKey, expectedError, expectedFixer, explanation]: ReducerArgs["set_explanation_if_current"]
): Promise<void> {
  await conn().reducers.setExplanationIfCurrent({ conflictId, expectedRunKey, expectedError, expectedFixer, explanation });
}

/** Part C's guarded resolution: needs this exact conflict version and a current green check covering it. */
export async function resolveConflictIfCurrent(
  ...[conflictId, expectedRunKey, expectedError, expectedFixer, verifiedRunKey, verifiedFact]: ReducerArgs["resolve_conflict_if_current"]
): Promise<void> {
  await conn().reducers.resolveConflictIfCurrent({ conflictId, expectedRunKey, expectedError, expectedFixer, verifiedRunKey, verifiedFact });
}

/** The conflict row as the local cache has it right now, or undefined. */
export function conflictById(id: number): ConflictRow | undefined {
  return conflicts().find((row) => row.id === id);
}

export async function flagNeedsHuman(...[conflictId, reason]: ReducerArgs["flag_needs_human"]): Promise<void> {
  await conn().reducers.flagNeedsHuman({ conflictId, reason });
}

export async function sendNote(...[agent, kind, message]: ReducerArgs["send_note"]): Promise<void> {
  await conn().reducers.sendNote({ agent, kind, message });
}
