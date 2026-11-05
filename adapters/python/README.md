# orkio-adapter (Python)

Lets **LangGraph / LangChain** and **CrewAI** agents join an Orkio team as first-class agents: they
publish their work in progress the same way Claude Code and Codex do, they get the team's ten MCP
tools (`team_status`, `check_with_team`, `agree`, ...), and they can't finish a turn while they
still owe a teammate a reply or have an open orchestrator task.

The package is a thin wrapper. All publishing (Git WIP snapshots on `wip/<agent>`, SpacetimeDB
reports, presence, consent) is done by Orkio's Node core CLI, `adapters/core/cli.ts`, and the team
tools come from the existing MCP server, `mcp/src/server.ts`. Python never pushes or writes to the
database itself.

```
 your Python agent ──(subprocess, exec form)──> node --import tsx adapters/core/cli.ts sync ...
        │                                          └─> git push wip/<agent>, SpacetimeDB post_snapshot
        └──(MCP over stdio, cwd = your clone)───> node <tsx cli> mcp/src/server.ts
                                                   └─> team_status, check_with_team, agree, ...
```

## Requirements

- Python 3.11+.
- An Orkio checkout with `npm run setup` done (Node 24+, `node_modules/tsx`), and the
  `adapters/core` CLI present.
- A `.env` in the Orkio checkout with `COWORK_NAME`, `STDB_DB` (see `.env.example`), push access to
  the Git remote, and an approved `spacetime login` identity, exactly as for the Codex adapter.
- The agent's workspace: its own Git clone of the project. One agent name per active workspace.

## Install

```sh
pip install -e 'adapters/python'               # base: standard library only
pip install -e 'adapters/python[langgraph]'    # + langgraph, langchain-core, langchain-mcp-adapters
pip install -e 'adapters/python[crewai]'       # + crewai, crewai-tools[mcp]
pip install -e 'adapters/python[test]'         # + pytest, pytest-asyncio
```

`import orkio_adapter` (and even `import orkio_adapter.langgraph` / `.crewai`) works without either
framework installed. Functions that need one raise an `ImportError` naming the extra.

## Enable publishing (consent first)

Publishing is **off** until a human approves it. Publishing pushes the workspace's non-ignored files
to `wip/<COWORK_NAME>` on the configured remote and reports file names and an intent line to the
team database. Get your human's OK before running:

```python
from orkio_adapter import OrkioClient

client = OrkioClient("/path/to/orkio", "/path/to/my-clone", adapter_id="langgraph", label="LangGraph")
client.enable(allow_publish=True)                         # manual sync() only
# client.enable(allow_publish=True, allow_automatic=True) # also allows the background publisher
# client.start()                                          # continuous publishing + presence
print(client.sync(intent="Build the login form"))         # SyncResult(published=True, sha='…', busy=False)
print(client.status())                                    # StatusResult(database=…, agent=…, online=…, …)
print(client.done())   # posts a "Done:" intent; NOT a test result (run check_with_team first)          # the CLI's summary line
client.stop()
```

`OrkioClient` arguments worth knowing:

| Argument | Default | Meaning |
|---|---|---|
| `adapter_id` | `"langgraph"` | Adapter id passed as `--adapter`: 1-40 chars of `a-z`, `0-9`, `-` (same rule as the core CLI). |
| `label` | core CLI default | Display name passed as `--label` (omitted: the core CLI title-cases the id). |
| `agent_name` | from `.env` | Overrides `COWORK_NAME` for child processes. |
| `env` | `os.environ` | Exact environment for child processes (never logged or shown in `repr`). |
| `timeouts` | `sync`/`done` 120 s, others 30 s | Per-command limits; the child is killed on timeout. |

