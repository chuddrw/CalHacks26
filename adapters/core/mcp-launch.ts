/**
 * adapters/core/mcp-launch.ts
 *
 * WHAT IT'S FOR
 *   Starts the unchanged Orkio MCP server (mcp/src/server.ts) with the workspace clone as its
 *   working directory, for MCP clients that don't document which folder they start a server in.
 *   Usage (written by the installers, exec form): node <tsx cli> mcp-launch.ts <workspace clone>
 *
 * NOTES
 *   - stdout belongs to the MCP protocol: this file prints nothing; the reason goes to stderr.
 */
import path from 'node:path';

const workspace = process.argv[2];
try {
  if (workspace) process.chdir(path.resolve(workspace));
} catch {
  console.error('[cowork] the workspace folder configured for the MCP server does not exist; starting in the current folder.');
}
await import('../../mcp/src/server.ts');
