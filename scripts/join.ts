/**
 * scripts/join.ts
 *
 * WHAT IT'S FOR
 *   One command that puts a laptop on the team: tools checked, packages installed, .env filled in,
 *   signed in to SpacetimeDB, a throwaway workspace (a fresh clone of repo 2) ready with our hooks
 *   and MCP server, checked by doctor, and opened in VS Code. `clean` throws the workspace away.
 *   run.sh calls it; on PowerShell use `npm run join -- <options>`.
 *
 * USAGE (from repo 1)
 *   ./run.sh                     join as an agent: workspace ../cowork-ws-<name>, opened in VS Code
 *   ./run.sh --orchestrator      also run the orchestrator (needs FACTORY_API_KEY) and the dashboard
 *   ./run.sh --screen            only the dashboard, no agent (the big screen)
 *   ./run.sh --name b            your name the first time without being asked (a, b, c, d...)
 *   ./run.sh --no-open           don't open VS Code / the browser (the window is already open)
 *   ./run.sh clean               shows what it would delete; add --yes to delete it:
 *                                  your workspace folder(s) and your wip/<name> branch on GitHub
 *   ./run.sh clean --db --yes    also empties the team database and every wip/* branch
 *                                  (database owner only; run it on one laptop, after everyone's clean)
 *
 * SAFETY
 *   - It only ever deletes folders it created itself: they carry a marker file in .git
 *     (cowork-run-sh). Anything else, repo 1 included, is refused.
 *   - Steps that are already done are skipped, so running it again is safe.
 *   - It never prints a token. The tools use your own `spacetime login` session.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { spacetimeCli } from "../shared/src/session-token.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const ENV_FILE = path.join(REPO, ".env");
const TEAM_DB = "agent-cowork-orch";
const WORKSPACE_REPO_DEFAULT = "https://github.com/chuddrw/CalHacks26-Demo.git";
const MARKER = "cowork-run-sh";
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const WIN = process.platform === "win32";
const UI_URL = "http://localhost:5173/";

// ---- output -----------------------------------------------------------------------------------
const step = (text: string) => console.log(`\n▶ ${text}`);
const ok = (text: string) => console.log(`  ✓ ${text}`);
const note = (text: string) => console.log(`  · ${text}`);
class Stop extends Error {}
const stop = (text: string): never => {
  throw new Stop(text);
};

// ---- running things ---------------------------------------------------------------------------
/** Windows needs a shell for npm and code (they're .cmd files); quote arguments ourselves then. */
function quote(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
function shellCommand(command: string, args: string[]) {
  return WIN ? { command: [command, ...args].map(quote).join(" "), args: [] as string[], shell: true } : { command, args, shell: false };
}
/** Runs a command with its output on screen. Returns whether it succeeded. */
function runVisible(command: string, args: string[], cwd = REPO): boolean {
  const c = shellCommand(command, args);
  return spawnSync(c.command, c.args, { cwd, stdio: "inherit", shell: c.shell }).status === 0;
}
function has(command: string): boolean {
  return spawnSync(WIN ? "where" : "which", [command], { stdio: "ignore" }).status === 0;
}
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// ---- .env -------------------------------------------------------------------------------------
function readEnv(): string {
  if (!existsSync(ENV_FILE)) copyFileSync(path.join(REPO, ".env.example"), ENV_FILE);
  return readFileSync(ENV_FILE, "utf8");
}
function envValue(key: string): string {
  return new RegExp(`^${key}=(.*)$`, "m").exec(readEnv())?.[1]?.trim() ?? "";
}
/** Sets KEY=value in .env, replacing an existing line or adding one. Comments stay. */
function setEnv(key: string, value: string): void {
  const text = readEnv();
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(ENV_FILE, pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, "\n")}${line}\n`);
}

// ---- workspace --------------------------------------------------------------------------------
function workspacePath(name: string): string {
  return path.join(path.dirname(REPO), `cowork-ws-${name}`);
}
function markerFile(dir: string): string {
  return path.join(dir, ".git", MARKER);
}
function ownedByUs(dir: string): boolean {
  return existsSync(markerFile(dir));
}

/** A fresh clone of repo 2 on the team's base branch, or the one made last time, brought up to date. */
function prepareWorkspace(dir: string, label: string): void {
  const branch = envValue("MAIN_BRANCH") || "main";
  const remote = envValue("WORKSPACE_REPO") || WORKSPACE_REPO_DEFAULT;
  if (!existsSync(dir)) {
    note(`cloning ${remote} (${branch}) into ${dir}`);
    if (!runVisible("git", ["clone", "--quiet", "--branch", branch, remote, dir])) stop(`git clone failed. Check that you can open ${remote}.`);
    writeFileSync(markerFile(dir), `Made by repo 1's run.sh (${REPO}) for ${label}. ./run.sh clean deletes this folder.\n`);
    ok(`new workspace: ${dir}`);
  } else {
    if (!ownedByUs(dir)) stop(`${dir} already exists but run.sh didn't make it. Move it away, or delete it yourself, then run again.`);
    git(dir, ["fetch", "--quiet", "origin"]);
    if (git(dir, ["status", "--porcelain"])) {
      note(`${dir} has uncommitted changes from last time; left as it is. (./run.sh clean starts over.)`);
    } else {
      git(dir, ["checkout", "--quiet", branch]);
      git(dir, ["merge", "--quiet", "--ff-only", `origin/${branch}`]);
      ok(`workspace up to date with origin/${branch}: ${dir}`);
    }
  }
  if (!existsSync(path.join(dir, "node_modules"))) {
    note("installing the workspace's test tools (typescript, vitest)");
    // Same versions as the root setup script; nothing is saved to package.json or a lock file.
    if (!runVisible("npm", ["install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "typescript@7", "vitest@5"], dir)) {
      stop("npm install failed in the workspace.");
    }
  }
}

// ---- steps ------------------------------------------------------------------------------------
function checkTools(): void {
  step("Tools");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) stop(`Node ${process.versions.node} is too old. Install Node 24 or newer.`);
  ok(`node ${process.versions.node}`);
  if (!has("git")) stop("git isn't installed.");
  ok("git");
  const cli = spacetimeCli();
  if (spawnSync(cli, ["--version"], { stdio: "ignore" }).status !== 0) {
    stop(WIN
      ? "The spacetime CLI isn't installed. In PowerShell: iwr https://windows.spacetimedb.com -useb | iex   then open a new terminal and run this again."
      : "The spacetime CLI isn't installed: curl -sSf https://install.spacetimedb.com | sh   then open a new terminal and run this again.");
  }
  ok("spacetime CLI");
}