Errors are typed: `OrkioSetupError` (no Node, no tsx, no CLI), `OrkioCLIError` (non-zero exit,
carries `returncode` and up to 2,000 chars of stderr), `OrkioTimeoutError`, `OrkioProtocolError`
(output wasn't the JSON the contract promises; the output itself is not echoed). All subclass
`OrkioError`.

## LangGraph

```python
import asyncio
from langchain.agents import create_agent          # or: langgraph.prebuilt.create_react_agent
from orkio_adapter import OrkioClient
from orkio_adapter.langgraph import find_tool, load_orkio_tools, with_team_gate

async def main():
    client = OrkioClient("/path/to/orkio", "/path/to/my-clone", adapter_id="langgraph")
    team_tools = await load_orkio_tools(client)               # the ten Orkio MCP tools
    agent = create_agent(my_chat_model, tools=[*my_file_tools, *team_tools])
    graph = with_team_gate(agent, find_tool(team_tools, "team_status"), client=client)
    result = await graph.ainvoke({"messages": [("user", "Add a dark mode toggle")]})
    print(result["orkio_gate"])   # {'blocked': False, 'reason': '', ...}

asyncio.run(main())
```

- `orkio_mcp_connections(client)` returns `{"cowork": {"transport": "stdio", "command", "args", "cwd", "env"}}`
  for `MultiServerMCPClient` if you manage the MCP client yourself. `orkio_mcp_config(client)`
  returns the `{"mcpServers": {...}}` shape for LangChain's newer, beta `langchain.mcp.MCPAdapter`.
- **The team gate** (`with_team_gate`) approximates Claude Code's Stop hook: after the agent finishes,
  it publishes the workspace (when `client=` is given), calls `team_status`, and, if there is an open
  conflict thread or an assigned task, appends one `[cowork]` message telling the agent what to do
  (reply / agree / escalate, or `check_with_team` + `complete_task`) and runs the agent again. It
  pushes back at most `max_nudges` times per invocation (default 1, like `stop_hook_active`).
  Escalated conflicts and tasks waiting for review never block. Any failure fails open. Run it with
  `ainvoke`/`astream` (MCP tools are async).
- **Publishing after edits** in a hand-built graph: add `orkio_sync_node(client)` after your tool
  node (`agent -> tools -> orkio_sync -> agent`). It publishes only when the last AI message called a
  file-editing tool (`DEFAULT_EDIT_TOOLS`, or pass `after_tools=`), writes the `SyncResult` to
  `state["orkio_sync"]` (add that key to your state schema), and fails open with an `error` field.

## CrewAI

```python
from crewai import Agent, Crew, Task
from orkio_adapter import OrkioClient
from orkio_adapter.crewai import orkio_crewai_tools, orkio_task_callback

client = OrkioClient("/path/to/orkio", "/path/to/my-clone", adapter_id="crewai", label="CrewAI")

with orkio_crewai_tools(client) as team_tools:          # MCPServerAdapter; stops the server on exit
    dev = Agent(role="Backend developer", goal="...", backstory="...", tools=[*my_tools, *team_tools])
    task = Task(
        description="Implement the scores API. Before finishing, call team_status and settle any open conflict.",
        expected_output="A summary of the change",
        agent=dev,
        callback=orkio_task_callback(client, intent=lambda out: "Scores API implemented"),
    )
    Crew(agents=[dev], tasks=[task]).kickoff()
```

`orkio_task_callback` also works as `Crew(task_callback=...)`, chains your own callback via `then=`,
and never fails the crew on a publishing error unless `raise_on_error=True`. CrewAI has no Stop
hook equivalent, so the "settle before finishing" rule goes in the task description (above), or
you call `parse_team_status` / `gate_decision` from `orkio_adapter` yourself.

We use `crewai_tools.MCPServerAdapter` with `mcp.StdioServerParameters` rather than
`Agent(mcps=[MCPServerStdio(...)])` because `MCPServerStdio` has no `cwd`, and `pull_teammate` /
`check_with_team` operate on the MCP server's working directory, which must be the agent's clone.

## What is and isn't published

Published (only after `enable(allow_publish=True)`):
- The workspace's non-ignored working files, as a snapshot commit on `wip/<agent>` (your branch,
  index and stash are not touched; that's the core CLI's snapshot helper).
- To the team database: the snapshot SHA, the list of changed files, presence, status, and the
  `intent` line **you** pass.

Never published by this package: prompts, chat transcripts, model outputs, task descriptions,
tool arguments, or environment variables. `intent` defaults to nothing; when you pass a function,
make it return a one-line summary, not raw model text. Error messages include CLI stderr but never
stdout or the environment.

## Limitations

