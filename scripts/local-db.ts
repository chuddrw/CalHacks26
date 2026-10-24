/**
 * scripts/local-db.ts
 *
 * WHAT IT'S FOR
 *   A throwaway SpacetimeDB on this laptop, with Part C's module published and editor accounts for
 *   a, b, c, d, the watcher and the dashboard. For rehearsals, the dashboard and manual tests,
 *   without touching the team database or anyone's `spacetime login`.
 *
 * USAGE
 *   npm run local-db                       start it; Ctrl+C stops it and deletes everything
 *   npm run local-db -- --scene review     also set up a conflict a x b whose fix changed tests
 *                                          (status needs_human), ready for the review buttons
 *   npm run local-db -- --port 3300        fixed port (default: a free one)
 *
 *   It prints the settings to use. Each account's token is in <temp folder>/tokens.json; they are
 *   throwaway keys for this local server only, gone when it stops.
 *
 * OWNER: A. Same server setup as scripts/live-e2e.ts (in memory, throwaway signing keys, module
 * published with --anonymous and a temporary CLI config).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { runKey } from "../shared/src/schema.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const DATABASE = "cowork-local";
const ACCOUNTS = ["a", "b", "c", "d", "watcher", "dashboard"] as const;
const args = process.argv.slice(2);
const scene = args.includes("--scene") ? args[args.indexOf("--scene") + 1] : "";
const fixedPort = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 0;
if (scene && scene !== "review") {
  console.error("Unknown scene. Choose: review");
  process.exit(1);
}

function findBinary(envName: string, base: string): string {
  const exe = process.platform === "win32" ? `${base}.exe` : base;
  const found = [
    process.env[envName] ?? "",
    path.join(process.env.LOCALAPPDATA ?? "", "SpacetimeDB", "bin", "current", exe),
    path.join(os.homedir(), ".local", "share", "spacetime", "bin", "current", exe),
  ].find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error(`Can't find ${exe}. Install the spacetime CLI 2.13.0 or set ${envName}.`);
  return found;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "cowork-local-db-"));
let server: ChildProcess | undefined;
let stopped = false;
function stop(code: number): void {
  if (stopped) return;
  stopped = true;
  server?.kill();
  setTimeout(() => {
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      console.error(`Couldn't delete ${tmp}; delete it by hand.`);
    }
    process.exit(code);
  }, 500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

try {
  const cli = findBinary("SPACETIME_CLI", "spacetimedb-cli");
  const standalone = findBinary("SPACETIMEDB_STANDALONE", "spacetimedb-standalone");
  const port = fixedPort || (await freePort());
  const host = `http://127.0.0.1:${port}`;
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(path.join(tmp, "private.pem"), keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(path.join(tmp, "public.pem"), keys.publicKey.export({ type: "spki", format: "pem" }));
  server = spawn(standalone, [
    "start", "--listen-addr", `127.0.0.1:${port}`, "--data-dir", path.join(tmp, "data"), "--in-memory", "--non-interactive",
    "--jwt-priv-key-path", path.join(tmp, "private.pem"), "--jwt-pub-key-path", path.join(tmp, "public.pem"),
  ], { stdio: "ignore", windowsHide: true });
  server.on("exit", (code) => {
    if (!stopped) {
      console.error(`The local server stopped (code ${code}).`);
      stop(1);
    }
  });
  const started = Date.now();
  while (!(await fetch(`${host}/v1/ping`).catch(() => null))?.ok) {
    if (Date.now() - started > 20_000) throw new Error("The local server didn't start within 20 s.");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const newIdentity = async () => (await (await fetch(`${host}/v1/identity`, { method: "POST" })).json()) as { identity: string; token: string };
  const owner = await newIdentity();
  const accounts = Object.fromEntries(await Promise.all(ACCOUNTS.map(async (name) => [name, await newIdentity()] as const)));

  console.log("Publishing Part C's module (about a minute the first time)...");
  const publish = spawnSync(cli, [
    "--config-path", path.join(tmp, "cli.toml"), "publish", DATABASE, "--module-path", path.join(repoRoot, "module"),
    "--server", host, "--anonymous", "--delete-data=never", "--yes=remote,skip-login,break-clients",
  ], { encoding: "utf8", env: { ...process.env, ACCESS_OWNER_IDENTITY: owner.identity }, timeout: 300_000, windowsHide: true });
  if (publish.status !== 0) throw new Error(`publish failed:\n${publish.stderr.slice(-800)}`);

  const call = async (token: string, reducer: string, callArgs: unknown[]) => {
    const res = await fetch(`${host}/v1/database/${DATABASE}/call/${reducer}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(callArgs),
    });
    if (!res.ok) throw new Error(`${reducer}: ${res.status} ${await res.text()}`);
  };
  for (const name of ACCOUNTS) await call(owner.token, "grant_access", [accounts[name].identity, "editor"]);
  writeFileSync(path.join(tmp, "tokens.json"), JSON.stringify(Object.fromEntries(ACCOUNTS.map((n) => [n, accounts[n].token])), null, 2));

  if (scene === "review") {
    const w = accounts.watcher.token;
    await call(w, "post_snapshot", ["a", "a-ms", "base", ["src/users/user.ts"], "-  u.lastLogin = Math.floor(at.getTime() / 1000);\n+  u.lastLogin = at.getTime();"]);
    await call(w, "post_snapshot", ["b", "b-idle", "base", ["src/sessions/idle.ts"], "+  return (now.getTime() / 1000 - user.lastLogin) / 60;"]);
    await call(w, "post_intent", ["a", "Switching User.lastLogin to milliseconds because the frontend needs ms.", ["src/users/user.ts"], ["User.lastLogin"]]);
    const red = runKey(["a-ms", "b-idle"]);
    const error = "FAIL src/sessions/idle.test.ts > minutesSinceLastLogin > counts minutes since login\nAssertionError: expected -29850839249 to be 31";
    await call(w, "report_check", [red, ["a", "b"], "red", error]);
    await call(w, "report_conflict", ["pair", "a", "b", "src/users/user.ts:14", "src/sessions/idle.ts:4", error, "b", red]);
    await call(w, "post_snapshot", ["b", "b-test-edit", "base", ["src/sessions/idle.test.ts"], "-    expect(minutesSinceLastLogin(u, later)).toBe(31);\n+    expect(minutesSinceLastLogin(u, later)).toBeLessThan(0);"]);
    await call(w, "flag_needs_human", [1, "The fix changed tests: src/sessions/idle.test.ts. A person needs to confirm the tests are still right"]);
    await call(w, "report_check", [runKey(["a-ms", "b-test-edit"]), ["a", "b"], "green", "Typecheck and tests pass (with the changed test)."]);
  }

  console.log(`
Local SpacetimeDB is running: ${host}, database "${DATABASE}"${scene ? `, scene "${scene}"` : ""}.
Accounts a, b, c, d, watcher and dashboard are editors. Their tokens: ${path.join(tmp, "tokens.json")}

Use it from a terminal by setting (process environment, not .env):
  STDB_HOST=${host}  STDB_DB=${DATABASE}  STDB_TOKEN=<that account's token>
Dashboard:
  VITE_STDB_HOST=${host}  VITE_STDB_DB=${DATABASE}  STDB_TOKEN=<dashboard token>  npm run ui

Ctrl+C stops the server and deletes ${tmp}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  stop(1);
}