function installPackages(): void {
  step("Packages");
  if (existsSync(path.join(REPO, "node_modules"))) return ok("already installed");
  if (!runVisible("npm", ["ci", "--no-audit", "--no-fund"])) stop("npm ci failed.");
  ok("installed");
}

async function fillEnv(nameArg: string | undefined, needName: boolean): Promise<string> {
  step(".env");
  let name = nameArg ?? envValue("COWORK_NAME");
  if (needName && !name) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    name = (await rl.question("  Your agent name (lowercase, like a, b, c or d): ")).trim().toLowerCase();
    rl.close();
  }
  if (needName && !NAME.test(name)) stop(`"${name}" isn't a valid name: lowercase letters, digits or dashes.`);
  if (name) setEnv("COWORK_NAME", name);
  for (const key of ["STDB_DB", "VITE_STDB_DB"]) {
    if (envValue(key) !== TEAM_DB) {
      setEnv(key, TEAM_DB);
      note(`${key} set to ${TEAM_DB}`);
    }
  }
  if (!envValue("VITE_STDB_HOST")) setEnv("VITE_STDB_HOST", envValue("STDB_HOST") || "https://maincloud.spacetimedb.com");
  if (!envValue("MAIN_BRANCH")) setEnv("MAIN_BRANCH", "orchestrator");
  ok(`${name ? `name ${name}, ` : ""}database ${TEAM_DB}, base branch ${envValue("MAIN_BRANCH")}`);
  return name;
}

