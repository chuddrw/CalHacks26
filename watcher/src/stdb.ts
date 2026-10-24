/**
 * watcher/src/stdb.ts
 *
 * WHAT IT'S FOR
 *   The watcher's link to SpacetimeDB over the WebSocket SDK. It keeps a live, local copy of the
 *   snapshot and conflict tables, calls back when a new snapshot arrives, and wraps every reducer
 *   the watcher calls so the rest of the watcher never touches the SDK directly.
 *
 * OWNER: B. WHEN: Sat 9:20-13:00.
 * DONE WHEN: seed-fake.ts inserting a snapshot makes onSnapshot fire within a second, and
 *            reportConflict() creates a row the UI shows.
 *
 * WHAT TO EXPORT
 *   connect(): Promise<void>                      connect with the generated bindings, subscribe to
 *                                                 "SELECT * FROM snapshot" and "SELECT * FROM conflict"
 *   onSnapshot(cb: (row: SnapshotRow) => void)    inserts only (ignore the initial sync, or dedupe by id)
 *   latestSnapshots(): Map<AgentName, SnapshotRow>
 *   openConflicts(): ConflictRow[]                status "open" or "escalated"
 *   reportCheck, reportConflict, addDiagnosisStep, setExplanation, resolveConflict,
 *   flagNeedsHuman, sendNote                      one thin wrapper per reducer, same argument order
 *                                                 as ReducerArgs in shared/src/schema.ts
 *
 * NOTES
 *   - The SDK's connection builder and subscription API differ between SpacetimeDB 1.12 and 2.0.
 *     Copy the pattern from the official TypeScript client quickstart for the version we picked.
 *   - Reconnect if the socket drops. The demo runs for hours.
 *   - Reducer calls over WebSocket don't return values. To learn a new conflict's id, wait for the
 *     row to show up in the conflict table cache (match on pair and status).
 */

// TODO (B): connect, subscriptions and reducer wrappers as listed above.
export {};
