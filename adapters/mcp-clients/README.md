# Any other MCP client

Any MCP client that can start a stdio server can use Orkio's tools (`team_status`, `post_intent`, `check_with_team`, `message_teammate`, `agree` and others). The [core publisher](../core/README.md) provides what hooks provide elsewhere: presence, snapshots and an unverified Done intent. Clients without hooks get no automatic wake-ups. Ask the agent to call `team_status` at the start of a task and `check_with_team` before it finishes.

## 1. The server entry

Get this laptop's exact values. The node path and tsx path must be absolute, and nothing goes through a shell:

```sh
node -e 'console.log(process.execPath)'          # <node>
ls "$PWD/node_modules/tsx/dist/cli.mjs"           # <tsx>, run from the Orkio repo root
```

Every client uses the same three arguments: `<tsx>`, `<orkio>/adapters/core/mcp-launch.ts`, and `<clone>`, the absolute path of the project clone the agent edits. The launcher runs the server in that clone. Config files that contain these paths are per-laptop. If one sits inside the clone, add it to the clone's `.git/info/exclude`.

| Client | File | Shape | Verified |
|---|---|---|---|
| VS Code (Copilot agent mode) | `.vscode/mcp.json`, or the user `mcp.json` (**MCP: Open User Configuration**) | `{"servers":{"cowork":{"type":"stdio","command":"<node>","args":[...]}}}`; `cwd` optional | Yes, [MCP configuration reference](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration), 2026-10-31 |
| Codex | `~/.codex/config.toml`, or project `.codex/config.toml` (trusted projects only) | TOML below | Yes, [Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), 2026-10-31 |
| Cline | `cline_mcp_settings.json` (Cline panel, then MCP Servers, Configure; CLI: `~/.cline/data/settings/`) | `{"mcpServers":{"cowork":{"command":"<node>","args":[...],"disabled":false,"autoApprove":[]}}}` | Yes, [Cline docs](https://docs.cline.bot/mcp/configuring-mcp-servers), 2026-10-31 |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `{"mcpServers":{"cowork":{"command":"<node>","args":[...]}}}` | **No.** The Windsurf docs URL now redirects to Devin docs (`.devin/config.json`), which do not document this file. Check your version |
| Cursor, Gemini CLI | use their installers | [../cursor](../cursor/README.md), [../gemini](../gemini/README.md) | Yes |

```toml
# Codex
[mcp_servers.cowork]
command = "<node>"
args = ["<tsx>", "<orkio>/adapters/core/mcp-launch.ts", "<clone>"]
cwd = "<clone>"
startup_timeout_sec = 20
```

## 2. Presence and snapshots

Pick a lowercase adapter id per client, such as `vscode`, `cline` or `windsurf`. Consent, state and the publisher are kept per id.

```sh
node --import tsx adapters/core/cli.ts enable --adapter vscode --label "VS Code" --cwd <clone> --allow-publish --allow-automatic
node --import tsx adapters/core/cli.ts start  --adapter vscode --cwd <clone>    # online + snapshots every 2 s
node --import tsx adapters/core/cli.ts status --adapter vscode --cwd <clone>
node --import tsx adapters/core/cli.ts done   --adapter vscode --cwd <clone>    # optional "Done (not verified)" intent; the publisher posts one after ~10 s quiet
node --import tsx adapters/core/cli.ts stop   --adapter vscode --cwd <clone>
```

Without `--allow-automatic`, only explicit `sync` publishes. Neither `done` nor the publisher ever reports a green check. Only `check_with_team` does that, so run it before finishing. Use one adapter per clone and agent name.