function signIn(): void {
  step("SpacetimeDB sign-in");
  const cli = spacetimeCli();
  const shown = spawnSync(cli, ["login", "show"], { encoding: "utf8" });
  let identity = /\b[0-9a-f]{64}\b/i.exec(`${shown.stdout}${shown.stderr}`)?.[0];
  if (!identity) {
    note("not signed in yet: a browser opens for `spacetime login`");
    if (spawnSync(cli, ["login"], { stdio: "inherit" }).status !== 0) stop("spacetime login didn't finish.");
    const again = spawnSync(cli, ["login", "show"], { encoding: "utf8" });
    identity = /\b[0-9a-f]{64}\b/i.exec(`${again.stdout}${again.stderr}`)?.[0];
  }
  if (!identity) stop("Still not signed in. Run `spacetime login` yourself, then run this again.");
  ok(`signed in as ${identity}`);
}

function doctor(workspace?: string): boolean {
  step("Doctor");
  return runVisible(process.execPath, [path.join(REPO, "scripts", "doctor.ts"), ...(workspace ? ["--demo", workspace] : [])]);
}

function openEditor(dir: string): void {
  step("VS Code");
  if (has("code")) {
    runVisible("code", [dir]);
    ok(`opened ${dir}. If VS Code asks whether to trust the folder, say yes, then start Claude Code there.`);
  } else {
    note(`\`code\` isn't on PATH. Open this folder in VS Code yourself: ${dir}`);
  }
}

function openBrowser(url: string): void {
  const [command, args] = WIN ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}

