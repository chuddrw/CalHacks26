/**
 * shared/src/stdb-http.ts
 *
 * WHAT IT'S FOR
 *   A tiny SpacetimeDB client over plain HTTP, for code that runs for a moment and exits:
 *   the Claude Code hooks and the scripts. Long-running code (watcher, MCP server, UI) uses
 *   the WebSocket SDK with the generated bindings instead, so it gets live updates.
 *
 * OWNER: A (the hooks depend on it). USED BY: hooks/, scripts/.
 *
 * ENDPOINTS (SpacetimeDB 2.13; both checked against a local 2.13 server on Oct 24)
 *   POST {host}/v1/database/{db}/call/{reducer}   body: JSON array of the reducer's arguments
 *   POST {host}/v1/database/{db}/sql              body: SQL text; returns [{ schema, rows }]
 *   Both need "Authorization: Bearer <STDB_TOKEN>". Getting a token: external/spacetimedb-maincloud.txt.
 *
 * NOTES
 *   - Rows come back as positional arrays. toObjects() maps them with Columns from schema.ts,
 *     which is why every query here selects whole rows (SELECT * FROM <table>).
 *   - WHERE clauses must use the module's real column names. SpacetimeDB 2.13 stores camelCase
 *     fields as snake_case columns (agent_a, conflict_id, created_at), so WHERE strings use
 *     snake_case while Columns keeps the camelCase field names.
 *   - Each HTTP reducer call is its own short connection. register_agent over HTTP marks the agent
 *     online and then offline again when that connection closes; presence comes from the MCP
 *     server's WebSocket.
 *   - Every call has a 3-second timeout. A hook must stay fast and must never hang an agent.
 *   - Status: both run against a live 2.13 database. watcher/src/fixture.ts posts every test
 *     snapshot with callReducer(), and scripts/seed-fake.ts finds its conflict with selectRows().
 */
import { config } from "./config.ts";
import { Columns, type ReducerArgs, type ReducerName, type TableName, type TableRows } from "./schema.ts";

const TIMEOUT_MS = 3000;

function endpoint(suffix: string): string {
  const host = config.stdbHost.replace(/\/+$/, "");
  return `${host}/v1/database/${encodeURIComponent(config.stdbDb)}/${suffix}`;
}

function headers(contentType: string): Record<string, string> {
  return { Authorization: `Bearer ${config.stdbToken}`, "Content-Type": contentType };
}

/** Calls a reducer. Throws on a non-2xx response or a timeout. */
export async function callReducer<R extends ReducerName>(name: R, args: ReducerArgs[R]): Promise<void> {
  const res = await fetch(endpoint(`call/${name}`), {
    method: "POST",
    headers: headers("application/json"),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`reducer ${name} failed: ${res.status} ${await res.text()}`);
}

/** Runs SELECT * FROM <table> [WHERE ...] and returns typed rows. */
export async function selectRows<T extends TableName>(table: T, where = ""): Promise<TableRows[T][]> {
  const query = `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""}`;
  const res = await fetch(endpoint("sql"), {
    method: "POST",
    headers: headers("text/plain"),
    body: query,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sql failed: ${res.status} ${await res.text()}`);
  const results = (await res.json()) as Array<{ rows?: unknown[][] }>;
  return toObjects(table, results[0]?.rows ?? []);
}

/** Turns positional rows into objects using the column order in schema.ts. */
export function toObjects<T extends TableName>(table: T, rows: unknown[][]): TableRows[T][] {
  const columns: readonly string[] = Columns[table];
  return rows.map((row) => Object.fromEntries(columns.map((name, i) => [name, row[i]])) as unknown as TableRows[T]);
}

/** Quotes a value for a SpacetimeDB SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
