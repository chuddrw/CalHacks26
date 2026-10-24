/**
 * hooks/test/e2e.ts
 *
 * WHAT IT'S FOR
 *   The end-to-end test for everything role A built, with no real SpacetimeDB and no GitHub: a
 *   throwaway bare git remote, clones of demo-app standing in for the laptops, and
 *   scripts/mock-stdb.ts as the database. It runs the real hook scripts and the real MCP server the
 *   way Claude Code does (JSON on stdin, exit codes, stdout and stderr) and checks the "done when"
 *   lines in checklists/A.md, with timings.
 *
 * OWNER: A.
 * USAGE (from the repo root, after `npm run setup`): npm run test:a
 * LEAVES NOTHING BEHIND: everything lives in one temp folder that is deleted at the end, pass or
 *   fail, and the test checks that it's gone.
 * RUN IT AGAIN when C's real module exists: point STDB_HOST/STDB_DB at it instead of the mock.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { git } from "../../shared/src/git.ts";
import { runKey } from "../../shared/src/schema.ts";
import { MOCK_DB_NAME, startMockStdb, type MockStdb } from "../../scripts/mock-stdb.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const hookPath = (name: string) => path.join(repoRoot, "hooks", "src", name);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

const running = new Set<ReturnType<typeof spawn>>();

/** Starts a hook script the way Claude Code does: JSON on stdin, our env vars on top of the real ones. */
function startHook(script: string, input: object, env: Record<string, string>): { done: Promise<HookRun>; started: number } {
  const started = Date.now();
  const child = spawn(process.execPath, [hookPath(script)], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  running.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(JSON.stringify(input));
  const done = new Promise<HookRun>((resolve) =>
    child.on("close", (code) => {
      running.delete(child);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    }),
  );
  return { done, started };
}

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function callReducer(mock: MockStdb, reducer: string, args: unknown[]): Promise<void> {
  const res = await fetch(`${mock.url}/v1/database/${MOCK_DB_NAME}/call/${reducer}`, {
    method: "POST",
    headers: { Authorization: "Bearer e2e", "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${reducer}: ${res.status} ${await res.text()}`);
}

function contextOf(run: HookRun): string {
  if (!run.stdout.trim()) return "";
  const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: { additionalContext?: string; hookEventName?: string } };
  return parsed.hookSpecificOutput?.additionalContext ?? "";
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "cowork-e2e-"));
let mock: MockStdb | undefined;
let client: Client | undefined;

try {
  // ---- setup: a bare remote holding demo-app's baseline, and clones a, b, c --------------------
  const remote = path.join(tmp, "remote.git");
  const identity = ["-c", "user.name=e2e", "-c", "user.email=e2e@localhost"];
  await git(tmp, ["init", "--quiet", "--bare", "-b", "main", remote]);
  const seed = path.join(tmp, "seed");
  await git(tmp, ["clone", "--quiet", remote, seed]);
  const demoSource = path.join(repoRoot, "demo-app");
  cpSync(demoSource, seed, {
    recursive: true,
    filter: (source) => {
      const first = path.relative(demoSource, source).split(path.sep)[0] ?? "";
      return ![".git", "node_modules", ".vitest", ".claude", ".mcp.json"].includes(first);
    },
  });
  await git(seed, [...identity, "add", "-A"]);
  await git(seed, [...identity, "commit", "--quiet", "-m", "baseline"]);
  await git(seed, ["push", "--quiet", "origin", "main"]);
  const clone = async (name: string) => {
    const dir = path.join(tmp, name);
    await git(tmp, ["clone", "--quiet", remote, dir]);
    return dir;
  };
  const cloneA = await clone("a");
  const cloneB = await clone("b");
  const cloneC = await clone("c");

  mock = await startMockStdb({ port: 0, escalateMs: 60_000 });
  const db = mock.db;
  const envFor = (agent: string, listenerMinutes = "0.1"): Record<string, string> => ({
    STDB_HOST: mock!.url,
    STDB_DB: MOCK_DB_NAME,
    STDB_TOKEN: "e2e",
    COWORK_NAME: agent,
    LISTENER_MINUTES: listenerMinutes,
    GIT_REMOTE: "origin",
    MAIN_BRANCH: "main",
    COWORK_DEBUG: "1",
  });
  const edit = (agent: string, cwd: string) => ({ hook_event_name: "PostToolUse", tool_name: "Edit", cwd, session_id: agent });

  // ---- 1. snapshot: A switches lastLogin to milliseconds -----------------------------------------
  const userFile = path.join(cloneA, "src", "users", "user.ts");
  writeFileSync(userFile, readFileSync(userFile, "utf8").replace("Math.floor(at.getTime() / 1000)", "at.getTime()"));
  const logBefore = await git(cloneA, ["log", "--oneline"]);
  const statusBefore = await git(cloneA, ["status", "--porcelain"]);

  const a1 = startHook("snapshot-and-wait.ts", edit("a", cloneA), envFor("a"));
  const snapA = await waitFor("a's snapshot row", () => db.snapshot.find((s) => s.agent === "a"));
  const snapshotMs = snapA.createdAt - a1.started;
  check("snapshot row appears within 2 s of the edit", snapshotMs <= 2000, `${snapshotMs} ms`);
  const remoteWip = (await git(tmp, ["ls-remote", remote, "refs/heads/wip/a"])).split(/\s+/)[0];
  check("wip/a on the remote is the snapshot commit", remoteWip === snapA.sha, remoteWip?.slice(0, 8));
  check("snapshot lists the changed file", snapA.files.includes("src/users/user.ts"), snapA.files.join(", "));
  check("agent a shows as working", db.agent.find((x) => x.name === "a")?.status === "working");
  check("a's git log is unchanged", (await git(cloneA, ["log", "--oneline"])) === logBefore);
  check("a's git status is unchanged", (await git(cloneA, ["status", "--porcelain"])) === statusBefore);
  const gitDirA = path.join(cloneA, ".git");
  const leftovers = readdirSync(gitDirA).filter((f) => f.startsWith("cowork-index") || f === "cowork-snapshot.lock");
  check("no temp index or lock left in .git", leftovers.length === 0, leftovers.join(", "));
  const a1Run = await a1.done;
  check("listener exits 0 after LISTENER_MINUTES with nothing to do", a1Run.code === 0, `code ${a1Run.code}, ${a1Run.ms} ms`);
  check("listener removed its PID file", !existsSync(path.join(gitDirA, "cowork-listener.pid")));

  const a2 = await startHook("snapshot-and-wait.ts", edit("a", cloneA), envFor("a", "0")).done;
  check("no new snapshot when nothing changed", db.snapshot.filter((s) => s.agent === "a").length === 1 && a2.code === 0);

  // ---- 2. wake: B (idle) gets a conflict --------------------------------------------------------
  writeFileSync(
    path.join(cloneB, "src", "sessions", "idle.ts"),
    'import type { User } from "../contracts/user";\n\nexport function minutesSinceLastLogin(user: User, now: Date): number {\n  return Math.floor((now.getTime() / 1000 - user.lastLogin) / 60);\n}\n',
  );
  const b1 = startHook("snapshot-and-wait.ts", edit("b", cloneB), envFor("b", "0.5"));
  const snapB = await waitFor("b's snapshot row", () => db.snapshot.find((s) => s.agent === "b"));
  await waitFor("b's listener", () => existsSync(path.join(cloneB, ".git", "cowork-listener.pid")));
  await sleep(300);
  const reportedAt = Date.now();
  await callReducer(mock, "report_conflict", [
    "pair", "a", "b", "src/users/user.ts:23", "src/sessions/idle.ts:4",
    "FAIL src/sessions/idle.test.ts\nAssertionError: expected -29850839249 to be 31", "b", runKey([snapA.sha, snapB.sha]),
  ]);
  const b1Run = await b1.done;
  const wakeMs = Date.now() - reportedAt;
  check("idle agent b is woken (exit code 2)", b1Run.code === 2, `code ${b1Run.code}`);
  check("wake arrives within 3 s of report_conflict", wakeMs <= 3000, `${wakeMs} ms`);
  check("wake message names b as the fixer", b1Run.stderr.includes("[cowork] CONFLICT #") && b1Run.stderr.includes("you are the fixer"));
  check("wake message tells b to call pull_teammate", b1Run.stderr.includes('pull_teammate tool with "a"'));
  check("b's conflict note is marked delivered", db.inbox.filter((r) => r.agent === "b" && r.kind === "conflict").every((r) => r.delivered));
  check("b's listener removed its PID file", !existsSync(path.join(cloneB, ".git", "cowork-listener.pid")));

  // ---- 3. only the newest listener stays alive --------------------------------------------------
  const l1 = startHook("snapshot-and-wait.ts", edit("b", cloneB), envFor("b", "0.5"));
  await sleep(1500);
  const l2 = startHook("snapshot-and-wait.ts", edit("b", cloneB), envFor("b", "0.05"));
  const l1Run = await l1.done;
  check("an older listener exits as soon as a newer one starts", l1Run.code === 0 && l1Run.ms < 5000, `${l1Run.ms} ms`);
  await l2.done;

  // ---- 4. inject-context ------------------------------------------------------------------------
  await callReducer(mock, "post_intent", ["a", "Changing User.lastLogin from seconds to milliseconds.", ["src/users/user.ts"], ["User.lastLogin"]]);
  const inject1 = await startHook("inject-context.ts", { hook_event_name: "PostToolUse", cwd: cloneB }, envFor("b")).done;
  check("inject-context delivers a's intent to b", contextOf(inject1).includes("a plans: Changing User.lastLogin"));
  const inject2 = await startHook("inject-context.ts", { hook_event_name: "PostToolUse", cwd: cloneB }, envFor("b")).done;
  check("nothing is delivered twice", inject2.stdout.trim() === "" && inject2.code === 0);
  await callReducer(mock, "send_note", ["b", "heads_up", "Prompt-time note"]);
  const inject3 = await startHook("inject-context.ts", { hook_event_name: "UserPromptSubmit", cwd: cloneB }, envFor("b")).done;
  const event3 = inject3.stdout.trim() ? (JSON.parse(inject3.stdout) as { hookSpecificOutput: { hookEventName: string } }).hookSpecificOutput.hookEventName : "";
  check("UserPromptSubmit gets its own event name back", event3 === "UserPromptSubmit");
  await callReducer(mock, "report_conflict", ["self", "a", "", "src/users/user.ts:23", "", "error TS2322: example", "a", "self-a"]);
  const inject4 = await startHook("inject-context.ts", { hook_event_name: "PostToolUse", cwd: cloneA }, envFor("a")).done;
  check("with no listener alive, inject-context delivers the conflict itself", contextOf(inject4).includes("[cowork] CONFLICT #"));

  // ---- 5. stop ----------------------------------------------------------------------------------
  const stop1 = await startHook("stop.ts", { hook_event_name: "Stop", stop_hook_active: false, cwd: cloneB }, envFor("b")).done;
  const decision = stop1.stdout.trim() ? (JSON.parse(stop1.stdout) as { decision?: string; reason?: string }) : {};
  check("Stop is blocked while b's conflict is open", decision.decision === "block" && (decision.reason ?? "").includes("still open"));
  const stop2 = await startHook("stop.ts", { hook_event_name: "Stop", stop_hook_active: true, cwd: cloneB }, envFor("b")).done;
  check("stop_hook_active lets the turn end", stop2.stdout.trim() === "");
  const stop3 = await startHook("stop.ts", { hook_event_name: "Stop", stop_hook_active: false, cwd: cloneC }, envFor("c")).done;
  check("an agent with no conflict can stop", stop3.stdout.trim() === "");

  // ---- 6. session-start -------------------------------------------------------------------------
  const conflictAB = db.conflict.find((c) => c.pair === "a+b");
  await callReducer(mock, "resolve_conflict", [conflictAB?.id ?? 0, "User.lastLogin is milliseconds since the Unix epoch."]);
  const start = await startHook("session-start.ts", { hook_event_name: "SessionStart", cwd: cloneC }, envFor("c")).done;
  const startText = contextOf(start);
  check("SessionStart gives the team status with the verified fact", startText.includes("Team status") && startText.includes("User.lastLogin is milliseconds since the Unix epoch."));

  // ---- 7. install -------------------------------------------------------------------------------
  const oldOurs = { type: "command", command: "node", args: [path.join(repoRoot, "hooks", "src", "old-hook.ts")] };
  mkdirSync(path.join(cloneB, ".claude"), { recursive: true });
  writeFileSync(
    path.join(cloneB, ".claude", "settings.local.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PostToolUse: [{ matcher: "Write", hooks: [oldOurs] }, { matcher: "Edit", hooks: [{ type: "command", command: "echo keep-me" }] }] },
    }),
  );
  const envFile = path.join(tmp, "e2e.env");
  const runInstall = (args: string[]) =>
    new Promise<HookRun>((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [hookPath("install.ts"), ...args], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    });
  const install1 = await runInstall(["--demo", cloneB, "--name", "b", "--env-path", envFile]);
  check("install exits 0", install1.code === 0, install1.stderr.trim());
  const settingsText1 = readFileSync(path.join(cloneB, ".claude", "settings.local.json"), "utf8");
  const settings = JSON.parse(settingsText1) as {
    permissions?: unknown;
    enabledMcpjsonServers?: string[];
    hooks: Record<string, Array<{ hooks: Array<{ command?: string; args?: string[]; asyncRewake?: boolean }> }>>;
  };
  const allEntries = Object.values(settings.hooks).flat().flatMap((g) => g.hooks);
  check("install keeps unrelated settings", JSON.stringify(settings.permissions) === JSON.stringify({ allow: ["Bash(npm test)"] }));
  check("install keeps other people's hooks", allEntries.some((h) => h.command === "echo keep-me"));
  check("install replaces its own old hooks", !allEntries.some((h) => h.args?.some((a) => a.includes("old-hook.ts"))));
  check("install registers the asyncRewake snapshot hook", allEntries.some((h) => h.asyncRewake === true && h.args?.[0]?.endsWith("snapshot-and-wait.ts")));
  check("install enables the cowork MCP server", settings.enabledMcpjsonServers?.includes("cowork") === true);
  const mcpJson = JSON.parse(readFileSync(path.join(cloneB, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { args: string[] }> };
  check(".mcp.json points at mcp/src/server.ts", mcpJson.mcpServers.cowork?.args[1]?.endsWith(path.join("mcp", "src", "server.ts")) === true);
  const exclude = readFileSync(path.join(cloneB, ".git", "info", "exclude"), "utf8");
  check("both per-laptop files are git-excluded", exclude.includes(".mcp.json") && exclude.includes(".claude/settings.local.json"));
  check("COWORK_NAME is written to the env file", /^COWORK_NAME=b$/m.test(readFileSync(envFile, "utf8")));
  await runInstall(["--demo", cloneB, "--name", "b", "--env-path", envFile]);
  const settingsText2 = readFileSync(path.join(cloneB, ".claude", "settings.local.json"), "utf8");
  check("running install twice changes nothing", settingsText2 === settingsText1 && readFileSync(path.join(cloneB, ".git", "info", "exclude"), "utf8") === exclude);
  check("git status ignores both files", !(await git(cloneB, ["status", "--porcelain"])).includes(".mcp.json"));
  const dry = await runInstall(["--demo", cloneC, "--name", "c", "--env-path", path.join(tmp, "dry.env"), "--dry-run"]);
  check("--dry-run writes nothing", dry.code === 0 && !existsSync(path.join(cloneC, ".mcp.json")) && !existsSync(path.join(tmp, "dry.env")));
  rmSync(path.join(cloneB, ".claude"), { recursive: true, force: true });
  rmSync(path.join(cloneB, ".mcp.json"), { force: true });

  // ---- 8. MCP server ----------------------------------------------------------------------------
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, path.join(repoRoot, "mcp", "src", "server.ts")],
    cwd: cloneB,
    env: { ...baseEnv, ...envFor("b") },
    stderr: "pipe",
  });
  client = new Client({ name: "cowork-e2e", version: "0.0.0" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check("MCP server lists its 3 tools", JSON.stringify(tools) === JSON.stringify(["post_intent", "pull_teammate", "team_status"]), tools.join(", "));
  await waitFor("register_agent from the MCP server", () => mock!.calls.some((c) => c.reducer === "register_agent" && c.args[0] === "b"), 5000);
  check("MCP server marks b online", db.agent.find((x) => x.name === "b")?.online === true);

  const textOf = (result: unknown) =>
    ((result as { content?: Array<{ type: string; text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
  const intentsBefore = db.intent.length;
  await client.callTool({ name: "post_intent", arguments: { summary: "Adding minutesSinceLastLogin.", files: ["src/sessions/idle.ts"] } });
  check("post_intent stores the intent", db.intent.length === intentsBefore + 1 && db.intent.at(-1)?.agent === "b");
  check("post_intent sends a heads-up to the others", db.inbox.some((r) => r.agent === "a" && r.kind === "heads_up" && r.message.startsWith("b plans:")));
  const status = textOf(await client.callTool({ name: "team_status", arguments: {} }));
  check("team_status returns the team picture", status.includes("Team status") && status.includes("User.lastLogin is milliseconds"));

  const pulled = textOf(await client.callTool({ name: "pull_teammate", arguments: { agent: "a" } }));
  const bUserFile = readFileSync(path.join(cloneB, "src", "users", "user.ts"), "utf8");
  check("pull_teammate applies a's in-progress change", pulled.startsWith("Pulled a's") && bUserFile.includes("user.lastLogin = at.getTime();"), pulled.slice(0, 80));
  check("pull_teammate leaves b's own new file alone", existsSync(path.join(cloneB, "src", "sessions", "idle.ts")));
  const again = textOf(await client.callTool({ name: "pull_teammate", arguments: { agent: "a" } }));
  check("pulling twice is safe", again.includes("already in your working tree"), again.slice(0, 80));
  const nobody = textOf(await client.callTool({ name: "pull_teammate", arguments: { agent: "zed" } }));
  check("pulling an agent with no snapshot explains why", nobody.includes("has no snapshot yet"));
} catch (error) {
  failures++;
  console.log(`FAIL  test crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  await client?.close().catch(() => undefined);
  for (const child of running) child.kill();
  await mock?.close();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  check("temp folder removed", !existsSync(tmp), tmp);
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}
