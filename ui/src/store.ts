/** WHAT IT'S FOR: a batched, immutable dashboard store used by live and simulated transports. */
import type { TableName, TableRows } from "../../shared/src/schema.ts";
import { emptyTables, type ConnectionState, type Tables } from "./dashboard";

export interface DashboardSnapshot {
  tables: Tables;
  connection: ConnectionState;
}
let snapshot: DashboardSnapshot = {
  tables: emptyTables(),
  connection: {
    phase: "unconfigured",
    detail: "Configure the database connection to see your team's live work.",
    updatedAt: 0,
  },
};
const listeners = new Set<() => void>();
export const getSnapshot = (): DashboardSnapshot => snapshot;
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function replaceTables(tables: Tables): void {
  snapshot = { ...snapshot, tables };
  emit();
}
export function setRows<T extends TableName>(
  table: T,
  rows: TableRows[T][],
): void {
  replaceTables({ ...snapshot.tables, [table]: rows });
}
export function setConnection(
  connection: Omit<ConnectionState, "updatedAt">,
): void {
  snapshot = {
    ...snapshot,
    connection: { ...connection, updatedAt: Date.now() },
  };
  emit();
}
function emit(): void {
  for (const listener of listeners) listener();
}
