# Cursor adapter

Connects Cursor's agent to Orkio through the `cowork` MCP server, Cursor's native project hooks, and the shared [core publisher](../core/README.md). It uses the local `.env` and the signed-in SpacetimeDB CLI identity. It never changes your active branch, real index, stash, or main branch.

```sh
node --import tsx adapters/cursor/install.ts --workspace ../workspace      # add --dry-run to preview
# Only after approving publication to your configured Git remote and database:
node --import tsx adapters/core/cli.ts enable --adapter cursor --cwd ../workspace --allow-publish
# Native hooks and the publisher additionally need approval of ongoing reporting:
node --import tsx adapters/core/cli.ts enable --adapter cursor --cwd ../workspace --allow-publish --allow-automatic
node --import tsx adapters/core/cli.ts status --adapter cursor --cwd ../workspace
```

The installer merges into the workspace clone, keeping unrelated entries and replacing its own (never duplicating them):

- `.cursor/mcp.json`: `mcpServers.cowork`, exec form (`type: "stdio"`, absolute `node`, tsx CLI, `adapters/core/mcp-launch.ts`, workspace path).
- `.cursor/hooks.json`: `{"version":1,"hooks":{...}}` with one `{command, timeout}` entry per event, all running `adapters/cursor/hook.ts`.
- `.git/info/exclude`: both files, because they hold this laptop's absolute paths. It adds them before writing the files. If the project already tracks either file, the installer refuses. The adapter source itself is not excluded and is meant to be committed.

| Cursor event | What Orkio does | Cursor output |
|---|---|---|
| `sessionStart` | Start the publisher; team status from `hooks/src/session-start.ts` | `additional_context` |
| `beforeSubmitPrompt` | Ensure the publisher runs (this event can't add context) | `{"continue":true}` |
| `postToolUse` | Team notes, intents and wakes from `hooks/src/inject-context.ts` | `additional_context` |
| `afterFileEdit`, `afterShellExecution` | Ensure the publisher runs; it publishes within about 2 seconds | `{}` |
| `stop` | Sync now, then `hooks/src/stop.ts` checks for an open task or an unanswered conflict | `followup_message` (only after a `completed` turn with `loop_count` 0) |

Hooks fail open. Without automatic consent, on any error, or for an unknown event, they print the minimal valid JSON (`{}`, or `{"continue":true}` for `beforeSubmitPrompt`) and exit 0. The hook scripts receive only the event name, the workspace and a loop flag. Prompts, attachments, tool output and transcripts are never forwarded or published.

## Manual steps

1. Open the clone in Cursor and **trust the workspace**. Project hooks run only in trusted workspaces.
2. Enable the `cowork` server in Cursor's MCP settings and approve its tools as usual.
3. Run `enable` as above. Until you add `--allow-automatic`, the hooks do nothing and only manual `sync` publishes.
4. Rerun the installer if you move the Orkio repo or the clone, or change Node installation.

The hook `command` is a POSIX single-quoted string. On native Windows, Cursor runs hooks through PowerShell, so this command form is not verified there. Use WSL, or rely on MCP plus `cli.ts start`.

Verified against the [Cursor hooks docs](https://cursor.com/docs/agent/hooks) and [Cursor MCP docs](https://cursor.com/docs/context/mcp) on 2026-10-31. Neither page says which directory a project stdio MCP server starts in, which is why the launcher sets it explicitly.

```sh
node --import tsx --test adapters/cursor/*.test.ts
node_modules/.bin/tsc -p adapters/cursor
```
