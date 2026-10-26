/**
 * hooks/src/install.ts
 *
 * WHAT IT'S FOR
 *   One-time setup on each teammate's laptop, so that Claude Code sessions in that laptop's
 *   demo-app clone run our hooks and our MCP server. Run it again if you move either folder;
 *   it replaces its own entries and keeps everything else.
 *
 * OWNER: A.
 * USAGE (from the repo root):
 *   npm run install-hooks -- --demo <path to demo-app clone> --name <you> [--dry-run] [--env-path <path>]
 *   --dry-run   prints every file it would write, and writes nothing
 *   --env-path  which .env gets COWORK_NAME (default: this repo's .env); the end-to-end test uses it.
 *               Not called --env-file on purpose: Node 24 grabs --env-file as its own flag even after
 *               the script name, and fails before this file even runs.
 * DONE WHEN: on a fresh laptop, one command makes /hooks list our hooks and /mcp show "cowork".
 *
 * WHAT IT WRITES
 *   1. <env file>: COWORK_NAME=<you>. Creates the file from .env.example if it doesn't exist yet.
 *   2. <demo>/.claude/settings.local.json: our hooks (hookSettings below) plus
 *      "enabledMcpjsonServers": ["cowork"]. Keys already in the file are kept; our old entries
 *      (any hook pointing into this repo's hooks/src) are replaced, never duplicated.
 *   3. <demo>/.mcp.json: the "cowork" stdio server, `node <tsx cli> <repo>/mcp/src/server.ts`.
 *      Other servers already in the file are kept.
 *   4. <demo>/.git/info/exclude: ".mcp.json" and ".claude/settings.local.json", so neither file
 *      (both hold this laptop's absolute paths) can be committed, without changing the shared .gitignore.
 *
 * WHY .mcp.json AND NOT `claude mcp add`
 *   The user's laptop has no `claude` CLI, only the VS Code extension. Claude Code reads .mcp.json
 *   in both, and enabledMcpjsonServers in settings.local.json pre-approves it. The first time the
 *   folder is opened, Claude Code still asks whether to trust the workspace; answer yes.
 *   (Decided with the user on Oct 24; see checklists/A.md.)
 *
 * WHY EXEC FORM ("command": "node", "args": [path])
 *   No shell, so paths with spaces or backslashes pass through untouched, on Windows and Mac alike.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../../shared/src/config.ts";
import { git } from "../../shared/src/git.ts";

interface HookEntry {
  type?: string;
  command?: string;
  args?: string[];
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [key: string]: unknown;
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
  enabledMcpjsonServers?: string[];
  [key: string]: unknown;
}
interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The hooks block that goes into demo-app/.claude/settings.local.json. */
export function hookSettings(repoRoot: string): { hooks: Record<string, HookGroup[]> } {
  const script = (name: string) => path.join(repoRoot, "hooks", "src", name);
  const run = (name: string, extra: Record<string, unknown>): HookEntry => ({
    type: "command",
    command: "node",
    args: [script(name)],
    ...extra,
  });
  // The listener also starts on every prompt and after cowork's own tools, so an agent that hasn't
  // edited anything yet can be woken by a task (branch feat/orchestrator). Not at SessionStart:
  // Claude Code waits for every SessionStart hook to finish, asyncRewake or not, so a 25-minute
  // listener there leaves the session stuck on "Running start-up hooks" (seen Oct 25).
  const listen = () => run("snapshot-and-wait.ts", { asyncRewake: true, timeout: 1800 });
  return {
    hooks: {
      PostToolUse: [
        { matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|mcp__cowork__.*", hooks: [listen()] },
        { matcher: "*", hooks: [run("inject-context.ts", { timeout: 15 })] },
      ],
      UserPromptSubmit: [{ hooks: [run("inject-context.ts", { timeout: 15 }), listen()] }],
      Stop: [{ hooks: [run("stop.ts", { timeout: 15 })] }],
      SessionStart: [{ hooks: [run("session-start.ts", { timeout: 30 })] }],
    },
  };
}

/** The "cowork" entry for .mcp.json. Throws if `npm run setup` hasn't installed tsx yet. */
export function mcpServerEntry(repoRoot: string): { type: string; command: string; args: string[] } {
  const tsxDir = path.join(repoRoot, "node_modules", "tsx");
  const pkgFile = path.join(tsxDir, "package.json");
  if (!existsSync(pkgFile)) throw new Error("tsx isn't installed. Run `npm run setup` in repo 1 first.");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.tsx;
  if (!bin) throw new Error("Couldn't find tsx's command-line entry in its package.json.");
  return { type: "stdio", command: "node", args: [path.join(tsxDir, bin), path.join(repoRoot, "mcp", "src", "server.ts")] };
}

/** True for a hook entry that points into this repo's hooks/src (one of ours, from any earlier install). */
function isOurHook(entry: HookEntry, hooksDir: string): boolean {
  const parts = [entry.command, ...(entry.args ?? [])].filter((p): p is string => typeof p === "string");
  return parts.some((p) => path.normalize(p).toLowerCase().includes(hooksDir));
}

/** Existing settings with our old hook entries removed, our current ones added, and .mcp.json's cowork enabled. */
export function mergeSettings(existing: Settings, repoRoot: string): Settings {
  const hooksDir = path.normalize(path.join(repoRoot, "hooks", "src")).toLowerCase();
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((entry) => !isOurHook(entry, hooksDir)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(hookSettings(repoRoot).hooks)) {
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  const enabled = [...new Set([...(existing.enabledMcpjsonServers ?? []), "cowork"])];
  return { ...existing, hooks, enabledMcpjsonServers: enabled };
}

/** Sets COWORK_NAME in the .env text, adding the line if it isn't there. */
export function withAgentName(envText: string, name: string): string {
  if (/^COWORK_NAME=.*$/m.test(envText)) return envText.replace(/^COWORK_NAME=.*$/m, `COWORK_NAME=${name}`);
  return `${envText.replace(/\n*$/, "\n")}COWORK_NAME=${name}\n`;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${file} isn't valid JSON. Fix or delete it, then run install again. Nothing was changed.`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      demo: { type: "string" },
      name: { type: "string" },
      "env-path": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const name = values.name ?? "";
  if (!values.demo || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    console.error("Usage: npm run install-hooks -- --demo <path to demo-app clone> --name <a|b|c|d> [--dry-run]");
    console.error("The name is lowercase letters, digits or dashes; it becomes wip/<name>.");
    process.exit(1);
  }

  const repoRoot = config.repoRoot;
  const demoRoot = path.resolve(await git(path.resolve(values.demo), ["rev-parse", "--show-toplevel"]));
  const gitDir = await git(demoRoot, ["rev-parse", "--absolute-git-dir"]);
  if (path.resolve(demoRoot) === path.resolve(repoRoot)) throw new Error("--demo must point at a demo-app clone, not at repo 1.");

  // 1. .env
  const envFile = path.resolve(values["env-path"] ?? path.join(repoRoot, ".env"));
  const example = path.join(repoRoot, ".env.example");
  const envBefore = existsSync(envFile) ? readFileSync(envFile, "utf8") : existsSync(example) ? readFileSync(example, "utf8") : "";
  const envAfter = withAgentName(envBefore, name);

  // 2. settings.local.json
  const settingsFile = path.join(demoRoot, ".claude", "settings.local.json");
  const settings = mergeSettings(readJson<Settings>(settingsFile) ?? {}, repoRoot);

  // 3. .mcp.json
  const mcpFile = path.join(demoRoot, ".mcp.json");
  const mcp = readJson<McpConfig>(mcpFile) ?? {};
  const mcpAfter: McpConfig = { ...mcp, mcpServers: { ...(mcp.mcpServers ?? {}), cowork: mcpServerEntry(repoRoot) } };

  // 4. .git/info/exclude
  const excludeFile = path.join(gitDir, "info", "exclude");
  const excludeBefore = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
  const missing = [".mcp.json", ".claude/settings.local.json"].filter((p) => !excludeBefore.split(/\r?\n/).includes(p));
  const excludeAfter = missing.length
    ? `${excludeBefore.replace(/\n*$/, excludeBefore ? "\n" : "")}# added by Agent Cowork install (per-laptop files)\n${missing.join("\n")}\n`
    : excludeBefore;

  const writes: Array<[string, string]> = [
    [envFile, envAfter],
    [settingsFile, `${JSON.stringify(settings, null, 2)}\n`],
    [mcpFile, `${JSON.stringify(mcpAfter, null, 2)}\n`],
    [excludeFile, excludeAfter],
  ];

  if (values["dry-run"]) {
    for (const [file, text] of writes) console.log(`----- ${file}\n${text}`);
    console.log("Dry run: nothing was written.");
    return;
  }

  for (const [file, text] of writes) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  console.log(`Installed Agent Cowork for "${name}" in ${demoRoot}`);
  console.log(`  ${envFile}: COWORK_NAME=${name}`);
  console.log(`  ${settingsFile}: hooks for PostToolUse, UserPromptSubmit, Stop, SessionStart; MCP server "cowork" enabled`);
  console.log(`  ${mcpFile}: "cowork" MCP server`);
  console.log(`  ${excludeFile}: those two files are ignored by git on this laptop`);
  console.log("Next: open the demo-app folder in Claude Code (VS Code or CLI), trust the workspace when asked,");
  console.log("then run /hooks (our hooks should be listed) and /mcp (cowork should be connected).");
}

try {
  await main();
} catch (error) {
  console.error(`install failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
