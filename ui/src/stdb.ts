/**
 * ui/src/stdb.ts
 *
 * WHAT IT'S FOR
 *   The dashboard's live link to SpacetimeDB. It connects with the generated bindings, subscribes
 *   to every table, and hands the rows to React through useRows(). Because every screen subscribes
 *   to the same database, all three screens change at the same moment in the demo.
 *
 * OWNER: D. WHEN: tonight (connect and show one table), Sat 9:20-13:00 (all tables).
 * DONE WHEN: scripts/seed-fake.ts makes cards and a conflict appear on every open dashboard within
 *            a second, with no page reload.
 *
 * HOW
 *   connect(): build the connection with the generated bindings in shared/module_bindings, using
 *     import.meta.env.VITE_STDB_HOST and VITE_STDB_DB. Subscribe to "SELECT * FROM <table>" for every
 *     table in shared/src/schema.ts. On every insert, update or delete, call setRows(table,
 *     [...all rows of that table]). Copy the connection pattern from the official SpacetimeDB
 *     TypeScript (or React) quickstart for the version we picked.
 *   useRows(table): already written below; components call it and re-render on changes.
 *
 * The UI only reads. It never calls reducers, except a future "approve" button (stretch item 1).
 */
import { useSyncExternalStore } from "react";
import type { TableName, TableRows } from "../../shared/src/schema.ts";

type Store = { [K in TableName]?: TableRows[K][] };

const EMPTY: never[] = [];
const listeners = new Set<() => void>();
let store: Store = {};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replaces one table's rows and re-renders every component that reads it. Call it from the SDK callbacks. */
export function setRows<T extends TableName>(table: T, rows: TableRows[T][]): void {
  store = { ...store, [table]: rows } as Store;
  for (const listener of listeners) listener();
}

/** The live rows of one table. */
export function useRows<T extends TableName>(table: T): TableRows[T][] {
  return useSyncExternalStore(subscribe, () => (store[table] as TableRows[T][] | undefined) ?? EMPTY);
}

/** Opens the SpacetimeDB connection and keeps the store up to date. */
export function connect(): void {
  // TODO (D): connect and subscribe as described in the header, calling setRows() on every change.
}
