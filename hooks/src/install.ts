/**
 * hooks/src/install.ts
 *
 * WHAT IT'S FOR
 *   One-time setup on each teammate's laptop, so that Claude Code sessions in that laptop's
 *   demo-app clone run our hooks and our MCP server. Run it again if you move either folder.
 *
 * OWNER: A. WHEN: Sat 9:20 (first version), then on every laptop before checkpoint 2.
 * USAGE (from the repo root):  npm run install-hooks -- --demo <path to demo-app clone> --name <you>
 * DONE WHEN: on a fresh laptop, one command makes /hooks list our hooks and /mcp show "cowork".
 *
 * WHAT IT DOES
 *   1. Writes COWORK_NAME=<you> into this repo's .env, creating .env from .env.example if needed.
 *   2. Merges hookSettings() into <demo>/.claude/settings.local.json. Keep every key already there
 *      and replace only our own entries (recognize them by the path to this repo's hooks/src/).
 *      settings.local.json is per laptop and gitignored, which is right: it holds absolute paths.
 *   3. Registers the MCP server for that folder only. Run this from <demo>, because local scope
 *      belongs to the folder:
 *        claude mcp add --scope local cowork -- node <tsx cli> <repo>/mcp/src/server.ts
 *      <tsx cli> is <repo>/node_modules/tsx/ plus the "bin" path in tsx's package.json. Use node +
 *      script path because .cmd shims can't be spawned without a shell on Windows.
 *      Details: external/mcp.txt.
 *   4. Prints what changed and how to check it: start `claude` in <demo>, then run /hooks and /mcp.
 *
 * WHY EXEC FORM ("command": "node", "args": [path])
 *   No shell, so paths with spaces or backslashes pass through untouched, on Windows and Mac alike.
 *
 * Until steps 1-4 exist, running this file prints the settings block, so you can paste it by hand.
 */
import path from "node:path";
import { config } from "../../shared/src/config.ts";

/** The hooks block that goes into demo-app/.claude/settings.local.json. */
export function hookSettings(repoRoot: string) {
  const script = (name: string) => path.join(repoRoot, "hooks", "src", name);
  const run = (name: string, extra: Record<string, unknown>) => ({
    type: "command",
    command: "node",
    args: [script(name)],
    ...extra,
  });
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
          hooks: [run("snapshot-and-wait.ts", { asyncRewake: true, timeout: 1800 })],
        },
        { matcher: "*", hooks: [run("inject-context.ts", { timeout: 5 })] },
      ],
      UserPromptSubmit: [{ hooks: [run("inject-context.ts", { timeout: 5 })] }],
      Stop: [{ hooks: [run("stop.ts", { timeout: 5 })] }],
      SessionStart: [{ hooks: [run("session-start.ts", { timeout: 10 })] }],
    },
  };
}

// TODO (A): parse --demo and --name, then do steps 1-4 above. Until then, print the block.
console.log(JSON.stringify(hookSettings(config.repoRoot), null, 2));
