/**
 * WHAT IT'S FOR: read-only SpacetimeDB transport for D's dashboard.
 * C owns the generated bindings. SDK boundary follows installed spacetimedb 2.13.0;
 * live integration must still be verified against C's published module.
 */
import {
  Columns,
  type TableName,
  type TableRows,
} from "../../shared/src/schema.ts";
import { emptyTables } from "./dashboard";
import { replaceTables, setConnection } from "./store";

export const tableNames = Object.keys(Columns) as TableName[];
const numbers = new Set([
  "id",
  "lastSnapshotAt",
  "createdAt",
  "resolvedAt",
  "conflictId",
]);
const arrays = new Set(["files", "symbols", "agents"]);
const booleans = new Set(["online", "verified", "delivered"]);
const timestamps = new Set(["lastSnapshotAt", "createdAt", "resolvedAt"]);
const enums: Partial<Record<TableName, Record<string, string[]>>> = {
  agent: { status: ["working", "green", "red"] },
  check_run: { result: ["green", "red"] },
  conflict: {
    kind: ["self", "merge", "pair"],
    status: ["open", "resolved", "escalated", "needs_human"],
  },
  inbox: { kind: ["conflict", "info", "heads_up", "fact"] },
  diagnosis_step: {
    source: ["droid", "claude"],
    kind: ["status", "tool_call", "tool_result", "thought", "final", "error"],
  },
};
const camelCase = (value: string) =>
  value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** SDK u64 fields are bigint. Reject unsafe values rather than rounding identifiers. */
export function normalizeRow<T extends TableName>(
  table: T,
  row: unknown,
): TableRows[T] {
  if (!row || typeof row !== "object") throw new Error(`Invalid ${table} row`);
  const input = row as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const field of Columns[table]) {
    let value = input[field];
    if (numbers.has(field)) {
      if (typeof value === "bigint") value = Number(value);
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        throw new Error(
          `Invalid ${table}.${field}: expected safe nonnegative integer`,
        );
      if (timestamps.has(field) && value > 8_640_000_000_000_000)
        throw new Error(
          `Invalid ${table}.${field}: timestamp is outside the supported Date range`,
        );
    } else if (arrays.has(field)) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
        throw new Error(`Invalid ${table}.${field}: expected string array`);
      value = [...value];
    } else if (booleans.has(field)) {
      if (typeof value !== "boolean")
        throw new Error(`Invalid ${table}.${field}: expected boolean`);
    } else if (typeof value !== "string")
      throw new Error(`Invalid ${table}.${field}: expected string`);
    const allowed = enums[table]?.[field];
    if (allowed && !allowed.includes(value as string))
      throw new Error(`Unknown ${table}.${field}: ${String(value)}`);
    output[field] = value;
  }
  return output as unknown as TableRows[T];
}

// Structural boundary: absent generated source is never replaced with fabricated bindings.
type Listener = (...args: unknown[]) => void;
interface ClientTable {
  iter(): Iterable<unknown>;
  onInsert(callback: Listener): void;
  onUpdate(callback: Listener): void;
  onDelete(callback: Listener): void;
  removeOnInsert(callback: Listener): void;
  removeOnUpdate(callback: Listener): void;
  removeOnDelete(callback: Listener): void;
}
interface Subscription {
  unsubscribe(): void;
}
interface SubscriptionBuilder {
  onApplied(callback: Listener): SubscriptionBuilder;
  onError(callback: Listener): SubscriptionBuilder;
  subscribe(queries: string[]): Subscription;
}
interface Connection {
  db: Record<string, ClientTable>;
  disconnect(): void;
  subscriptionBuilder(): SubscriptionBuilder;
}
export interface ConnectionBuilder {
  withUri(host: string): ConnectionBuilder;
  withDatabaseName(database: string): ConnectionBuilder;
  withToken(token: string): ConnectionBuilder;
  onConnect(callback: (connection: Connection) => void): ConnectionBuilder;
  onConnectError(callback: Listener): ConnectionBuilder;
  onDisconnect(callback: Listener): ConnectionBuilder;
  build(): Connection;
}
export interface Bindings {
  DbConnection: { builder(): ConnectionBuilder };
}

