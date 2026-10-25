/**
 * shared/src/stdb-http.ts
 *
 * WHAT IT'S FOR
 *   A tiny SpacetimeDB client over plain HTTP, for code that runs for a moment and exits:
 *   the Claude Code hooks, the scripts and the orchestrator's polling loop. The MCP server's presence and the UI use
 *   the WebSocket SDK with the generated bindings instead, so it gets live updates.
 *
 * OWNER: A (the hooks depend on it). USED BY: hooks/, scripts/.
 *
 * ENDPOINTS (SpacetimeDB 2.13; both checked against a local 2.13 server on Oct 24)
 *   POST {host}/v1/database/{db}/call/{reducer}   body: JSON array of the reducer's arguments
 *   POST {host}/v1/database/{db}/sql              body: SQL text; returns [{ schema, rows }]
 *   Both send "Authorization: Bearer <token>", where the token is this laptop user's own signed-in
 *   session (shared/src/session-token.ts). Part C's module only answers approved identities
 *   (module/ACCESS.md): an unapproved laptop gets 401/403, and `npm run doctor` says so.
 *
 * NOTES
 *   - Rows come back as positional arrays. toObjects() maps them with Columns from schema.ts,
 *     which is why every query here selects whole rows (SELECT * FROM <table>).
 *   - WHERE clauses must use the module's real column names. Part C's module sets
 *     CaseConversionPolicy.None, so SQL names are the camelCase field names (conflictId, agentA).
 *     The hooks only filter on one-word columns (agent, kind, delivered, fixer, status, id, pair),
 *     which read the same under either naming policy.
 *   - Each HTTP reducer call is its own short connection, so register_agent can't be called over
 *     HTTP (Part C requires a live connection). Presence comes from the MCP server's WebSocket.
 *   - Every call has a 3-second timeout. A hook must stay fast and must never hang an agent.
 */
import { config } from "./config.ts";
import { Columns, type ReducerArgs, type ReducerName, type TableName, type TableRows } from "./schema.ts";
import { sessionToken } from "./session-token.ts";

const TIMEOUT_MS = 3000;

function endpoint(suffix: string): string {
  const host = config.stdbHost.replace(/\/+$/, "");
  return `${host}/v1/database/${encodeURIComponent(config.stdbDb)}/${suffix}`;
}

async function headers(contentType: string): Promise<Record<string, string>> {
  const token = await sessionToken();
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": contentType } : { "Content-Type": contentType };
}

/**
 * Calls a reducer. Throws on a non-2xx response or a timeout. `timeoutMs` is for scripts a person
 * runs by hand (the reset), whose one big reducer can take longer than a hook may wait.
 */
export async function callReducer<R extends ReducerName>(name: R, args: ReducerArgs[R], timeoutMs = TIMEOUT_MS): Promise<void> {
  const res = await fetch(endpoint(`call/${name}`), {
    method: "POST",
    headers: await headers("application/json"),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`reducer ${name} failed: ${res.status} ${await res.text()}`);
}

/** Runs SELECT * FROM <table> [WHERE ...] and returns typed rows. */
export async function selectRows<T extends TableName>(table: T, where = ""): Promise<TableRows[T][]> {
  const query = `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""}`;
  const res = await fetch(endpoint("sql"), {
    method: "POST",
    headers: await headers("text/plain"),
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

/**
 * Ends the process with `code` without process.exit(). It sets process.exitCode and closes fetch's
 * keep-alive connections so they don't hold the process open; the caller then returns and Node
 * exits by itself. The caller must leave nothing else running (timers, loops).
 *
 * Why: on Windows, process.exit() shortly after a database call can crash Node instead of exiting
 * ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c", exit code
 * 0xC0000409). process.exit() tears down while Node's background work (for example compiling the
 * TypeScript type stripper) is still finishing; a normal exit waits for it. Exit code 2 is how
 * Claude Code knows to wake an agent, so a crash there means the fixer never wakes.
 */
export async function finishProcess(code: number): Promise<void> {
  process.exitCode = code;
  const dispatcher = (globalThis as Record<symbol, { destroy?: () => Promise<void> } | undefined>)[
    Symbol.for("undici.globalDispatcher.1")
  ];
  try {
    await dispatcher?.destroy?.();
  } catch {
    // Already closed.
  }
}

/** Quotes a value for a SpacetimeDB SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