/** Starts the long-running parts with prefixed output; Ctrl+C stops them all. */
function runServices(services: Array<{ label: string; script: string }>, browser: boolean): void {
  step(`Running ${services.map((s) => s.label).join(" + ")} (Ctrl+C stops everything)`);
  const children: ChildProcess[] = [];
  for (const service of services) {
    const c = shellCommand("npm", ["run", service.script]);
    const child = spawn(c.command, c.args, { cwd: REPO, shell: c.shell, stdio: ["ignore", "pipe", "pipe"] });
    const prefix = `[${service.label}] `;
    const relay = (out: NodeJS.WriteStream) => (chunk: Buffer) =>
      out.write(chunk.toString().replace(/\r?\n(?!$)/g, `\n${prefix}`).replace(/^/, prefix));
    child.stdout!.on("data", relay(process.stdout));
    child.stderr!.on("data", relay(process.stderr));
    child.on("exit", (code) => console.log(`${prefix}stopped (${code ?? "signal"})`));
    children.push(child);
  }
  const shutdown = () => {
    for (const child of children) {
      if (child.exitCode !== null || !child.pid) continue;
      // npm under a Windows shell spawns a tree; taskkill /T takes the whole tree down.
      if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGINT");
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (browser) setTimeout(() => openBrowser(UI_URL), 4000);
}

// ---- join -------------------------------------------------------------------------------------
async function join(values: { name?: string; orchestrator?: boolean; screen?: boolean; "no-open"?: boolean }): Promise<void> {
  const agent = !values.screen;
  checkTools();
  installPackages();
  const name = await fillEnv(values.name, agent);
  signIn();

  let workspace: string | undefined;
  if (agent) {
    step("Workspace");
    workspace = workspacePath(name);
    prepareWorkspace(workspace, `agent ${name}`);
    step("Hooks and MCP server");
    if (!runVisible(process.execPath, [path.join(REPO, "hooks", "src", "install.ts"), "--demo", workspace, "--name", name])) {
      stop("Installing the hooks failed.");
    }
  }
  if (values.orchestrator) {
    step("Orchestrator's own clone");
    if (!envValue("FACTORY_API_KEY")) stop(`The orchestrator plans with Droid: put FACTORY_API_KEY=... in ${ENV_FILE}, then run this again.`);
    const own = workspacePath("orchestrator");
    prepareWorkspace(own, "the orchestrator");
    setEnv("DEMO_REPO_PATH", own.replace(/\\/g, "/"));
    ok(`DEMO_REPO_PATH set to ${own}`);
  }

  const healthy = doctor(workspace);
  if (!healthy && agent) stop("Doctor found a problem (the FAIL lines above say what to do). Fix it and run ./run.sh again.");
  if (!healthy) note("Doctor reported a problem; the dashboard may still work read-only.");

  const open = !values["no-open"];
  if (workspace && open) openEditor(workspace);
  const services = [
    ...(values.orchestrator ? [{ label: "orchestrator", script: "orchestrator" }] : []),
    ...(values.orchestrator || values.screen ? [{ label: "dashboard", script: "ui" }] : []),
  ];
  if (services.length) runServices(services, open);
  else console.log("\nDone. Talk to Claude Code in the workspace window. The dashboard: ./run.sh --screen on any laptop.");
}

// ---- clean ------------------------------------------------------------------------------------
function listenerPid(dir: string): number | undefined {
  const file = path.join(dir, ".git", "cowork-listener.pid");
  const pid = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function clean(values: { yes?: boolean; db?: boolean }): Promise<void> {
  const name = envValue("COWORK_NAME");
  const candidates = [name && workspacePath(name), workspacePath("orchestrator")].filter(Boolean) as string[];
  const folders = candidates.filter((dir) => existsSync(dir) && ownedByUs(dir));
  for (const dir of candidates) if (existsSync(dir) && !ownedByUs(dir)) note(`skipping ${dir}: run.sh didn't make it`);
  const gitFrom = folders[0];
  const branches = values.db && gitFrom
    ? git(gitFrom, ["ls-remote", "--heads", "origin", "wip/*"]).split("\n").filter(Boolean).map((line) => line.split("refs/heads/")[1]!)
    : name ? [`wip/${name}`] : [];

  step(values.yes ? "Cleaning up" : "Dry run: nothing is deleted without --yes");
  for (const dir of folders) {
    const changed = git(dir, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
    note(`delete folder ${dir}${changed ? ` (${changed} uncommitted file(s) in it)` : ""}`);
  }
  if (gitFrom) for (const branch of branches) note(`delete branch ${branch} on GitHub`);
  else if (branches.length) note(`no workspace left to reach GitHub from; ${branches.join(", ")} stays`);
  if (values.db) note(`empty the team database ${TEAM_DB} (owner only)`);
  if (!folders.length && !values.db) return note("nothing to clean");
  if (!values.yes) return console.log("\nRun it again with --yes to do it. Close the workspace's VS Code window first.");

  if (gitFrom) {
    for (const branch of branches) {
      try {
        git(gitFrom, ["push", "--quiet", "origin", "--delete", branch]);
        ok(`deleted ${branch}`);
      } catch (error) {
        const stderr = String((error as { stderr?: string }).stderr ?? "");
        if (stderr.includes("remote ref does not exist")) note(`${branch} was already gone`);
        else stop(`Couldn't delete ${branch}: ${stderr.trim()}`);
      }
    }
  }
  if (values.db) {
    const { callReducer } = await import("../shared/src/stdb-http.ts");
    await callReducer("reset_all", [], 30_000);
    ok(`emptied ${TEAM_DB}`);
  }
  for (const dir of folders) {
    const pid = listenerPid(dir);
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      ok(`deleted ${dir}`);
    } catch (error) {
      note(`couldn't delete ${dir} (${error instanceof Error ? error.message : error}). Close VS Code and anything running there, then run clean again.`);
    }
  }
  if (path.resolve(envValue("DEMO_REPO_PATH") || "/nonexistent") === path.resolve(workspacePath("orchestrator"))) setEnv("DEMO_REPO_PATH", "");
}

// ---- main -------------------------------------------------------------------------------------
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      orchestrator: { type: "boolean" },
      screen: { type: "boolean" },
      yes: { type: "boolean" },
      db: { type: "boolean" },
      "no-open": { type: "boolean" },
    },
  });
  if (positionals[0] === "clean") return clean(values);
  if (positionals.length) stop(`Unknown command: ${positionals.join(" ")}. Use ./run.sh, ./run.sh --orchestrator, ./run.sh --screen or ./run.sh clean.`);
  if (values.orchestrator && values.screen) stop("Pick one: --orchestrator already includes the dashboard.");
  return join(values);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  if (!(error instanceof Stop) && error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
