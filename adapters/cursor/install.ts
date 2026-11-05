/**
 * adapters/cursor/install.ts
 *
 * WHAT IT'S FOR
 *   One-time setup that connects Cursor's agent, in the workspace clone, to Orkio:
 *     1. <workspace>/.cursor/mcp.json    the "cowork" MCP server (adapters/core/install.ts mcpServerEntry)
 *     2. <workspace>/.cursor/hooks.json  our native hooks (format below), all running adapters/cursor/hook.ts
 *     3. <workspace>/.git/info/exclude   both files, since they hold this laptop's absolute paths
 *   Unrelated servers, hooks and keys are kept; our own earlier entries are replaced, never duplicated.
 *
 * USAGE (from the Orkio repo root)
 *   node --import tsx adapters/cursor/install.ts [--workspace <clone>] [--dry-run]
 *   --workspace defaults to ../workspace, where run.sh clones WORKSPACE_REPO.
 *
 * CURSOR HOOKS FORMAT (https://cursor.com/docs/agent/hooks, checked 2026-10-31)
 *   { "version": 1, "hooks": { "<event>": [{ "command": "...", "timeout": <seconds> }] } }
 *   Project hooks run from the project root and only in a trusted workspace. `command` is a shell
 *   string, so our paths are single-quoted (POSIX shells; see README for Windows).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config } from '../../shared/src/config.ts';
import {
  appendExclude, hookCommand, mcpServerEntry, readJsonFile, resolveWorkspace, tsxCli, withMcpServer, writeJsonFile,
} from '../core/install.ts';
import { UsageError } from '../core/runtime.ts';

/** Our events and their timeouts (seconds). Only events listed in Cursor's hooks docs. */
export const CURSOR_EVENTS: Record<string, number> = {
  sessionStart: 15, beforeSubmitPrompt: 10, postToolUse: 10, afterFileEdit: 10, afterShellExecution: 10, stop: 45,
};
export const CONFIG_FILES = ['.cursor/mcp.json', '.cursor/hooks.json'];
const HOOK_MARK = 'adapters/cursor/hook.ts';

const isOurs = (entry: any) => typeof entry?.command === 'string' && entry.command.replaceAll('\\', '/').includes(HOOK_MARK);

/** Existing hooks.json with our entries replaced by `command` on every event in CURSOR_EVENTS. */
export function mergeCursorHooks(existing: Record<string, any>, command: string): Record<string, any> {
  const hooks: Record<string, any[]> = {};
  for (const [event, entries] of Object.entries(existing.hooks ?? {})) {
    const kept = Array.isArray(entries) ? entries.filter(entry => !isOurs(entry)) : [];
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, timeout] of Object.entries(CURSOR_EVENTS)) {
    hooks[event] = [...(hooks[event] ?? []), { command, timeout }];
  }
  return { ...existing, version: existing.version ?? 1, hooks };
}

async function main() {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  const workspace = await resolveWorkspace(config.repoRoot, values.workspace ?? path.join(config.repoRoot, '..', 'workspace'), CONFIG_FILES);
  const tsx = tsxCli(config.repoRoot);
  const mcpFile = path.join(workspace, '.cursor', 'mcp.json');
  const hooksFile = path.join(workspace, '.cursor', 'hooks.json');
  const mcp = withMcpServer(readJsonFile(mcpFile), 'cowork',
    { type: 'stdio', ...mcpServerEntry(config.repoRoot, workspace, process.execPath, tsx) });
  const hooks = mergeCursorHooks(readJsonFile(hooksFile),
    hookCommand(process.execPath, tsx, path.join(config.repoRoot, 'adapters', 'cursor', 'hook.ts')));
  if (values['dry-run']) {
    console.log(`----- ${mcpFile}\n${JSON.stringify(mcp, null, 2)}\n----- ${hooksFile}\n${JSON.stringify(hooks, null, 2)}`);
    console.log('Dry run: nothing was written.');
    return;
  }
  // Exclude first, so the files are never visible to Git (or a snapshot) even for a moment.
  const exclude = await appendExclude(workspace, CONFIG_FILES.map(file => `/${file}`), 'Orkio Cursor adapter (per-laptop paths)');
  writeJsonFile(mcpFile, mcp);
  writeJsonFile(hooksFile, hooks);
  console.log(`Installed Orkio for Cursor in ${workspace}`);
  console.log(`  ${mcpFile}: "cowork" MCP server\n  ${hooksFile}: ${Object.keys(CURSOR_EVENTS).join(', ')}\n  ${exclude}: both files excluded`);
  console.log('Next: open the folder in Cursor, trust the workspace, enable "cowork" in MCP settings, then run');
  console.log('  node --import tsx adapters/core/cli.ts enable --adapter cursor --cwd <clone> --allow-publish [--allow-automatic]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof UsageError ? error.message : 'Cursor install failed. Nothing secret was printed; check the paths and try again.');
    process.exitCode = 1;
  });
}
