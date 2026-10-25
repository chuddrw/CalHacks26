/**
 * hooks/test/e2e.ts
 *
 * WHAT IT'S FOR
 *   The end-to-end test for everything role A built, with no real SpacetimeDB and no GitHub: a
 *   throwaway bare git remote, clones of demo-app standing in for the laptops, and
 *   scripts/mock-stdb.ts as the database. It runs the real hook scripts and the real MCP server the
 *   way Claude Code does (JSON on stdin, exit codes, stdout and stderr) and checks the "done when"
 *   lines in checklists/A.md, with timings. Since branch feat/orchestrator it also runs the
 *   orchestrator (with a scripted plan, no model) and the agent-to-agent conflict thread: request,
 *   plan, contract rule, review, task wakeups, messages, escalation and the humans' decision.
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
import { pullerOf, runKey } from "../../shared/src/schema.ts";
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
let clientC: Client | undefined;

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
  // Part C's rule: a conflict needs a red check covering both agents already in the database.
  const pairKeyAB = runKey([snapA.sha, snapB.sha]);
  const conflictArgs = [
    "pair", "a", "b", "src/users/user.ts:23", "src/sessions/idle.ts:4",
    "FAIL src/sessions/idle.test.ts\nAssertionError: expected -29850839249 to be 31", "b", pairKeyAB,
  ];
  const rejected = await callReducer(mock, "report_conflict", conflictArgs).then(() => false, () => true);
  check("report_conflict without a red check is rejected (Part C rule)", rejected && !db.conflict.some((c) => c.pair === "a+b"));
  await callReducer(mock, "report_check", [pairKeyAB, ["a", "b"], "red", "1 failed: src/sessions/idle.test.ts"]);
  await callReducer(mock, "post_intent", ["a", "Switching User.lastLogin to milliseconds because the frontend needs ms.", ["src/users/user.ts"], ["User.lastLogin"]]);
  const reportedAt = Date.now();
  await callReducer(mock, "report_conflict", conflictArgs);
  const b1Run = await b1.done;
  const wakeMs = Date.now() - reportedAt;
  check("idle agent b is woken (exit code 2)", b1Run.code === 2, `code ${b1Run.code}`);
  check("wake arrives within 3 s of report_conflict", wakeMs <= 3000, `${wakeMs} ms`);
  check("wake message opens the conflict with a", b1Run.stderr.includes("[cowork] CONFLICT #") && b1Run.stderr.includes("with a."));
  check("wake message tells b to call pull_teammate", b1Run.stderr.includes('pull_teammate("a")'));
  check("wake message says b and a decide who changes what", b1Run.stderr.includes("Suggested: you adapt") && b1Run.stderr.includes("message_teammate("));
  check("wake message gives a's plan, so b knows why a changed it", b1Run.stderr.includes("a's plan: Switching User.lastLogin to milliseconds"));
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
  const selfKeyA = runKey([snapA.sha]);
  await callReducer(mock, "report_check", [selfKeyA, ["a"], "red", "error TS2322: example"]);
  await callReducer(mock, "report_conflict", ["self", "a", "", "src/users/user.ts:23", "", "error TS2322: example", "a", selfKeyA]);
  const inject4 = await startHook("inject-context.ts", { hook_event_name: "PostToolUse", cwd: cloneA }, envFor("a")).done;
  check("with no listener alive, inject-context delivers the conflict itself", contextOf(inject4).includes("[cowork] CONFLICT #"));

  // ---- 5. stop ----------------------------------------------------------------------------------
  const stop1 = await startHook("stop.ts", { hook_event_name: "Stop", stop_hook_active: false, cwd: cloneB }, envFor("b")).done;
  const decision = stop1.stdout.trim() ? (JSON.parse(stop1.stdout) as { decision?: string; reason?: string }) : {};
  check("Stop is blocked while b owes a reply in its open conflict", decision.decision === "block" && (decision.reason ?? "").includes("isn't yours"));
  const stop2 = await startHook("stop.ts", { hook_event_name: "Stop", stop_hook_active: true, cwd: cloneB }, envFor("b")).done;
  check("stop_hook_active lets the turn end", stop2.stdout.trim() === "");
  const stop3 = await startHook("stop.ts", { hook_event_name: "Stop", stop_hook_active: false, cwd: cloneC }, envFor("c")).done;
  check("an agent with no conflict can stop", stop3.stdout.trim() === "");

  // ---- 6. session-start -------------------------------------------------------------------------
  // Resolve with Part C's guarded reducer: a green check covering both agents.
  const conflictAB = db.conflict.find((c) => c.pair === "a+b");
  await callReducer(mock, "report_check", [pairKeyAB, ["a", "b"], "green", "all tests passed"]);
  await callReducer(mock, "resolve_conflict_if_current", [
    conflictAB?.id ?? 0, conflictAB?.runKey ?? "", conflictAB?.error ?? "", conflictAB?.fixer ?? "", pairKeyAB,
    "User.lastLogin is milliseconds since the Unix epoch.",
  ]);
  check("resolve_conflict_if_current resolves with current green evidence", db.conflict.find((c) => c.pair === "a+b")?.status === "resolved");
  const start = await startHook("session-start.ts", { hook_event_name: "SessionStart", cwd: cloneC }, envFor("c")).done;
  const startText = contextOf(start);
  check("SessionStart gives the team status with the verified fact", startText.includes("Team status") && startText.includes("User.lastLogin is milliseconds since the Unix epoch."));

  // ---- 6b. a person reviews a fix that changed tests (review_test_change, npm run review) ---------
  // Its own conflict, a x c with fixer c, so the earlier sections stay as they are.
  const latestSha = (agent: string) => db.snapshot.filter((s) => s.agent === agent).at(-1)?.sha ?? "";
  const runReview = (args: string[]) =>
    new Promise<HookRun>((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "review.ts"), ...args], { env: { ...process.env, ...envFor("c") }, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    });
  const aSha = latestSha("a");
  await callReducer(mock, "post_snapshot", ["c", "c-feature", "base", ["src/sessions/report.ts"], ""]);
  const keyAC1 = runKey([aSha, "c-feature"]);
  await callReducer(mock, "report_check", [keyAC1, ["a", "c"], "red", "1 failed: src/sessions/report.test.ts"]);
  await callReducer(mock, "report_conflict", ["pair", "a", "c", "src/users/user.ts:14", "src/sessions/report.ts:9", "FAIL src/sessions/report.test.ts", "c", keyAC1]);
  const conflictAC = db.conflict.find((c) => c.pair === "a+c")!;
  // c "fixes" it by editing the test; the guard flags it, and the combined check is green.
  await callReducer(mock, "post_snapshot", ["c", "c-test-edit", "base", ["src/sessions/report.test.ts"], ""]);
  await callReducer(mock, "flag_needs_human", [conflictAC.id, "The fix changed tests: src/sessions/report.test.ts"]);
  const keyAC2 = runKey([aSha, "c-test-edit"]);
  await callReducer(mock, "report_check", [keyAC2, ["a", "c"], "green", "all tests passed"]);
  const listed = await runReview([]);
  check("npm run review lists the conflict waiting for a person", listed.code === 0 && listed.stdout.includes(`#${conflictAC.id}`), listed.stdout.split("\n")[0]);

  const sentBack = await runReview([String(conflictAC.id), "reject", "keep", "the", "31-minute", "test"]);
  check("send back reopens the conflict", sentBack.code === 0 && conflictAC.status === "open", sentBack.stdout.trim() || sentBack.stderr.trim());
  await callReducer(mock, "resolve_conflict_if_current", [conflictAC.id, conflictAC.runKey, conflictAC.error, conflictAC.fixer, keyAC2, ""]);
  check("the green check from the sent-back fix can't resolve it", conflictAC.status === "open");

  const cWake = await startHook("snapshot-and-wait.ts", edit("c", cloneC), envFor("c", "0.2")).done;
  check("the fixer is woken (exit code 2)", cWake.code === 2, `code ${cWake.code}`);
  check("the wake message says a person sent the fix back, and why", cWake.stderr.includes("A person sent your fix") && cWake.stderr.includes("keep the 31-minute test"));

  // c changes tests again; this time the person accepts the change.
  await callReducer(mock, "post_snapshot", ["c", "c-test-edit-2", "base", ["src/sessions/report.test.ts"], ""]);
  await callReducer(mock, "flag_needs_human", [conflictAC.id, "The fix changed tests: src/sessions/report.test.ts"]);
  const redApprove = await runReview([String(conflictAC.id), "approve"]);
  check("approve is refused while no green check covers the newest snapshots", redApprove.code === 1 && conflictAC.status === "needs_human", `code ${redApprove.code}, ${conflictAC.status}: ${redApprove.stderr.trim()}`);
  await callReducer(mock, "report_check", [runKey([aSha, "c-test-edit-2"]), ["a", "c"], "green", "all tests passed"]);
  const approved = await runReview([String(conflictAC.id), "approve", "the", "old", "test", "assumed", "seconds"]);
  check("approve resolves it once the check is green", approved.code === 0 && conflictAC.status === "resolved", approved.stdout.trim() || approved.stderr.trim());
  check("both agents hear that a person approved it", ["a", "c"].every((agent) => db.inbox.some((r) => r.agent === agent && r.message.includes("approved the test change"))));

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
  const expectedTools = ["agree", "ask_orchestrator", "check_with_team", "complete_task", "escalate", "get_full_stack", "message_teammate", "post_intent", "pull_teammate", "team_status"];
  check("MCP server lists its 10 tools", JSON.stringify(tools) === JSON.stringify(expectedTools), tools.join(", "));
  await waitFor("register_agent from the MCP server", () => mock!.calls.some((c) => c.reducer === "register_agent" && c.args[0] === "b"), 5000);
  check("MCP server marks b online", db.agent.find((x) => x.name === "b")?.online === true);

  const textOf = (result: unknown) =>
    ((result as { content?: Array<{ type: string; text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
  const intentsBefore = db.intent.length;
  await client.callTool({ name: "post_intent", arguments: { summary: "Adding minutesSinceLastLogin.", files: ["src/sessions/idle.ts"] } });
  check("post_intent stores the intent", db.intent.length === intentsBefore + 1 && db.intent.at(-1)?.agent === "b");
  check("post_intent sends a heads-up to the others", db.inbox.some((r) => r.agent === "a" && r.kind === "heads_up" && r.message.includes("b plans:")));
  const status = textOf(await client.callTool({ name: "team_status", arguments: {} }));
  check("team_status returns the team picture", status.includes("Team status") && status.includes("User.lastLogin is milliseconds"));

  const pulled = textOf(await client.callTool({ name: "pull_teammate", arguments: { agent: "a" } }));
  const bUserFile = readFileSync(path.join(cloneB, "src", "users", "user.ts"), "utf8");
  check("pull_teammate applies a's in-progress change", pulled.startsWith("Pulled a's") && bUserFile.includes("user.lastLogin = at.getTime();"), pulled.slice(0, 80));
  check("a hears that b pulled its change", db.inbox.some((r) => r.agent === "a" && r.kind === "info" && pullerOf(r.message) === "b"));
  check("pull_teammate leaves b's own new file alone", existsSync(path.join(cloneB, "src", "sessions", "idle.ts")));
  const again = textOf(await client.callTool({ name: "pull_teammate", arguments: { agent: "a" } }));
  check("pulling twice is safe", again.includes("already in your working tree"), again.slice(0, 80));
  const nobody = textOf(await client.callTool({ name: "pull_teammate", arguments: { agent: "zed" } }));
  check("pulling an agent with no snapshot explains why", nobody.includes("has no snapshot yet"));
  const noStack = textOf(await client.callTool({ name: "get_full_stack", arguments: {} }));
  check("get_full_stack says when there's no full stack yet", noStack.includes("no full stack yet") && !existsSync(`${cloneB}-full-stack`), noStack.slice(0, 80));

  // ---- 9. orchestrator: c's human asks; Droid's plan (scripted here); the contract rule; review ----
  // The orchestrator's own clone, with cowork.owners.json on main (demo-app has it).
  const orchestratorClone = await clone("orchestrator");
  const cTransport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, path.join(repoRoot, "mcp", "src", "server.ts")],
    cwd: cloneC,
    env: { ...baseEnv, ...envFor("c") },
    stderr: "pipe",
  });
  clientC = new Client({ name: "cowork-e2e-c", version: "0.0.0" });
  await clientC.connect(cTransport);
  // a is online too (its session would be), so the online rule leaves the plan as Droid made it.
  await callReducer(mock, "register_agent", ["a"]);
  const asked = textOf(await clientC.callTool({ name: "ask_orchestrator", arguments: { request: "The frontend needs User.lastLogin in milliseconds." } }));
  const request = db.request.at(-1);
  check("ask_orchestrator stores c's request", request?.agent === "c" && request.status === "new" && asked.includes(`request #${request.id}`), asked.slice(0, 60));

  const planFile = path.join(tmp, "plan.json");
  writeFileSync(planFile, JSON.stringify({
    summary: "a stores lastLogin in milliseconds; b reads milliseconds in sessions.",
    tasks: [
      { agent: "a", title: "Store User.lastLogin in milliseconds", details: "Contract comment and recordLogin.", files: ["src/contracts/user.ts", "src/users/user.ts"], major: false },
      { agent: "b", title: "Read lastLogin as milliseconds in sessions", details: "session.ts and idle.ts.", files: ["src/sessions/session.ts"], major: false },
    ],
    reviews: [],
    conflicts: [{ agentA: "a", agentB: "b", topic: "lastLogin unit", details: "b's in-progress idle.ts assumes seconds", suggested: "b" }],
  }));
  const orchestrator = spawn(process.execPath, [tsxCli, path.join(repoRoot, "orchestrator", "src", "index.ts")], {
    env: { ...process.env, ...envFor("orchestrator"), DEMO_REPO_PATH: orchestratorClone, COWORK_PLAN_FILE: planFile, COWORK_FULL_STACK: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  running.add(orchestrator);
  let orchestratorLog = "";
  orchestrator.stdout.on("data", (chunk: Buffer) => (orchestratorLog += chunk.toString()));
  orchestrator.stderr.on("data", (chunk: Buffer) => (orchestratorLog += chunk.toString()));
  const planned = await waitFor("the orchestrator's plan", () => (request && request.status !== "new" && request.status !== "planning" ? request : undefined), 30_000).catch(() => undefined);
  check("the orchestrator plans the request and holds it for review", planned?.status === "waiting_review", planned?.status ?? orchestratorLog.slice(-300));
  const tasks = db.task.filter((t) => t.requestId === request?.id);
  check("one task per owner, both held", tasks.map((t) => `${t.agent}:${t.status}`).join(",") === "a:waiting_review,b:waiting_review");
  check("the contract rule marks a's contract change major", tasks.find((t) => t.agent === "a")?.major === true);
  const reviews = db.review.filter((r) => r.requestId === request?.id);
  check("the rule asks b's human to review (b's sessions import the contract)", reviews.length === 1 && reviews[0]?.reviewer === "b" && reviews[0].summary.includes("src/sessions/session.ts"), reviews.map((r) => r.reviewer).join(","));
  const steps = db.plan_step.filter((step) => step.requestId === request?.id).map((step) => step.detail);
  check("the plan steps show the scripted plan and the rule's decision", steps.some((d) => d.includes("Scripted plan")) && steps.some((d) => d.startsWith("Rule: ")), String(steps.length));
  check("nobody is woken before the review", !db.inbox.some((r) => r.kind === "task" && tasks.some((t) => t.id === r.conflictId)));

  // b's human approves on the dashboard (the dashboard calls decide_review).
  await callReducer(mock, "decide_review", [reviews[0]?.id ?? 0, true, "sessions will follow"]);
  check("approval releases both tasks", db.task.filter((t) => t.requestId === request?.id).every((t) => t.status === "assigned") && request?.status === "assigned");
  const flagged = db.conflict.find((c) => c.kind === "potential" && c.pair === "a+b" && c.status === "open");
  check("approval opens the flagged conflict a x b", flagged !== undefined && flagged.fixer === "b");

  // a is idle and never edited in this session: the SessionStart listener wakes it with both.
  const aWakeStarted = Date.now();
  const aWake = await startHook("snapshot-and-wait.ts", { hook_event_name: "SessionStart", cwd: cloneA, session_id: "a" }, envFor("a", "0.2")).done;
  check("a session-start listener wakes a (exit code 2)", aWake.code === 2, `code ${aWake.code}, ${Date.now() - aWakeStarted} ms`);
  check("a's wake carries its task and the conflict thread", aWake.stderr.includes("TASK #") && aWake.stderr.includes("Store User.lastLogin in milliseconds") && aWake.stderr.includes(`CONFLICT #${flagged?.id} with b`), aWake.stderr.slice(0, 120));
  check("a's wake says who asked and how to finish", aWake.stderr.includes("Asked by c's human") && aWake.stderr.includes("complete_task("));
  check("the session-start listener didn't snapshot anything", db.snapshot.filter((x) => x.agent === "a").length === 1);

  // ---- 10. the two agents talk it out --------------------------------------------------------------
  const conflictId = flagged?.id ?? 0;
  const said = textOf(await client.callTool({ name: "message_teammate", arguments: { conflictId, message: "My idle.ts divides by 1000. Push your change and I'll switch to milliseconds." } }));
  check("message_teammate sends b's message", said.includes("Sent to a") && db.message.some((m) => m.conflictId === conflictId && m.author === "b"));
  const aHears = await startHook("snapshot-and-wait.ts", { hook_event_name: "UserPromptSubmit", cwd: cloneA, session_id: "a" }, envFor("a", "0.2")).done;
  check("b's message wakes a", aHears.code === 2 && aHears.stderr.includes("b says:") && aHears.stderr.includes("divides by 1000"), aHears.stderr.slice(0, 120));
  const stopA = await startHook("stop.ts", { hook_event_name: "Stop", stop_hook_active: false, cwd: cloneA }, envFor("a")).done;
  check("a can't stop without answering b", (JSON.parse(stopA.stdout || "{}") as { decision?: string }).decision === "block");
  const bTeam = textOf(await client.callTool({ name: "team_status", arguments: {} }));
  check("team_status shows b its task and the open conflict", bTeam.includes("Read lastLogin as milliseconds in sessions") && bTeam.includes(`Conflict #${conflictId} with a is open`));

  // ---- 11. escalation to both humans, and their decision ---------------------------------------------
  const escalated = textOf(await client.callTool({ name: "escalate", arguments: { conflictId, reason: "Sessions are stored in seconds; switching would change the session store." } }));
  check("escalate hands the conflict to both humans", escalated.includes("went to both humans") && db.conflict.find((c) => c.id === conflictId)?.status === "escalated");
  check("both agents hear it went to their humans", ["a", "b"].every((agent) => db.inbox.some((r) => r.agent === agent && r.conflictId === conflictId && r.message.includes("went to both humans"))));
  const refused = textOf(await client.callTool({ name: "message_teammate", arguments: { conflictId, message: "anyone?" } }));
  check("an escalated thread takes no more messages", refused.includes("wait for their decision"));
  const stopB = await startHook("stop.ts", { hook_event_name: "Stop", stop_hook_active: false, cwd: cloneB }, envFor("b")).done;
  check("an escalated conflict doesn't block b's stop (b's open task still nudges once)", (JSON.parse(stopB.stdout || "{}") as { reason?: string }).reason?.includes("Task #") === true);
  await callReducer(mock, "decide_conflict", [conflictId, "Use milliseconds everywhere; b converts at the session store."]);
  check("the humans' decision reopens the conflict", db.conflict.find((c) => c.id === conflictId)?.status === "open");
  const bDecision = await startHook("snapshot-and-wait.ts", { hook_event_name: "UserPromptSubmit", cwd: cloneB, session_id: "b" }, envFor("b", "0.2")).done;
  check("the decision wakes b with what the humans decided", bDecision.code === 2 && bDecision.stderr.includes("Your humans decided") && bDecision.stderr.includes("converts at the session store"), bDecision.stderr.slice(0, 120));
  const notOpen = textOf(await client.callTool({ name: "agree", arguments: { conflictId: 999_999, fact: "x" } }));
  check("agree on an unknown conflict explains", notOpen.includes("no conflict #999999"));
  orchestrator.kill();
} catch (error) {
  failures++;
  console.log(`FAIL  test crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  await client?.close().catch(() => undefined);
  await clientC?.close().catch(() => undefined);
  for (const child of running) child.kill();
  await mock?.close();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  check("temp folder removed", !existsSync(tmp), tmp);
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}
