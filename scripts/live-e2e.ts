/**
 * scripts/live-e2e.ts
 *
 * WHAT IT'S FOR
 *   The whole system on a real SpacetimeDB 2.13 server, the way the demo runs (branch
 *   feat/orchestrator): C's real module with its access rules, the orchestrator, and A's real hooks
 *   and MCP server for agents a and b, on B's fixture repos with real git, tsc and vitest. It plays
 *   the demo story and checks every hand-off, with timings:
 *     1. b builds the idle feature (seconds). b's check_with_team: green.
 *     2. a's human asks for milliseconds (ask_orchestrator). The orchestrator publishes its plan
 *        (scripted here: no model calls) and the contract rule asks b's, c's and d's humans to review.
 *     3. The reviews are approved (what the dashboard buttons call). b's listener wakes b with its
 *        task and the flagged conflict a x b.
 *     4. a changes the unit in its own files and tells b (message_teammate), which wakes b.
 *     5. b pulls a's change, adapts sessions, and agrees on a green check; that wakes a.
 *     6. a agrees too: their work passes together, so the conflict resolves and the fact goes into
 *        shared memory. Both complete their tasks; the request is done.
 *
 * OWNER: A (rewritten for the orchestrator; the first version tested the watcher, Oct 24).
 * USAGE: npm run test:live          needs the spacetime CLI 2.13.0 installed (it uses the CLI's
 *        spacetimedb-standalone server binary). SPACETIME_CLI and SPACETIMEDB_STANDALONE can point at
 *        the binaries if they aren't in the default install folder. Takes a few minutes: the fixture
 *        runs npm install once, and every check_with_team runs real tsc and vitest.
 *
 * ISOLATION, LIKE PART C'S OWN NETWORK TEST (module/tests/run-network.mjs)
 *   - A temporary in-memory server on a free localhost port, with throwaway signing keys.
 *   - Development identities from that server; the module is published with --anonymous and a
 *     temporary CLI config, so your own `spacetime login` and the team database are never touched.
 *   - No model calls: the orchestrator publishes a scripted plan (COWORK_PLAN_FILE) and the API keys
 *     are blanked.
 *   - Everything lives in one temp folder that is deleted at the end, pass or fail, and the OS temp
 *     folder is compared before and after, so no worktree is left behind.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

const tempBefore = new Set(readdirSync(os.tmpdir()).filter((name) => name.startsWith("cowork-")));
const tmp = mkdtempSync(path.join(os.tmpdir(), "cowork-live-"));
const children: ChildProcess[] = [];
const clients: Client[] = [];
const links: string[] = [];

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

const textOf = (result: unknown) => ((result as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");

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
  const [owner, orchestratorId, agentA, agentB] = await Promise.all([newIdentity(), newIdentity(), newIdentity(), newIdentity()]);

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
  for (const who of [orchestratorId, agentA, agentB]) await call(owner.token, "grant_access", [who.identity, "editor"]);
  check("owner grants editor to the orchestrator, a and b (C's access rules)", true);

  // ---- 2. B's fixture repos; node_modules for the agents' own checks -------------------------------
  const fixture = path.join(tmp, "fixture");
  const base = { STDB_HOST: host, STDB_DB: DATABASE, GIT_REMOTE: "origin", MAIN_BRANCH: "main", FACTORY_API_KEY: "", ANTHROPIC_API_KEY: "" };
  const setup = spawnSync(process.execPath, ["--import", "tsx", "checks/src/fixture.ts", "setup", "--dir", fixture], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...base, STDB_TOKEN: owner.token }, timeout: 300_000, windowsHide: true,
  });
  check("B's fixture builds the repos (bare remote, a clean clone, a, b, c) with cowork.owners.json", setup.status === 0 && existsSync(path.join(fixture, "watcher", "cowork.owners.json")), setup.status === 0 ? "" : (setup.stderr || setup.stdout).slice(-400));
  if (setup.status !== 0) throw new Error("fixture setup failed");
  // check_with_team runs tsc and vitest from the agent's own clone; link the installed ones in.
  for (const agent of ["a", "b"]) {
    const link = path.join(fixture, agent, "node_modules");
    symlinkSync(path.join(fixture, "watcher", "node_modules"), link, process.platform === "win32" ? "junction" : "dir");
    links.push(link);
  }

  // ---- 3. The orchestrator, and both agents' MCP servers -------------------------------------------
  const planFile = path.join(tmp, "plan.json");
  writeFileSync(planFile, JSON.stringify({
    summary: "a stores lastLogin in milliseconds and updates analytics and the API; b adapts sessions and the idle feature.",
    tasks: [
      { agent: "a", title: "Store User.lastLogin in milliseconds", details: "Contract, recordLogin and its test, plus the analytics and API callers.",
        files: ["src/contracts/user.ts", "src/users/user.ts", "src/users/user.test.ts", "src/analytics/activity.ts", "src/api/routes.ts"], major: true },
      { agent: "b", title: "Read lastLogin as milliseconds in sessions", details: "session.ts and the in-progress idle.ts.", files: ["src/sessions/session.ts", "src/sessions/idle.ts"], major: false },
    ],
    reviews: [],
    conflicts: [{ agentA: "a", agentB: "b", topic: "lastLogin unit", details: "b's in-progress idle.ts assumes seconds", suggested: "b" }],
  }));
  // `node --import tsx` keeps it in one process, so kill() reaches it on Windows.
  const orchestrator = startProcess(["--import", "tsx", "orchestrator/src/index.ts"], {
    ...base, STDB_TOKEN: orchestratorId.token, DEMO_REPO_PATH: path.join(fixture, "watcher"), COWORK_PLAN_FILE: planFile, COWORK_NAME: "",
  });
  await waitFor("the orchestrator to start", () => orchestrator.output().includes("planning for"), 30_000);
  check("the orchestrator starts as its own approved identity", true);

  const envOf = (agent: string, token: string) => ({ ...base, STDB_TOKEN: token, COWORK_NAME: agent });
  const mcpFor = async (agent: string, token: string) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, path.join(repoRoot, "mcp", "src", "server.ts")],
      cwd: path.join(fixture, agent),
      env: { ...(Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"))), ...envOf(agent, token) },
      stderr: "pipe",
    });
    const client = new Client({ name: `cowork-live-${agent}`, version: "0.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  };
  const [mcpA, mcpB] = await Promise.all([mcpFor("a", agentA.token), mcpFor("b", agentB.token)]);
  const online = await waitFor("a and b online", async () => (await rows("agent")).filter((x) => x.online).length === 2, 20_000).catch(() => false);
  check("both MCP servers show their agent online through a live WebSocket (C's register_agent)", online === true);

  const hook = (agent: string, token: string, input: object, listenerMinutes: string) => {
    const run = startProcess([path.join(repoRoot, "hooks", "src", "snapshot-and-wait.ts")], { ...envOf(agent, token), LISTENER_MINUTES: listenerMinutes, COWORK_DEBUG: "1" });
    run.child.stdin?.end(JSON.stringify(input));
    return run;
  };
  const edited = (agent: string) => ({ hook_event_name: "PostToolUse", tool_name: "Edit", cwd: path.join(fixture, agent) });
  const listen = (agent: string) => ({ hook_event_name: "UserPromptSubmit", cwd: path.join(fixture, agent) });
  const editFile = (agent: string, file: string, from: string, to: string) => {
    const target = path.join(fixture, agent, file);
    const before = readFileSync(target, "utf8");
    // Clones on Windows check files out with CRLF (core.autocrlf), so match the file's line endings.
    const eol = before.includes("\r\n") ? "\r\n" : "\n";
    const [find, replace] = [from, to].map((text) => text.replace(/\n/g, eol)) as [string, string];
    if (!before.includes(find)) throw new Error(`${file} doesn't contain the text to replace`);
    writeFileSync(target, before.replace(find, replace));
  };
  const timed = async <T>(work: () => Promise<T>) => {
    const started = Date.now();
    const value = await work();
    return { value, seconds: ((Date.now() - started) / 1000).toFixed(1) };
  };

  // ---- 4. b builds the idle feature in seconds; its own check is green -------------------------------
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
  const bListener = hook("b", agentB.token, edited("b"), "4");
  await waitFor("b's snapshot row", async () => (await rows("snapshot")).find((s) => s.agent === "b"), 20_000);
  const bFirst = await timed(async () => textOf(await mcpB.callTool({ name: "check_with_team", arguments: {} })));
  check("b's check_with_team: green alone (real git, tsc and vitest in b's clone)", bFirst.value.includes("your change alone: green"), `${bFirst.seconds} s`);

  // ---- 5. a's human asks the orchestrator for milliseconds -------------------------------------------
  const asked = textOf(await mcpA.callTool({ name: "ask_orchestrator", arguments: { request: "The frontend needs User.lastLogin in milliseconds since the Unix epoch." } }));
  check("ask_orchestrator stores a's request", asked.includes("Sent to the orchestrator as request #"), asked.slice(0, 60));
  const askedAt = Date.now();
  const request = await waitFor("the plan", async () => (await rows("request")).find((r) => r.status !== "new" && r.status !== "planning"), 60_000);
  check("the orchestrator publishes the plan and holds it for review", request.status === "waiting_review", `${request.status}, ${((Date.now() - askedAt) / 1000).toFixed(1)} s`);
  const reviews = (await rows("review")).filter((r) => r.requestId === request.id);
  check("the contract rule asks b's, c's and d's humans (their code imports the contract or is touched)", reviews.map((r) => r.reviewer).sort().join(",") === "b,c,d", reviews.map((r) => r.reviewer).join(","));
  check("the plan's steps are in the database for the dashboard", (await rows("plan_step")).some((s) => s.requestId === request.id && s.detail.startsWith("Rule: ")));

  // ---- 6. Approvals (the dashboard buttons call decide_review); both agents are woken with their tasks --
  // a's session has never edited anything: its session-start listener is what wakes it.
  const aListener = hook("a", agentA.token, { hook_event_name: "SessionStart", cwd: path.join(fixture, "a") }, "1");
  await sleep(1500);
  for (const review of reviews) await call(owner.token, "decide_review", [review.id, true, "ok"]);
  const approvedAt = Date.now();
  const bCode = await Promise.race([bListener.done, sleep(30_000).then(() => "timeout" as const)]);
  check("b's listener wakes b once every review is approved (exit code 2)", bCode === 2, `code ${bCode}, ${((Date.now() - approvedAt) / 1000).toFixed(1)} s`);
  check("b's wake has its task and the conflict with a", bListener.output().includes("TASK #") && bListener.output().includes("Read lastLogin as milliseconds in sessions") && bListener.output().includes("CONFLICT #") && bListener.output().includes("with a."));
  const aCode = await Promise.race([aListener.done, sleep(30_000).then(() => "timeout" as const)]);
  check("a's session-start listener wakes a with its task", aCode === 2 && aListener.output().includes("Store User.lastLogin in milliseconds"), `code ${aCode}, ${((Date.now() - approvedAt) / 1000).toFixed(1)} s`);
  const conflict = (await rows("conflict")).find((c) => c.pair === "a+b" && c.status === "open");
  check("the flagged conflict a x b is open (potential, b suggested)", conflict?.kind === "potential" && conflict.fixer === "b", conflict ? `#${conflict.id}` : "none");
  const conflictId = conflict?.id ?? 0;

  // ---- 7. a changes the unit in its files (not sessions: those are b's) and tells b ---------------------
  editFile("a", "src/contracts/user.ts", "in seconds since the Unix epoch", "in milliseconds since the Unix epoch");
  editFile("a", "src/users/user.ts", "Math.floor(at.getTime() / 1000)", "at.getTime()");
  editFile("a", "src/users/user.test.ts", "toBe(1792843200)", "toBe(1792843200000)");
  editFile("a", "src/analytics/activity.ts",
    "const sinceSeconds = since.getTime() / 1000;\n  return users.filter((u) => u.lastLogin >= sinceSeconds).length;",
    "return users.filter((u) => u.lastLogin >= since.getTime()).length;");
  editFile("a", "src/api/routes.ts", "lastLoginMs: u.lastLogin * 1000", "lastLoginMs: u.lastLogin");
  await hook("a", agentA.token, edited("a"), "0").done;
  const aFirst = await timed(async () => textOf(await mcpA.callTool({ name: "check_with_team", arguments: {} })));
  check("a's check: a's change alone fails (b's sessions still read seconds)", aFirst.value.includes("your change alone: RED") && aFirst.value.includes("session"), `${aFirst.seconds} s`);
  const bHears = hook("b", agentB.token, listen("b"), "1");
  await sleep(1500);
  await mcpA.callTool({ name: "message_teammate", arguments: { conflictId, message: "I switched User.lastLogin to milliseconds in contracts, users, analytics and api. Please read ms in session.ts and idle.ts; pull my change first." } });
  const heardCode = await Promise.race([bHears.done, sleep(15_000).then(() => "timeout" as const)]);
  check("a's message wakes b", heardCode === 2 && bHears.output().includes("a says:") && bHears.output().includes("pull my change first"), `code ${heardCode}`);

  // ---- 8. b pulls a's change, adapts sessions, and agrees on a green check -----------------------------
  const pulled = textOf(await mcpB.callTool({ name: "pull_teammate", arguments: { agent: "a" } }));
  check("pull_teammate brings a's in-progress change into b's clone", pulled.startsWith("Pulled a's"), pulled.slice(0, 80));
  editFile("b", "src/sessions/session.ts",
    "const elapsedSeconds = now.getTime() / 1000 - u.lastLogin;\n  return elapsedSeconds > SESSION_TIMEOUT_MINUTES * 60;",
    "const elapsedMs = now.getTime() - u.lastLogin;\n  return elapsedMs > SESSION_TIMEOUT_MINUTES * 60_000;");
  editFile("b", "src/sessions/idle.ts", "(now.getTime() / 1000 - u.lastLogin) / 60", "(now.getTime() - u.lastLogin) / 60_000");
  await hook("b", agentB.token, edited("b"), "0").done;
  const aHears = hook("a", agentA.token, listen("a"), "2");
  await sleep(1500);
  const bAgree = await timed(async () => textOf(await mcpB.callTool({ name: "agree", arguments: { conflictId, fact: "User.lastLogin is milliseconds since the Unix epoch." } })));
  check("b's agree runs the check (green with a) and sends the agreement", bAgree.value.includes("Sent your agreement to a") && bAgree.value.includes("with a: green"), `${bAgree.seconds} s`);
  const aHeardCode = await Promise.race([aHears.done, sleep(15_000).then(() => "timeout" as const)]);
  check("b's agreement wakes a", aHeardCode === 2 && aHears.output().includes("b agrees:"), `code ${aHeardCode}`);

  // ---- 9. a agrees: the two pass together, so the conflict resolves -----------------------------------
  const aAgree = await timed(async () => textOf(await mcpA.callTool({ name: "agree", arguments: { conflictId, fact: "User.lastLogin is milliseconds since the Unix epoch." } })));
  check("a's check: fails alone but passes together with b (a coordinated change)", aAgree.value.includes("passes together with b"), `${aAgree.seconds} s`);
  check("both agreed on a green check: the conflict is resolved", aAgree.value.includes("Resolved") && (await rows("conflict")).find((c) => c.id === conflictId)?.status === "resolved");
  check("the agreed fact is verified shared memory", (await rows("intent")).some((i) => i.verified && i.summary === "User.lastLogin is milliseconds since the Unix epoch."));
  const messages = (await rows("message")).filter((m) => m.conflictId === conflictId).map((m) => `${m.author}:${m.kind}`);
  check("the thread shows the conversation", messages.join(" ") === "orchestrator:message a:message b:agree a:agree", messages.join(" "));

  // ---- 10. Both finish their tasks; the request is done -------------------------------------------------
  const tasks = (await rows("task")).filter((t) => t.requestId === request.id);
  const doneA = textOf(await mcpA.callTool({ name: "complete_task", arguments: { taskId: tasks.find((t) => t.agent === "a")?.id ?? 0, summary: "lastLogin is ms in contracts, users, analytics and api." } }));
  const doneB = textOf(await mcpB.callTool({ name: "complete_task", arguments: { taskId: tasks.find((t) => t.agent === "b")?.id ?? 0, summary: "sessions and idle read ms." } }));
  check("complete_task works for both on a green check", doneA.includes("is done") && doneB.includes("is done"), `${doneA.split("\n").at(-1)} | ${doneB.split("\n").at(-1)}`);
  check("the request is done", (await rows("request")).find((r) => r.id === request.id)?.status === "done");
  const agents = await rows("agent");
  check("a and b are green", ["a", "b"].every((name) => agents.find((x) => x.name === name)?.status === "green"), agents.map((x) => `${x.name}:${x.status}`).join(" "));

  for (const client of clients.splice(0)) await client.close();
  const offline = await waitFor("a and b offline", async () => (await rows("agent")).every((x) => !x.online), 20_000).catch(() => false);
  check("closing the MCP sessions marks a and b offline (C's client_disconnected)", offline === true);
} catch (error) {
  failures++;
  console.log(`FAIL  test stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const client of clients) await client.close().catch(() => undefined);
  await sleep(2000);
  for (const child of children) if (child.exitCode === null) child.kill();
  await sleep(1500);
  // Unlink the node_modules junctions first, so nothing follows them into the installed packages.
  for (const link of links) {
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {
      try {
        rmdirSync(link);
      } catch {
        // already gone
      }
    }
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  const left = readdirSync(os.tmpdir()).filter((name) => name.startsWith("cowork-") && !tempBefore.has(name));
  for (const name of left) rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  check("temp folders removed (nothing new left in the OS temp folder)", !existsSync(tmp) && left.length === 0, left.join(", "));
  console.log(failures === 0 ? "\nAll live checks passed." : `\n${failures} live check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}
