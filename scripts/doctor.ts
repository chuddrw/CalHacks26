/**
 * scripts/doctor.ts
 *
 * WHAT IT'S FOR
 *   One command that tells a teammate whether their laptop is ready, and what to do if it isn't.
 *   The hooks fail open on purpose (they never block an agent), so a laptop that isn't signed in or
 *   isn't approved by the database owner would otherwise just do nothing, silently. Run this first.
 *
 * OWNER: A. Written during the A+B+C integration (Oct 24).
 * USAGE (from repo 1):  npm run doctor                         this laptop's settings and access
 *                       npm run doctor -- --demo <demo clone>  also the hooks, MCP and git push there
 *
 * WHAT IT CHECKS, IN ORDER
 *   1. Node 24 or newer (the hooks run .ts files directly).
 *   2. repo 1's .env: COWORK_NAME (valid name), STDB_HOST, STDB_DB. Warns if STDB_TOKEN is in .env,
 *      which Part C's access rules don't allow (module/ACCESS.md).
 *   3. The spacetime CLI, its version (Part C uses 2.13.0), and the signed-in public identity. That
 *      identity (never the token) is what you send the database owner to be approved.
 *   4. Read access: SELECT * FROM agent. 401/403 means not signed in or not approved yet.
 *   5. Write access: mark_delivered([]), which changes nothing but needs the Editor role.
 *   6. The deployed module has every reducer this code calls (names from the generated bindings).
 *      A missing one means the owner hasn't published module/ from this branch yet.
 *   7. Droid (warning only; only the watcher laptop needs it): the droid CLI and FACTORY_API_KEY.
 *   8. With --demo: our hooks in .claude/settings.local.json, "cowork" in .mcp.json, and
 *      `git push --dry-run` to wip/<name>, which checks push rights without pushing anything.
 *
 * It never prints a token. Exit code 1 if anything failed.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../shared/src/config.ts";
import { git } from "../shared/src/git.ts";
import { wipBranch } from "../shared/src/schema.ts";
import { tokenSource } from "../shared/src/session-token.ts";
import { callReducer, selectRows } from "../shared/src/stdb-http.ts";

let failed = false;
const pass = (what: string, detail = "") => console.log(`PASS  ${what}${detail ? `: ${detail}` : ""}`);
const warn = (what: string, fix: string) => console.log(`WARN  ${what}\n      -> ${fix}`);
const fail = (what: string, fix: string) => {
  failed = true;
  console.log(`FAIL  ${what}\n      -> ${fix}`);
};

function run(command: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: `${stdout}\n${stderr}`.trim() }),
    );
  });
}

function statusOf(error: unknown): string {
  const match = /failed: (\d{3})/.exec(error instanceof Error ? error.message : String(error));
  return match?.[1] ?? "";
}

const { values } = parseArgs({ options: { demo: { type: "string" } } });

// 1. Node
const major = Number(process.versions.node.split(".")[0]);
if (major >= 24) pass("Node", process.versions.node);
else fail(`Node ${process.versions.node} is too old`, "Install Node 24 or newer.");

// 2. .env
const envFile = path.join(config.repoRoot, ".env");
if (!existsSync(envFile)) fail("repo 1 has no .env", "Copy .env.example to .env and fill in COWORK_NAME, STDB_HOST and STDB_DB.");
if (/^[a-z0-9][a-z0-9_-]*$/.test(config.agent)) pass("COWORK_NAME", config.agent);
else fail("COWORK_NAME is missing or invalid", "Set COWORK_NAME=<lowercase name> in .env (npm run install-hooks does it for you).");
if (config.stdbDb) pass("SpacetimeDB", `${config.stdbHost} / ${config.stdbDb}`);
else fail("STDB_DB is missing", "Set STDB_DB in .env (the team database is agent-cowork; see external/spacetimedb-maincloud.txt).");
if (existsSync(envFile) && /^STDB_TOKEN=.+$/m.test(readFileSync(envFile, "utf8"))) {
  warn("STDB_TOKEN is set in .env", "Remove it: Part C's rules keep tokens out of .env. The tools use your `spacetime login` session.");
}

// 3. CLI, token, identity
const cli = process.env.SPACETIME_CLI || "spacetime";
const version = await run(cli, ["--version"]);
if (version.ok) {
  const v = /\d+\.\d+\.\d+/.exec(version.out)?.[0] ?? version.out.split("\n")[0];
  if (v === "2.13.0") pass("spacetime CLI", v);
  else warn(`spacetime CLI ${v}`, "Part C's module and bindings use 2.13.0. If anything misbehaves, switch to 2.13.0.");
} else {
  fail("spacetime CLI not found", "Install it (PowerShell: iwr https://windows.spacetimedb.com -useb | iex), reopen the terminal, then run `spacetime login`.");
}
const source = await tokenSource();
if (source === "spacetime-cli") pass("session token", "from your `spacetime login` session");
else if (source === "env") warn("session token comes from STDB_TOKEN in the environment", "Fine for tests and a local server; for the team database use `spacetime login`.");
else fail("no session token", "Run `spacetime login` (it opens a browser).");
if (version.ok) {
  const shown = await run(cli, ["login", "show"]);
  const identity = /\b[0-9a-f]{64}\b/i.exec(shown.out)?.[0];
  if (identity) pass("public identity (send this to the database owner)", identity);
  else warn("couldn't read your public identity", "Run `spacetime login show` yourself and send the owner the identity it prints. Never send `login show --token`.");
}

// 4 + 5. Access
if (config.stdbDb) {
  try {
    const agents = await selectRows("agent");
    pass("read access", `${agents.length} agent row(s) visible`);
    try {
      await callReducer("mark_delivered", [[]]);
      pass("write access (Editor)");
    } catch (error) {
      fail(`no write access (${statusOf(error) || "error"})`, "Ask the database owner to grant your public identity the editor role (module/ACCESS.md).");
    }
  } catch (error) {
    const status = statusOf(error);
    if (status === "401" || status === "403") {
      fail(`the database refused you (${status})`, "Sign in with `spacetime login`, then send your public identity to the owner for approval (module/ACCESS.md).");
    } else {
      fail("can't reach the database", `${error instanceof Error ? error.message : String(error)}. Check STDB_HOST and your network.`);
    }
  }
}

// 6. The deployed module has every reducer this code calls (the generated bindings list them).
if (config.stdbDb) {
  const bindings = readFileSync(path.join(config.repoRoot, "shared", "module_bindings", "index.ts"), "utf8");
  const expected = [...bindings.matchAll(/__reducerSchema\("([a-z_]+)"/g)].map((match) => match[1] ?? "");
  try {
    const url = `${config.stdbHost.replace(/\/$/, "")}/v1/database/${encodeURIComponent(config.stdbDb)}/schema?version=9`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const schema = (await res.json()) as { reducers?: Array<{ name?: string }> };
    const deployed = new Set((schema.reducers ?? []).map((reducer) => reducer.name));
    const missing = expected.filter((name) => !deployed.has(name));
    if (missing.length === 0) pass("deployed module is up to date", `all ${expected.length} reducers this code calls are on ${config.stdbDb}`);
    else fail(`the deployed module is older than this code (missing: ${missing.join(", ")})`, "The database owner publishes module/ from this branch: npm run publish:cloud --prefix module (module/README.md).");
  } catch (error) {
    warn("couldn't read the deployed module's schema", `${error instanceof Error ? error.message : String(error)}. Check STDB_HOST and your network.`);
  }
}

// 7. Droid, for the diagnosis. Only the laptop that runs the watcher needs it.
if (config.diagnoseWith === "droid") {
  const droid = await run(process.platform === "win32" ? "where" : "which", ["droid"]);
  if (droid.ok && config.factoryApiKey) pass("Droid", "droid CLI found and FACTORY_API_KEY set (needed on the watcher laptop only)");
  else {
    warn(
      `Droid isn't ready here (${[droid.ok ? "" : "no droid CLI", config.factoryApiKey ? "" : "no FACTORY_API_KEY"].filter(Boolean).join(", ")})`,
      "Only the watcher laptop needs it. Install the CLI (PowerShell: irm https://app.factory.ai/cli/windows | iex; Mac: curl -fsSL https://app.factory.ai/cli | sh), then put FACTORY_API_KEY=<key> in repo 1's .env.",
    );
  }
}

// 8. Demo clone
if (values.demo) {
  const demo = path.resolve(values.demo);
  const settingsFile = path.join(demo, ".claude", "settings.local.json");
  const hooksDir = path.join(config.repoRoot, "hooks", "src").toLowerCase();
  const settingsText = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "";
  if (settingsText && JSON.stringify(JSON.parse(settingsText)).toLowerCase().includes(JSON.stringify(hooksDir).slice(1, -1).toLowerCase())) {
    pass("hooks installed", settingsFile);
  } else {
    fail("hooks aren't installed in that clone", `npm run install-hooks -- --demo ${values.demo} --name ${config.agent || "<you>"}`);
  }
  const mcpFile = path.join(demo, ".mcp.json");
  const mcpText = existsSync(mcpFile) ? readFileSync(mcpFile, "utf8") : "";
  if (mcpText.includes('"cowork"')) pass("MCP server registered", mcpFile);
  else fail("MCP server isn't registered", "The same install-hooks command writes .mcp.json.");
  if (config.agent) {
    try {
      await git(demo, ["push", "--dry-run", "--quiet", "--force", config.gitRemote, `HEAD:refs/heads/${wipBranch(config.agent)}`], { timeoutMs: 20_000 });
      pass("git push rights", `${config.gitRemote} ${wipBranch(config.agent)} (dry run, nothing pushed)`);
    } catch (error) {
      fail("can't push to the demo repo", `${error instanceof Error ? error.message.split("\n")[0] : String(error)}. Ask for write access, or sign in to git.`);
    }
  }
}

console.log(failed ? "\nNot ready yet: fix the FAIL lines above, then run npm run doctor again." : "\nThis laptop is ready.");
process.exitCode = failed ? 1 : 0;
