/**
 * scripts/live-e2e.ts
 *
 * WHAT IT'S FOR
 *   The whole system on a real SpacetimeDB 2.13 server, the way the demo runs: A's real hooks and
 *   MCP server, B's real watcher, and C's real module with its access rules. It plays the demo
 *   scenario (b writes the idle feature in seconds, a switches lastLogin to milliseconds, b gets
 *   woken, pulls a's change, fixes it) and checks every hand-off between the parts, with timings.
 *
 * OWNER: A (written for the A+B+C integration, Oct 24).
 * USAGE: npm run test:live          needs the spacetime CLI 2.13.0 installed (it uses the CLI's
 *        spacetimedb-standalone server binary). SPACETIME_CLI and SPACETIMEDB_STANDALONE can point at
 *        the binaries if they aren't in the default install folder. Takes about 2 minutes.
 *
 * ISOLATION, LIKE PART C'S OWN NETWORK TEST (module/tests/run-network.mjs)
 *   - A temporary in-memory server on a free localhost port, with throwaway signing keys.
 *   - Development identities from that server; the module is published with --anonymous and a
 *     temporary CLI config, so your own `spacetime login` and the team database are never touched.
 *   - No model calls: the Droid and Anthropic keys are blanked, so the diagnosis step reports
 *     "unavailable" (that still exercises the B-to-C diagnosis bridge).
 *   - Everything lives in one temp folder that is deleted at the end, pass or fail.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Columns, type TableName, type TableRows } from "../shared/src/schema.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const DATABASE = "cowork-live-e2e";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function findBinary(envName: string, base: string): string {
  const exe = process.platform === "win32" ? `${base}.exe` : base;
  const candidates = [
    process.env[envName] ?? "",
    path.join(process.env.LOCALAPPDATA ?? "", "SpacetimeDB", "bin", "current", exe),
    path.join(os.homedir(), ".local", "share", "spacetime", "bin", "current", exe),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
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

const tmp = mkdtempSync(path.join(os.tmpdir(), "cowork-live-"));
const children: ChildProcess[] = [];
let watcherPid = 0;
let client: Client | undefined;

function startProcess(args: string[], env: Record<string, string>, cwd = repoRoot): { child: ChildProcess; output: () => string; done: Promise<number | null> } {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  children.push(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const done = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { child, output: () => output, done };
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await sleep(200);
  }
}

try {
  // ---- 1. A temporary real server, identities, C's module, roles ---------------------------------
  const cli = findBinary("SPACETIME_CLI", "spacetimedb-cli");
  const standalone = findBinary("SPACETIMEDB_STANDALONE", "spacetimedb-standalone");
  const port = await freePort();
  const host = `http://127.0.0.1:${port}`;
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(path.join(tmp, "private.pem"), keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(path.join(tmp, "public.pem"), keys.publicKey.export({ type: "spki", format: "pem" }));
  const server = spawn(standalone, [
    "start", "--listen-addr", `127.0.0.1:${port}`, "--data-dir", path.join(tmp, "data"), "--in-memory", "--non-interactive",
    "--jwt-priv-key-path", path.join(tmp, "private.pem"), "--jwt-pub-key-path", path.join(tmp, "public.pem"),
  ], { stdio: "ignore", windowsHide: true });
  children.push(server);
  await waitFor("the local server", async () => (await fetch(`${host}/v1/ping`).catch(() => null))?.ok, 20_000);
  check("local SpacetimeDB 2.13 server is up", true, host);

  const newIdentity = async () => (await (await fetch(`${host}/v1/identity`, { method: "POST" })).json()) as { identity: string; token: string };
  const [owner, watcherId, agentA, agentB] = await Promise.all([newIdentity(), newIdentity(), newIdentity(), newIdentity()]);

  const published = Date.now();
  const publish = spawnSync(cli, [
    "--config-path", path.join(tmp, "cli.toml"), "publish", DATABASE, "--module-path", path.join(repoRoot, "module"),
    "--server", host, "--anonymous", "--delete-data=never", "--yes=remote,skip-login,break-clients",
  ], { encoding: "utf8", env: { ...process.env, ACCESS_OWNER_IDENTITY: owner.identity }, timeout: 180_000, windowsHide: true });
  check("C's module publishes to the local server", publish.status === 0, publish.status === 0 ? `${((Date.now() - published) / 1000).toFixed(0)} s` : publish.stderr.slice(-400));
  if (publish.status !== 0) throw new Error("publish failed");

  const call = async (token: string, reducer: string, args: unknown[]) => {
    const res = await fetch(`${host}/v1/database/${DATABASE}/call/${reducer}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`${reducer}: ${res.status} ${await res.text()}`);
  };
  const rows = async <T extends TableName>(table: T): Promise<TableRows[T][]> => {
    const res = await fetch(`${host}/v1/database/${DATABASE}/sql`, {
      method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "text/plain" }, body: `SELECT * FROM ${table}`,
    });
    if (!res.ok) throw new Error(`sql ${table}: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as Array<{ rows: unknown[][] }>;
    const columns: readonly string[] = Columns[table];
    return (data[0]?.rows ?? []).map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])) as unknown as TableRows[T]);
  };
  for (const who of [watcherId, agentA, agentB]) await call(owner.token, "grant_access", [who.identity, "editor"]);
  check("owner grants editor to the watcher, a and b (C's access rules)", true);

  // ---- 2. B's fixture repos and B's real watcher -------------------------------------------------
  const fixture = path.join(tmp, "fixture");
  const base = { STDB_HOST: host, STDB_DB: DATABASE, GIT_REMOTE: "origin", MAIN_BRANCH: "main", FACTORY_API_KEY: "", ANTHROPIC_API_KEY: "" };
  const setup = spawnSync(process.execPath, [tsxCli, "watcher/src/fixture.ts", "setup", "--dir", fixture], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...base, STDB_TOKEN: owner.token }, timeout: 300_000, windowsHide: true,
  });
  check("B's fixture builds the repos (bare remote, watcher clone, a, b, c)", setup.status === 0, setup.status === 0 ? "" : (setup.stderr || setup.stdout).slice(-400));
  if (setup.status !== 0) throw new Error("fixture setup failed");

  // `node --import tsx` keeps the watcher in one process; tsx's CLI would start a child that a
  // Windows kill() can't reach, leaving a stray watcher behind.
  const watcher = startProcess(["--import", "tsx", "watcher/src/index.ts"], {
    ...base, STDB_TOKEN: watcherId.token, DEMO_REPO_PATH: path.join(fixture, "watcher"), CHECK_DEBOUNCE_MS: "300", DIAGNOSE_WITH: "claude",
  });
  watcherPid = watcher.child.pid ?? 0;
  await waitFor("the watcher to connect", () => watcher.output().includes("connected to SpacetimeDB"), 30_000);
  check("B's watcher connects as its own approved identity", true);

  const startHook =(agent: string, token: string, script: string, input: object, listenerMinutes: string) => {
    const run = startProcess([path.join(repoRoot, "hooks", "src", script)], { ...base, STDB_TOKEN: token, COWORK_NAME: agent, LISTENER_MINUTES: listenerMinutes, COWORK_DEBUG: "1" });
    run.child.stdin?.end(JSON.stringify(input));
    return run;
  };
  const editInput = (agent: string) => ({ hook_event_name: "PostToolUse", tool_name: "Edit", cwd: path.join(fixture, agent) });
  const editFile = (agent: string, file: string, from: string, to: string) => {
    const target = path.join(fixture, agent, file);
    const before = readFileSync(target, "utf8");
    // Clones on Windows check files out with CRLF (core.autocrlf), so match the file's line endings.
    const eol = before.includes("\r\n") ? "\r\n" : "\n";
    const [find, replace] = [from, to].map((text) => text.replace(/\n/g, eol)) as [string, string];
    if (!before.includes(find)) throw new Error(`${file} doesn't contain the text to replace`);
    writeFileSync(target, before.replace(find, replace));
  };

  // ---- 3. b writes the idle feature (seconds); A's hook snapshots it and stays as the listener --------
  writeFileSync(path.join(fixture, "b", "src/sessions/idle.ts"), [
    'import type { User } from "../contracts/user";', "",
    "export function minutesSinceLastLogin(u: User, now: Date): number {",
    "  return Math.floor((now.getTime() / 1000 - u.lastLogin) / 60);", "}", "",
  ].join("\n"));
  writeFileSync(path.join(fixture, "b", "src/sessions/idle.test.ts"), [
    'import { describe, expect, it } from "vitest";', 'import { createUser, recordLogin } from "../users/user";', 'import { minutesSinceLastLogin } from "./idle";', "",
    'describe("minutesSinceLastLogin", () => {', '  it("counts minutes since login", () => {',
    '    const u = recordLogin(createUser("u1", "Ada"), new Date("2026-10-24T12:00:00Z"));',
    '    expect(minutesSinceLastLogin(u, new Date("2026-10-24T12:31:00Z"))).toBe(31);', "  });", "});", "",
  ].join("\n"));
  const bListener = startHook("b", agentB.token, "snapshot-and-wait.ts", editInput("b"), "4");
  const bSnap = await waitFor("b's snapshot row", async () => (await rows("snapshot")).find((s) => s.agent === "b"), 20_000);
  check("A's hook posts b's snapshot to C's module", true, bSnap.sha.slice(0, 8));
  await waitFor("b to check green", async () => (await rows("agent")).find((x) => x.name === "b")?.status === "green", 90_000);
  check("B's watcher checks b alone: green", true);

  // ---- 4. a switches lastLogin to milliseconds; the watcher must catch the clash ----------------------
  await call(agentA.token, "post_intent", ["a", "Switching User.lastLogin to milliseconds because the frontend needs ms.", ["src/users/user.ts"], ["User.lastLogin"]]);
  editFile("a", "src/contracts/user.ts", "in seconds since the Unix epoch", "in milliseconds since the Unix epoch");
  editFile("a", "src/users/user.ts", "Math.floor(at.getTime() / 1000)", "at.getTime()");
  editFile("a", "src/users/user.test.ts", "toBe(1792843200)", "toBe(1792843200000)");
  editFile("a", "src/sessions/session.ts",
    "const elapsedSeconds = now.getTime() / 1000 - u.lastLogin;\n  return elapsedSeconds > SESSION_TIMEOUT_MINUTES * 60;",
    "const elapsedMs = now.getTime() - u.lastLogin;\n  return elapsedMs > SESSION_TIMEOUT_MINUTES * 60_000;");
  editFile("a", "src/analytics/activity.ts",
    "const sinceSeconds = since.getTime() / 1000;\n  return users.filter((u) => u.lastLogin >= sinceSeconds).length;",
    "return users.filter((u) => u.lastLogin >= since.getTime()).length;");
  editFile("a", "src/api/routes.ts", "lastLoginMs: u.lastLogin * 1000", "lastLoginMs: u.lastLogin");
  const aEdited = Date.now();
  startHook("a", agentA.token, "snapshot-and-wait.ts", editInput("a"), "0.1");

  const bCode = await Promise.race([bListener.done, sleep(120_000).then(() => "timeout" as const)]);
  const wakeSeconds = ((Date.now() - aEdited) / 1000).toFixed(1);
  check("b's listener (A) is woken by the conflict (exit code 2)", bCode === 2, `code ${bCode}, ${wakeSeconds} s after a's edit`);
  check("the wake message names b the fixer and says to pull a's change", bListener.output().includes("[cowork] CONFLICT #") && bListener.output().includes('pull_teammate tool with "a"'));
  check("the wake message gives a's plan, so b knows why a changed it", bListener.output().includes("a's plan: Switching User.lastLogin to milliseconds"));
  const conflict = (await rows("conflict")).find((c) => c.pair === "a+b");
  check("C's module recorded one pair conflict a x b, fixer b", conflict?.kind === "pair" && conflict.fixer === "b" && conflict.status === "open", conflict ? `${conflict.locA} x ${conflict.locB}` : "no conflict row");
  check("the error is the failing idle test", (conflict?.error ?? "").includes("expected"), (conflict?.error ?? "").split("\n")[0]?.slice(0, 90));
  const steps = await waitFor("diagnosis steps", async () => {
    const all = (await rows("diagnosis_step")).filter((s) => s.conflictId === conflict?.id);
    return all.some((s) => s.kind === "error" || s.kind === "final") ? all : undefined;
  }, 60_000).catch(() => []);
  check("B's diagnosis bridge ran C's runner (steps recorded; no API keys, so 'unavailable')", steps.length > 0, steps.map((s) => s.kind).join(", "));

  const stop = startHook("b", agentB.token, "stop.ts", { hook_event_name: "Stop", stop_hook_active: false, cwd: path.join(fixture, "b") }, "1");
  await stop.done;
  check("A's Stop hook keeps the fixer on task", stop.output().includes('"decision":"block"'));

  // ---- 5. A's MCP server for b: presence over WebSocket, then pull_teammate --------------------------
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, path.join(repoRoot, "mcp", "src", "server.ts")],
    cwd: path.join(fixture, "b"),
    env: { ...(Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"))), ...base, STDB_TOKEN: agentB.token, COWORK_NAME: "b" },
    stderr: "pipe",
  });
  client = new Client({ name: "cowork-live-e2e", version: "0.0.0" });
  await client.connect(transport);
  const online = await waitFor("b online", async () => (await rows("agent")).find((x) => x.name === "b")?.online === true, 20_000).catch(() => false);
  check("A's MCP server shows b online through a live WebSocket (C's register_agent)", online === true);
  const pulled = await client.callTool({ name: "pull_teammate", arguments: { agent: "a" } });
  const pulledText = ((pulled as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join(" ");
  check("pull_teammate brings a's in-progress change into b's clone", pulledText.startsWith("Pulled a's"), pulledText.slice(0, 80));

  // ---- 6. b fixes its own file; the watcher turns green and C's guarded reducer resolves ---------------
  editFile("b", "src/sessions/idle.ts", "(now.getTime() / 1000 - u.lastLogin) / 60", "(now.getTime() - u.lastLogin) / 60_000");
  const fixedAt = Date.now();
  startHook("b", agentB.token, "snapshot-and-wait.ts", editInput("b"), "0.1");
  const resolved = await waitFor("the conflict to resolve", async () => (await rows("conflict")).find((c) => c.id === conflict?.id)?.status === "resolved", 120_000).catch(() => false);
  check("the conflict resolves after b's fix (resolve_conflict_if_current)", resolved === true, `${((Date.now() - fixedAt) / 1000).toFixed(1)} s after the fix`);
  const agents = await rows("agent");
  check("a and b are green again", ["a", "b"].every((name) => agents.find((x) => x.name === name)?.status === "green"), agents.map((x) => `${x.name}:${x.status}`).join(" "));

  await client.close();
  client = undefined;
  const offline = await waitFor("b offline", async () => (await rows("agent")).find((x) => x.name === "b")?.online === false, 20_000).catch(() => false);
  check("closing the MCP session marks b offline (C's client_disconnected)", offline === true);
} catch (error) {
  failures++;
  console.log(`FAIL  test stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client?.close().catch(() => undefined);
  for (const child of children) if (child.exitCode === null) child.kill();
  await sleep(1500);
  // The watcher was stopped from outside, so remove the worktrees it left in the OS temp folder.
  if (watcherPid) {
    for (const name of readdirSync(os.tmpdir()).filter((n) => n.startsWith(`cowork-${watcherPid}-`))) {
      rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  check("temp folders removed", !existsSync(tmp) && !readdirSync(os.tmpdir()).some((n) => watcherPid && n.startsWith(`cowork-${watcherPid}-`)));
  console.log(failures === 0 ? "\nAll live checks passed." : `\n${failures} live check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}
