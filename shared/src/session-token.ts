/**
 * shared/src/session-token.ts
 *
 * WHAT IT'S FOR
 *   Finds the SpacetimeDB session token for whoever is signed in on this laptop, so the hooks, the
 *   MCP server, the watcher and the scripts all authenticate as that person. Part C's access rules
 *   (module/ACCESS.md) say every client uses its own user's signed-in session, and that no token
 *   belongs in source, setup docs or the project .env. This file follows that rule: the token comes
 *   from the spacetime CLI's own sign-in store and only ever lives in this process's memory.
 *
 * OWNER: A (written during the A+B+C integration). USED BY: shared/src/stdb-http.ts,
 *   watcher/src/stdb.ts, mcp/src/server.ts.
 *
 * WHERE THE TOKEN COMES FROM, IN ORDER
 *   1. STDB_TOKEN in the process environment. Only for tests, CI or a throwaway local server;
 *      never put a real token in .env.
 *   2. `spacetime login show --token` (the documented CLI command). SPACETIME_CLI can point at the
 *      binary if `spacetime` isn't on PATH, the same variable Part C's module tooling uses.
 *   No token: "" (callers then get 401/403 from the database, and hooks fail open).
 *
 * NOTES
 *   - The CLI's exact wording around the token isn't documented, so we take the first thing that
 *     looks like a JWT (three base64url parts joined by dots). SpacetimeDB tokens are JWTs.
 *   - One lookup per process. The CLI takes a few hundred milliseconds; long-running processes pay it once.
 *   - Before anyone can read or write, the database owner must grant their public identity a role:
 *     module/ACCESS.md. `npm run doctor` checks both steps on a laptop.
 */
import { execFile } from "node:child_process";

const JWT = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
let cached: Promise<string> | null = null;

export function sessionToken(): Promise<string> {
  cached ??= lookup();
  return cached;
}

/** Where the token came from, for `npm run doctor`. Never returns the token itself. */
export async function tokenSource(): Promise<"env" | "spacetime-cli" | "none"> {
  if (process.env.STDB_TOKEN) return "env";
  return (await fromCli()) ? "spacetime-cli" : "none";
}

async function lookup(): Promise<string> {
  if (process.env.STDB_TOKEN) return process.env.STDB_TOKEN;
  return fromCli();
}

function fromCli(): Promise<string> {
  const cli = process.env.SPACETIME_CLI || "spacetime";
  return new Promise((resolve) => {
    execFile(cli, ["login", "show", "--token"], { timeout: 8000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve("");
        return;
      }
      resolve(JWT.exec(`${stdout}\n${stderr}`)?.[0] ?? "");
    });
  });
}
