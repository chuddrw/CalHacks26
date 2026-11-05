/**
 * adapters/core/install.ts
 *
 * WHAT IT'S FOR
 *   Shared helpers for each client's installer (adapters/cursor/install.ts, adapters/gemini/install.ts):
 *   the "cowork" MCP server entry, the command line that runs an adapter's hook, JSON config reading,
 *   and appending machine-specific config files to the workspace clone's .git/info/exclude.
 *
 * WHY EXEC FORM AND ABSOLUTE PATHS (same reasoning as hooks/src/install.ts)
 *   The MCP entry is { command: <absolute node>, args: [<tsx cli>, <launcher>, <workspace>] }: no
 *   shell, so paths with spaces pass through untouched. The absolute node path matters for GUI apps
 *   (Cursor) that don't inherit a terminal's PATH. These paths are per-laptop, which is why the
 *   files holding them are excluded from Git.
 *
 * WHY A LAUNCHER (mcp-launch.ts) AND NOT mcp/src/server.ts DIRECTLY
 *   The server uses process.cwd() as the agent's clone. Claude Code starts it in the project folder,
 *   but Cursor's docs don't say which folder a stdio server starts in. The launcher chdirs to the
 *   workspace first and then loads the unchanged server.
 *
 * WHAT IS NEVER EXCLUDED
 *   Adapter SOURCE (adapters/...) is meant to be committed; excludePatterns() refuses those paths.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from '../../shared/src/git.ts';
import { UsageError } from './runtime.ts';

export interface McpEntry { command: string; args: string[]; [key: string]: unknown }

/** Absolute path of tsx's CLI. Throws if `npm run setup` hasn't installed it. */
export function tsxCli(repoRoot: string): string {
  const tsxDir = path.join(repoRoot, 'node_modules', 'tsx');
  const pkgFile = path.join(tsxDir, 'package.json');
  if (!existsSync(pkgFile)) throw new UsageError("tsx isn't installed. Run `npm run setup` in the Orkio repo first.");
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsx;
  if (!bin) throw new UsageError("Couldn't find tsx's command-line entry.");
  return path.join(tsxDir, bin);
}

/** The "cowork" stdio server entry for the existing Orkio MCP server, started in `workspace`. */
export function mcpServerEntry(repoRoot: string, workspace: string, node = process.execPath, tsx = tsxCli(repoRoot)): McpEntry {
  return { command: node, args: [tsx, path.join(repoRoot, 'adapters', 'core', 'mcp-launch.ts'), path.resolve(workspace)] };
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** A POSIX shell command string running `<node> <tsx cli> <hookFile> [args]`, for clients that take a string. */
export function hookCommand(node: string, tsx: string, hookFile: string, args: string[] = []): string {
  return [node, tsx, hookFile, ...args].map(quote).join(' ');
}

/** Parses a JSON config file. Missing => {}. Invalid => throws without changing anything. */
export function readJsonFile(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* fall through */ }
  throw new UsageError(`${path.basename(file)} isn't a valid JSON object. Fix or delete it, then install again. Nothing was changed.`);
}

export function writeJsonFile(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Merges our MCP server into a config's `mcpServers`, keeping every other server and key. */
export function withMcpServer(existing: Record<string, any>, name: string, entry: McpEntry): Record<string, any> {
  return { ...existing, mcpServers: { ...(existing.mcpServers ?? {}), [name]: entry } };
}

/** Exclude text with `patterns` appended once under a comment. Refuses to exclude adapter source. */
export function excludePatterns(text: string, patterns: string[], header: string): string {
  const source = patterns.find(p => /^\/?adapters(\/|$)/.test(p));
  if (source) throw new UsageError(`Refusing to exclude adapter source (${source}); adapters are meant to be committed.`);
  const lines = text.split(/\r?\n/);
  const missing = [...new Set(patterns)].filter(p => !lines.includes(p));
  if (!missing.length) return text;
  return `${text.replace(/\n*$/, text ? '\n' : '')}# ${header}\n${missing.join('\n')}\n`;
}

/** Appends `patterns` to the clone's .git/info/exclude (the common one, so worktrees work too). */
export async function appendExclude(workspace: string, patterns: string[], header: string): Promise<string> {
  const file = path.resolve(workspace, await git(workspace, ['rev-parse', '--git-path', 'info/exclude']));
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const after = excludePatterns(before, patterns, header);
  if (after !== before) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, after);
  }
  return file;
}

/** The workspace clone's top level. Refuses the Orkio repo itself and files Git already tracks. */
export async function resolveWorkspace(repoRoot: string, workspace: string, configFiles: string[]): Promise<string> {
  let root: string;
  try { root = path.resolve(await git(path.resolve(workspace), ['rev-parse', '--show-toplevel'])); }
  catch { throw new UsageError('--workspace must point at a Git clone of the project the agent edits.'); }
  if (root === path.resolve(repoRoot)) throw new UsageError('--workspace must be the project clone, not the Orkio repo.');
  for (const file of configFiles) {
    const tracked = await git(root, ['ls-files', '--', file]).catch(() => '');
    if (tracked) throw new UsageError(`${file} is tracked by Git in the workspace; installing would commit this laptop's paths. Use the client's user-level config instead.`);
  }
  return root;
}
