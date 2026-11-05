# Gemini CLI adapter

Connects Gemini CLI to Orkio through the `cowork` MCP server, Gemini CLI's native hooks, and the shared [core publisher](../core/README.md). It uses the local `.env` and the signed-in SpacetimeDB CLI identity. It never changes your active branch, real index, stash, or main branch.

```sh
node --import tsx adapters/gemini/install.ts --workspace ../workspace      # add --dry-run to preview
# Only after approving publication to your configured Git remote and database:
node --import tsx adapters/core/cli.ts enable --adapter gemini --label "Gemini CLI" --cwd ../workspace --allow-publish
# Native hooks and the publisher additionally need approval of ongoing reporting:
node --import tsx adapters/core/cli.ts enable --adapter gemini --label "Gemini CLI" --cwd ../workspace --allow-publish --allow-automatic
```

The installer merges into the clone's `.gemini/settings.json`. It keeps unrelated settings, servers and hooks, and replaces its own entries without duplicating them:

- `mcpServers.cowork`: absolute `node`, the tsx CLI, `adapters/core/mcp-launch.ts` and the workspace, plus `cwd`.
- `hooks.<Event>`: one group per event with `{name: "orkio-<Event>", type: "command", command, timeout}`. The timeout is in milliseconds.
- `.git/info/exclude`: `/.gemini/settings.json`, added before the file is written. If the project already tracks that file, the installer refuses. In that case, put the same entries in `~/.gemini/settings.json`. The adapter source is not excluded.

| Gemini event | What Orkio does | Gemini output |
|---|---|---|
| `SessionStart` | Start the publisher; team status from `hooks/src/session-start.ts` | `hookSpecificOutput.additionalContext` |
| `BeforeAgent` | Team notes and wakes from `hooks/src/inject-context.ts` (this turn only) | `hookSpecificOutput.additionalContext` |
| `AfterTool` (`matcher: "*"`) | Ensure the publisher runs; team notes | `hookSpecificOutput.additionalContext` |
| `AfterAgent` | Sync now, then `hooks/src/stop.ts` checks for an open task or an unanswered conflict | `{"decision":"deny","reason":...}` (Gemini retries the turn with the reason as the prompt) |

Hooks fail open. Without automatic consent, on any error, or for an unknown event, they print `{}` and exit 0. Gemini treats any non-JSON stdout as a parse failure, so nothing else is printed. Prompts, responses and tool output are never forwarded or published.

## Manual steps

1. Start `gemini` in the clone and **trust the folder** if asked.
2. **Approve the hooks.** Project hooks are fingerprinted by name and command. Gemini warns about new or changed ones, so review them in `/hooks`. Reinstalling with the same paths keeps the same fingerprint.
3. Check that `/mcp` lists `cowork`.
4. Run `enable` as above.

## Assumptions not verified

- Gemini sanitizes the environment for hooks and MCP servers, removing names matching `*TOKEN*`, `*KEY*` and similar. Orkio reads its own `.env` from the repo root and gets the SpacetimeDB token from `spacetime login`, so this should not matter. `STDB_TOKEN` (mock-database testing only) won't pass through unless you add it under `mcpServers.cowork.env`.
- The reference does not confirm that `hookEventName` is required in `hookSpecificOutput`. We include it to match Claude's format.

Verified against the [Gemini CLI hooks guide](https://geminicli.com/docs/hooks/), the [hooks reference](https://geminicli.com/docs/hooks/reference/), [MCP servers](https://geminicli.com/docs/tools/mcp-server/), and the [configuration reference](https://geminicli.com/docs/reference/configuration/) (`hooksConfig.enabled` defaults to `true`) on 2026-10-31. The docs also note that for unpaid-tier and Google One users, Gemini CLI was replaced by Antigravity CLI on June 18, 2026. This adapter has not been tested with Antigravity CLI.

```sh
node --import tsx --test adapters/gemini/*.test.ts
node_modules/.bin/tsc -p adapters/gemini
```