- **Depends on the core CLI.** `adapters/core/cli.ts` must implement the contract below. If it's
  missing you get `OrkioSetupError`.
  `node --import tsx adapters/core/cli.ts <enable|sync|status|start|publish|stop|done> --adapter <id>
  [--label <L>] [--cwd <repo>] [--intent <text>] [--force-report] [--allow-publish] [--allow-automatic]`;
  `sync` prints `{"published", "sha", "busy"?}`, `status` prints `{database, agent, online, status,
  intent, files, snapshotSha}`, `done` prints `{"summary"}`, non-zero exit on error. Value flags are sent
  as `--flag=value`, so an intent starting with `-` survives Node's strict `parseArgs`. The client runs
  it with cwd = the Orkio checkout (so `--import tsx` resolves) and passes the workspace as `--cwd`.
  It takes the last JSON-object line of stdout (or the whole stdout as JSON). `publish` runs the
  publisher in the foreground forever, so it is reachable through `client.run("publish", timeout=...)`
  only; use `start`/`stop`.
- **The gate parses `team_status` text** (wording from `hooks/src/lib/format.ts` `teamStatus`). If
  that wording changes, the gate stops blocking (fails open) rather than misfiring;
  `tests/test_gate.py` pins the lines it relies on. `team_status` is clipped at 1,500 characters,
  so a very long status can hide a conflict line.
- **Coarser than the Stop hook.** `team_status` doesn't say who spoke last in a conflict thread,
  so the gate nudges on any open (not escalated) conflict, where the Stop hook only nudges when the
  last word isn't yours. With one nudge per turn the cost is one extra model turn.
- **No wake-up.** Like the Codex adapter, nothing here can wake an idle Python agent when a teammate
  messages it; the agent sees `[cowork]` news when it next calls `team_status` or is invoked.
- **Child environment.** By default the CLI and the MCP server inherit the Python process's full
  environment (as they would from a shell or Claude Code), because Git credential helpers and the
  SpacetimeDB CLI need it. Pass `env=` for a restricted one.
- `langchain-mcp-adapters` is archived upstream in favour of the beta `langchain.mcp` namespace
  (`langchain[mcp]>=1.4`). `load_orkio_tools` still uses `MultiServerMCPClient`, which works with the
  versions below; `orkio_mcp_config` is ready for `MCPAdapter`.

## Versions verified

Tested on Python 3.13 with: langgraph 1.2.19, langgraph-prebuilt 1.1.1, langchain-core 1.7.3,
langchain-mcp-adapters 0.3.2, mcp 1.30.0, crewai 1.15.33, crewai-tools 1.15.33 (Oct 31, 2026).
API facts checked against the installed sources and these docs:

- langchain-mcp-adapters `MultiServerMCPClient` / `StdioConnection` (`transport`, `command`, `args`,
  `env`, `cwd`): <https://github.com/langchain-ai/langchain-mcp-adapters>
- Migration to `langchain.mcp.MCPAdapter`: <https://docs.langchain.com/oss/python/migrate/langchain-mcp-adapters>
- CrewAI MCP (`MCPServerAdapter`, `StdioServerParameters`, `mcps=`): <https://docs.crewai.com/en/mcp/overview>
- `langgraph.prebuilt.create_react_agent` is deprecated in favour of `langchain.agents.create_agent`;
  `with_team_gate` wraps either, or any compiled graph with a `messages` key.

## Tests

```sh
cd adapters/python
pytest -q                          # subprocess is mocked; framework tests skip if not installed
ORKIO_MCP_E2E=1 pytest -q -k real  # also spawns the real MCP server and lists its ten tools
```

The end-to-end test runs the server with `COWORK_NAME` and `STDB_DB` set to empty strings, which
take precedence over the repo `.env`, so it registers no presence and writes nothing.

Test plan: the CLI wrapper (argv building, exec form with no shell, cwd, timeouts, JSON parsing,
error mapping, env override, no secrets in `repr` or errors), connection dict shapes (checked
against `StdioConnection`'s fields), the sync node and CrewAI callback (fail-open, no prompt text
in argv), gate parsing against `teamStatus`-shaped fixtures, and the gate graph with a fake agent,
a prebuilt ReAct agent with a fake model, and a checkpointer (counter resets per turn).
