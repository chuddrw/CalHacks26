# Orkio adapter core

One adapter-agnostic implementation of publication and presence for every coding agent that is not Claude Code: Cursor, Gemini CLI, Python tools, or any MCP client. It generalizes the local Codex adapter (`runtime.ts`, `publication.ts`, the `cli.ts` publisher) behind an adapter id (`[a-z0-9-]+`) and a display label. It uses the local `.env` and the signed-in SpacetimeDB CLI identity. It never changes your active branch, real index, stash, or main branch.

```sh
# Only after approving publication to your Git remote and database:
node --import tsx adapters/core/cli.ts enable --adapter cursor --cwd ../workspace --allow-publish
node --import tsx adapters/core/cli.ts sync   --adapter cursor --cwd ../workspace --intent "Build scoreboard"
node --import tsx adapters/core/cli.ts status --adapter cursor --cwd ../workspace
# Continuous reporting (publisher + native hooks) needs a second, explicit approval:
node --import tsx adapters/core/cli.ts enable --adapter cursor --cwd ../workspace --allow-publish --allow-automatic
node --import tsx adapters/core/cli.ts start  --adapter cursor --cwd ../workspace
```

## CLI contract

Other adapters call this as a subprocess. Treat it as frozen.

```
node --import tsx adapters/core/cli.ts <command> --adapter <id> [--label <Label>] [--cwd <repo>]
     [--intent <text>] [--force-report] [--allow-publish] [--allow-automatic]
```

| Command | Effect | stdout |
|---|---|---|
| `enable` | Writes consent. Requires `--allow-publish`; `--allow-automatic` also allows the publisher and native hooks | one human line |
| `sync` | One publication: snapshot, push `wip/<COWORK_NAME>`, `post_snapshot`, `post_intent` | one line `{"published":boolean,"sha":string\|null,"busy"?:boolean}` |
| `status` | Read-only view of this agent in the database | `{database, agent, online, status, intent, files, snapshotSha}` |
| `start` / `stop` | Start (idempotent) or stop the background publisher, and with it online presence | one human line |
| `publish` | The publisher in the foreground (what `start` spawns) | log lines |
| `done` | Posts a `Done (not verified by check_with_team): …` intent for the latest published snapshot. Never calls `report_check` | `{"summary": string}` |

Errors exit with code 1 and print one generic line on stderr. Server output, tokens and file contents are never printed. `busy: true` means another publisher holds the lock; retry later. The default intent is `<Label> editing <up to 4 files> [and N more files]`. The label defaults to the id in title case (`vs-code` becomes `Vs Code`).

## How it works

```text
agent edits ──> native hook / publisher tick (every 2 s)
                   │  lock .git/cowork-<id>-<agent>-<db>.json.lock
                   ▼
   pending? ──yes──> finish it first (post_snapshot, then post_intent)
                   ▼
   takeSnapshot (temp index, commit-tree, push --force wip/<agent>)   ← hooks/src/lib/snapshot.ts
                   ▼  record "pending" BEFORE each database call
   post_snapshot ──> post_intent ──> lastPublished
                   ▼
   5 quiet cycles on the same sha ──> "Done (idle; not verified by check_with_team)" intent only
```

State lives in the workspace clone's `.git/`, outside tracked files:

| File | Purpose |
|---|---|
| `cowork-<id>-publish-enabled.json` | Consent, bound to agent, database and remote. Any change invalidates it |
| `cowork-<id>-<agent>-<db>.json` (`.lock`) | Pending and last publication; the lock holds the owner PID |
| `cowork-<id>-publisher-<agent>.json` (`.log`) | Publisher PID and its log |

## Design decisions

- **Durable pending record, not a transaction.** Git and SpacetimeDB can't commit together. The pending record is written before each database call, so a failure after the push is retried without another snapshot or a duplicate `post_snapshot`. The cost is that a crash between the two reducers can repeat `post_intent` once, which is harmless.
- **PID lock with stale-owner recovery.** A lock is removed only when its PID provably no longer exists (`ESRCH`). An unreadable lock or an unknown liveness result counts as busy. This is stricter than the 30-second mtime rule in `snapshot.ts`, because publication can take longer than that.
- **Database-reset republish.** Every 15 cycles (about 30 seconds) the publisher checks whether the database still has a snapshot for this agent. If not, it re-reports the last one without a new Git commit.
- **One CLI, many adapters.** A subprocess contract lets Python and other non-Node adapters share the exact safety logic instead of reimplementing it. A Node process start on each call is the trade-off.
- **MCP launcher.** `mcp-launch.ts` changes to the workspace directory and then loads the unchanged `mcp/src/server.ts`, because not every client says where it starts stdio servers. `install.ts#mcpServerEntry` returns the exec-form entry: absolute `node`, the tsx CLI, the launcher and the workspace, with no shell.
- **Excludes.** `install.ts#appendExclude` adds per-laptop config files to the clone's `.git/info/exclude` before writing them. It refuses any `adapters/...` pattern, because adapter source is meant to be committed.

## Done is not a test result

"Done" means only that the snapshot has stopped changing. No check was run. The **publisher** therefore posts only the `Done (idle; not verified by check_with_team)` intent and never reports a check. The module (`module/src/index.ts`) accepts *any* current green `check_run` as evidence for `complete_task` and for resolving a conflict. An automatic idle green would let work through that no test ever ran on, which breaks Orkio's "tests decide" rule. (The Codex adapter reported green here; this core deliberately does not, in either path.) The explicit **`done` command** follows the same rule: it posts a `Done (not verified by check_with_team)` intent and never calls `report_check`. Green comes only from `check_with_team` or the orchestrator's full-stack build.

Options are accepted as `--name value` or `--name=value`.

## Limits

- Use one adapter per clone and agent name. All adapters share `snapshot.ts`'s `cowork-last-tree`, so two adapters (or Claude Code hooks) on one clone race for the same `wip/<agent>` branch.
- The publisher provides presence and publication. It can't wake an idle agent or run `check_with_team`. A snapshot is work in progress, not a green integration result.
- Snapshots include every non-ignored working file, like the Claude Code hook.

Requires Node 24+, the repo's `tsx`, Git push access, `COWORK_NAME`, `STDB_DB`, and an approved Editor identity from `spacetime login`.

```sh
node --import tsx --test adapters/core/*.test.ts
node_modules/.bin/tsc -p adapters/core
```
