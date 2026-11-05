/**
 * scripts/join.ts
 *
 * WHAT IT'S FOR
 *   One command that puts a laptop on the team: tools checked, packages installed, .env filled in,
 *   signed in to SpacetimeDB, the workspace (a clone of the project, always ../workspace) ready with
 *   our hooks and MCP server, checked by doctor, and opened in VS Code. `clean` throws it away; the
 *   next run clones it again in the same place. The project is WORKSPACE_REPO in .env.
 *   run.sh calls it; on PowerShell use `npm run join -- <options>`.
 *
 * USAGE (from repo 1)
 *   ./run.sh                     join as an agent: workspace ../workspace, opened in VS Code
 *   ./run.sh --orchestrator      also run the orchestrator (needs OPENROUTER_API_KEY) and the dashboard
 *   ./run.sh --screen            only the dashboard, no agent (the big screen)
 *   ./run.sh --name ana         your handle the first time without being asked (lowercase, e.g. ana)
 *   ./run.sh --no-open           don't open VS Code / the browser (the window is already open)
 *   ./run.sh clean               shows what it would delete; add --yes to delete it:
 *                                  ../workspace, the orchestrator's clone (.orchestrator/) and your
 *                                  wip/<name> branch on GitHub
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
import { TEAM_DB } from "../shared/src/config.ts";
import { freeHandle, grantCommand, memberProfiles, publicIdentity, slugHandle } from "../shared/src/members.ts";
import { spacetimeCli } from "../shared/src/session-token.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const ENV_FILE = path.join(REPO, ".env");
// TEAM_DB (the team database name) lives in shared/src/config.ts.
const WORKSPACE_REPO_DEFAULT = "https://github.com/catou88/OrkioDemo.git";
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
function runVisible(command: string, args: string[], cwd = REPO, env: NodeJS.ProcessEnv = process.env): boolean {
  const c = shellCommand(command, args);
  return spawnSync(c.command, c.args, { cwd, stdio: "inherit", shell: c.shell, env }).status === 0;
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
/** The one folder the agent works in, always at the same place, next to repo 1. */
const WORKSPACE = path.join(path.dirname(REPO), "workspace");
/** The orchestrator's own clone. It must not be a folder anyone codes in, so it hides inside repo 1 (gitignored). */
const ORCHESTRATOR_CLONE = path.join(REPO, ".orchestrator");
const sameRemote = (a: string, b: string) => a.replace(/\/+$|\.git$/g, "") === b.replace(/\/+$|\.git$/g, "");
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
    if (!runVisible("git", ["clone", "--quiet", "--branch", branch, remote, dir])) stop(`git clone failed. Check that you can open ${remote}. If it says "Permission denied", you do not own the folder ${path.dirname(dir)} (a dev container's /workspaces is owned by root): run  sudo chown "$USER" ${path.dirname(dir)}  and try again.`);
    writeFileSync(markerFile(dir), `Made by repo 1's run.sh (${REPO}) for ${label}. ./run.sh clean deletes this folder.\n`);
    ok(`new workspace: ${dir}`);
  } else {
    if (!ownedByUs(dir)) stop(`${dir} already exists but run.sh didn't make it. Move it away, or delete it yourself, then run again.`);
    const current = git(dir, ["remote", "get-url", "origin"]);
    if (!sameRemote(current, remote)) {
      stop(`${dir} holds ${current}, but WORKSPACE_REPO is now ${remote}. Run ./run.sh clean --yes first; the next ./run.sh clones the new project into the same folder.`);
    }
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

async function fillEnv(nameArg: string | undefined, needName: boolean): Promise<{ name: string; display: string }> {
  step(".env");
  let name = nameArg ?? envValue("COWORK_NAME");
  let display = envValue("COWORK_DISPLAY_NAME");
  if (needName && !name) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question("  What's your name? (like Catherine): ")).trim();
    rl.close();
    display = typed.replace(/[#\r\n"]/g, "");
    name = slugHandle(display);
    if (!name) stop("Type a name with at least one letter or digit.");
    note(`your agent will be called "${name}"`);
  }
  if (needName && !NAME.test(name)) stop(`"${name}" isn't a valid handle: lowercase letters, digits or dashes.`);
  // --name alone (or an old .env with only COWORK_NAME) still works: the display name is the handle, capitalised.
  if (needName && !display) display = name.charAt(0).toUpperCase() + name.slice(1);
  if (name) setEnv("COWORK_NAME", name);
  if (display) setEnv("COWORK_DISPLAY_NAME", display);
  for (const key of ["STDB_DB", "VITE_STDB_DB"]) {
    if (envValue(key) !== TEAM_DB) {
      setEnv(key, TEAM_DB);
      note(`${key} set to ${TEAM_DB}`);
    }
  }
  if (!envValue("VITE_STDB_HOST")) setEnv("VITE_STDB_HOST", envValue("STDB_HOST") || "https://maincloud.spacetimedb.com");
  if (!envValue("MAIN_BRANCH")) setEnv("MAIN_BRANCH", "orchestrator");
  ok(`${name ? `${display ? `${display} as ` : ""}${name}, ` : ""}database ${TEAM_DB}, base branch ${envValue("MAIN_BRANCH")}`);
  return { name, display };
}

/** Signs in, then says who the owner must approve and under which handle. Returns the handle to use. */
async function signIn(name: string, display: string): Promise<string> {
  step("SpacetimeDB sign-in");
  const cli = spacetimeCli();
  let identity = publicIdentity();
  if (!identity) {
    note("not signed in yet: a browser opens for `spacetime login`");
    if (spawnSync(cli, ["login"], { stdio: "inherit" }).status !== 0) stop("spacetime login didn't finish.");
    identity = publicIdentity();
  }
  if (!identity) stop("Still not signed in. Run `spacetime login` yourself, then run this again.");
  ok(`signed in as ${identity}`);
  if (!name) return name;

  // Who is already bound? (Readable only once the owner has approved you and the module has the view.)
  const profiles = await memberProfiles();
  const mine = profiles?.find((profile) => profile.identity === identity);
  if (mine) {
    if (mine.handle !== name) {
      note(`the owner approved you as "${mine.handle}", so that's your agent name; updating .env (was "${name}")`);
      setEnv("COWORK_NAME", mine.handle);
      if (mine.displayName) setEnv("COWORK_DISPLAY_NAME", mine.displayName);
    }
    ok(`approved as ${mine.displayName || mine.handle} (agent "${mine.handle}")`);
    return mine.handle;
  }
  let handle = name;
  if (profiles) {
    const free = freeHandle(name, profiles.map((profile) => profile.handle));
    if (free !== name) {
      note(`"${name}" is already taken by someone else, so you'd be "${free}"`);
      handle = free;
      setEnv("COWORK_NAME", handle);
    }
  }
  console.log(`\n  Not approved yet. Send the database owner this one line (it holds only your public identity, no token):\n\n    ${grantCommand(identity, handle, display || handle, TEAM_DB)}\n`);
  return handle;
}

function doctor(workspace?: string): boolean {
  step("Doctor");
  return runVisible(process.execPath, [path.join(REPO, "scripts", "doctor.ts"), ...(workspace ? ["--demo", workspace] : [])]);
}

function openEditor(dir: string): void {
  step("VS Code");
  if (has("code")) {
    // Started from inside VS Code (an extension, Claude Code), ELECTRON_RUN_AS_NODE is set and would
    // make `code` run as plain Node instead of opening a window.
    const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
    if (!runVisible("code", [dir], REPO, env)) return note(`VS Code didn't open. Open this folder yourself: ${dir}`);
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
  const filled = await fillEnv(values.name, agent);
  const name = await signIn(filled.name, filled.display);

  let workspace: string | undefined;
  if (agent) {
    step("Workspace");
    workspace = WORKSPACE;
    prepareWorkspace(workspace, `agent ${name}`);
    step("Hooks and MCP server");
    if (!runVisible(process.execPath, [path.join(REPO, "hooks", "src", "install.ts"), "--demo", workspace, "--name", name])) {
      stop("Installing the hooks failed.");
    }
  }
  if (values.orchestrator) {
    step("Orchestrator's own clone");
    if (envValue("PLANNER") === "droid" ? !envValue("FACTORY_API_KEY") : !envValue("OPENROUTER_API_KEY")) stop(`The orchestrator needs a model: put OPENROUTER_API_KEY=... in ${ENV_FILE} (or set PLANNER=droid and FACTORY_API_KEY=...), then run this again.`);
    const own = ORCHESTRATOR_CLONE;
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
  const candidates = [WORKSPACE, ORCHESTRATOR_CLONE];
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
  if (path.resolve(envValue("DEMO_REPO_PATH") || "/nonexistent") === path.resolve(ORCHESTRATOR_CLONE)) setEnv("DEMO_REPO_PATH", "");
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
