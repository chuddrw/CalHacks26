/**
 * adapters/gemini/install.ts
 *
 * WHAT IT'S FOR
 *   One-time setup that connects Gemini CLI, in the workspace clone, to Orkio. It merges into
 *   <workspace>/.gemini/settings.json:
 *     mcpServers.cowork   the Orkio MCP server (adapters/core/install.ts mcpServerEntry), with `cwd`
 *     hooks.<Event>       one group per event running adapters/gemini/hook.ts
 *   and adds that file to <workspace>/.git/info/exclude (it holds this laptop's absolute paths).
 *   Unrelated settings, servers and hooks are kept; our earlier entries are replaced, never duplicated.
 *   If the project already tracks .gemini/settings.json, it refuses (would commit local paths).
 *
 * USAGE (from the Orkio repo root)
 *   node --import tsx adapters/gemini/install.ts [--workspace <clone>] [--dry-run]
 *
 * GEMINI CLI FORMAT (https://geminicli.com/docs/hooks/ and /docs/hooks/reference/, checked 2026-10-31)
 *   "hooks": { "<Event>": [{ "matcher": "...", "hooks": [{ "name", "type": "command", "command", "timeout" (ms) }] }] }
 *   Project hooks are fingerprinted by name + command: a changed command is untrusted until approved.
 *   Our names and command are stable across re-installs, so approval survives them.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config } from '../../shared/src/config.ts';
import {
  appendExclude, hookCommand, mcpServerEntry, readJsonFile, resolveWorkspace, tsxCli, withMcpServer, writeJsonFile,
} from '../core/install.ts';
import type { McpEntry } from '../core/install.ts';
import { UsageError } from '../core/runtime.ts';

/** Our events, matchers and timeouts (ms). Only events listed in Gemini CLI's hooks docs. */
export const GEMINI_EVENTS: Record<string, { matcher?: string; timeout: number }> = {
  SessionStart: { timeout: 15000 },
  BeforeAgent: { timeout: 10000 },
  AfterTool: { matcher: '*', timeout: 10000 },
  AfterAgent: { timeout: 45000 },
};
export const CONFIG_FILE = '.gemini/settings.json';
const HOOK_MARK = 'adapters/gemini/hook.ts';

const isOurs = (hook: any) => typeof hook?.command === 'string' && hook.command.replaceAll('\\', '/').includes(HOOK_MARK);

/** Existing settings with our MCP server and hooks merged in. */
export function mergeGeminiSettings(existing: Record<string, any>, mcp: McpEntry, workspace: string, command: string): Record<string, any> {
  const hooks: Record<string, any[]> = {};
  for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
    if (!Array.isArray(groups)) { hooks[event] = groups as any; continue; }
    const kept = groups.map((group: any) => ({ ...group, hooks: (group?.hooks ?? []).filter((hook: any) => !isOurs(hook)) }))
      .filter((group: any) => group.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, { matcher, timeout }] of Object.entries(GEMINI_EVENTS)) {
    hooks[event] = [...(hooks[event] ?? []), {
      ...(matcher ? { matcher } : {}),
      hooks: [{ name: `orkio-${event}`, type: 'command', command, timeout, description: 'Orkio team coordination' }],
    }];
  }
  return { ...withMcpServer(existing, 'cowork', { ...mcp, cwd: workspace }), hooks };
}

async function main() {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  const workspace = await resolveWorkspace(config.repoRoot, values.workspace ?? path.join(config.repoRoot, '..', 'workspace'), [CONFIG_FILE]);
  const tsx = tsxCli(config.repoRoot);
  const file = path.join(workspace, CONFIG_FILE);
  const settings = mergeGeminiSettings(readJsonFile(file), mcpServerEntry(config.repoRoot, workspace, process.execPath, tsx),
    workspace, hookCommand(process.execPath, tsx, path.join(config.repoRoot, 'adapters', 'gemini', 'hook.ts')));
  if (values['dry-run']) {
    console.log(`----- ${file}\n${JSON.stringify(settings, null, 2)}\nDry run: nothing was written.`);
    return;
  }
  const exclude = await appendExclude(workspace, [`/${CONFIG_FILE}`], 'Orkio Gemini CLI adapter (per-laptop paths)');
  writeJsonFile(file, settings);
  console.log(`Installed Orkio for Gemini CLI in ${workspace}`);
  console.log(`  ${file}: "cowork" MCP server; hooks ${Object.keys(GEMINI_EVENTS).join(', ')}\n  ${exclude}: settings excluded`);
  console.log('Next: start gemini in the clone, trust the folder, approve the hooks (/hooks) and check /mcp, then run');
  console.log('  node --import tsx adapters/core/cli.ts enable --adapter gemini --label "Gemini CLI" --cwd <clone> --allow-publish [--allow-automatic]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof UsageError ? error.message : 'Gemini install failed. Nothing secret was printed; check the paths and try again.');
    process.exitCode = 1;
  });
}