/** Injectable bindings allow lifecycle tests without a real database. */
export function startLive(
  bindings: Bindings,
  host: string,
  database: string,
  session?: { getToken(): string | undefined | Promise<string | undefined> },
): () => void {
  let disposed = false;
  let generation = 0;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  async function connect(): Promise<void> {
    if (disposed) return;
    const current = ++generation;
    let connection: Connection | undefined;
    let subscription: Subscription | undefined;
    const cleanup: (() => void)[] = [];
    let queued = false;
    let failed = false;
    const alive = () => !disposed && current === generation && !failed;
    release = () => {
      for (const remove of cleanup) {
        try {
          remove();
        } catch {
          /* transport already closed */
        }
      }
      try {
        subscription?.unsubscribe();
      } catch {
        /* already closed */
      }
      try {
        connection?.disconnect();
      } catch {
        /* already closed */
      }
    };
    function fail(detail: string): void {
      if (!alive()) return;
      failed = true;
      if (deadline) clearTimeout(deadline);
      release?.();
      const delay = Math.min(1000 * 2 ** attempt++, 30000);
      setConnection({
        phase: "reconnecting",
        detail: `${detail} Displayed data may be stale. Retrying in ${delay / 1000}s.`,
      });
      retry = setTimeout(connect, delay);
    }
    function readTables(conn: Connection): void {
      if (!alive()) return;
      try {
        const tables = emptyTables();
        for (const table of tableNames) {
          const accessor = conn.db[camelCase(table)] ?? conn.db[table];
          if (!accessor || typeof accessor.iter !== "function")
            throw new Error(`Generated bindings are missing table ${table}`);
          (tables[table] as TableRows[TableName][]) = Array.from(
            accessor.iter(),
            (row) => normalizeRow(table, row),
          );
        }
        replaceTables(tables);
      } catch (error) {
        fail(
          error instanceof Error
            ? error.message
            : "Could not read database rows",
        );
      }
    }
    setConnection({
      phase: attempt ? "reconnecting" : "connecting",
      detail: `Connecting to ${database}…`,
    });
    deadline = setTimeout(
      () => fail("Connection or subscription timed out."),
      20000,
    );
    try {
      const builder = bindings.DbConnection.builder()
        .withUri(host)
        .withDatabaseName(database);
      if (session) {
        // Resolve again on each reconnect; never retain credentials in the store.
        let token: string | undefined;
        try {
          token = await session.getToken();
        } catch {
          // Authentication errors can contain credentials; do not surface them.
        }
        if (!alive()) return;
        if (!token?.trim()) {
          if (deadline) clearTimeout(deadline);
          replaceTables(emptyTables());
          setConnection({
            phase: "error",
            detail:
              "Run spacetime login on this laptop, ask the database owner to approve your public identity, then retry. Open the dashboard through its local Vite server.",
          });
          return;
        }
        builder.withToken(token);
      }
      connection = builder
        .onConnect((conn) => {
          if (!alive()) {
            conn.disconnect();
            return;
          }
          connection = conn;
          setConnection({
            phase: "syncing",
            detail: "Connected. Waiting for all team tables to synchronize…",
          });
          const refresh = () => {
            if (!alive() || queued) return;
            queued = true;
            queueMicrotask(() => {
              queued = false;
              readTables(conn);
            });
          };
          try {
            for (const table of tableNames) {
              const accessor = conn.db[camelCase(table)] ?? conn.db[table];
              if (!accessor)
                throw new Error(
                  `Generated bindings are missing table ${table}`,
                );
              accessor.onInsert(refresh);
              accessor.onUpdate(refresh);
              accessor.onDelete(refresh);
              cleanup.push(() => {
                accessor.removeOnInsert(refresh);
                accessor.removeOnUpdate(refresh);
                accessor.removeOnDelete(refresh);
              });
            }
            subscription = conn
              .subscriptionBuilder()
              .onApplied(() => {
                if (!alive()) return;
                readTables(conn);
                if (!alive()) return;
                if (deadline) clearTimeout(deadline);
                attempt = 0;
                setConnection({
                  phase: "live",
                  detail: `Subscribed to ${database}. All team tables are synchronized.`,
                });
              })
              .onError(() =>
                fail(
                  "Database subscription failed. Check permissions and schema.",
                ),
              )
              .subscribe(tableNames.map((table) => `SELECT * FROM ${table}`));
          } catch (error) {
            fail(
              error instanceof Error ? error.message : "Could not subscribe",
            );
          }
        })
        .onConnectError(() => fail("Could not connect to the database."))
        .onDisconnect(() => fail("The database connection was interrupted."))
        .build();
    } catch (error) {
      fail(error instanceof Error ? error.message : "Connection failed");
    }
  }
  connect();
  return () => {
    disposed = true;
    generation++;
    if (retry) clearTimeout(retry);
    if (deadline) clearTimeout(deadline);
    release?.();
  };
}
