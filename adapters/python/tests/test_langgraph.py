"""LangGraph helpers. Connection shape and the sync node need no framework; graph tests skip without langgraph."""

from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from orkio_adapter import OrkioClient
from orkio_adapter.langgraph import (
    find_tool,
    last_tool_names,
    orkio_mcp_config,
    orkio_mcp_connections,
    orkio_sync_node,
)
from conftest import NOT_CONFIGURED, TEAM_STATUS_CLEAR, TEAM_STATUS_CONFLICT, TEAM_STATUS_TASKS


# ---- connection dicts (no framework needed)


def test_connection_dict_shape(client: OrkioClient, orkio_root: Path, workspace: Path) -> None:
    connections = orkio_mcp_connections(client)
    assert list(connections) == ["cowork"]
    conn = connections["cowork"]
    assert conn["transport"] == "stdio"
    assert conn["command"] == "/usr/bin/node"
    assert conn["args"][1] == str(orkio_root.resolve() / "mcp" / "src" / "server.ts")
    assert conn["cwd"] == str(workspace.resolve())
    assert isinstance(conn["env"], dict)
    assert set(conn) == {"transport", "command", "args", "cwd", "env"}


def test_connection_custom_server_name(client: OrkioClient) -> None:
    assert list(orkio_mcp_connections(client, server_name="orkio")) == ["orkio"]


def test_mcp_config_shape(client: OrkioClient, workspace: Path) -> None:
    config = orkio_mcp_config(client)
    server = config["mcpServers"]["cowork"]
    assert "transport" not in server  # MCPAdapter infers stdio from `command`
    assert server["cwd"] == str(workspace.resolve())


def test_connection_validates_against_langchain_mcp_adapters(client: OrkioClient) -> None:
    sessions = pytest.importorskip("langchain_mcp_adapters.sessions")
    mcp_client = pytest.importorskip("langchain_mcp_adapters.client")
    allowed = set(sessions.StdioConnection.__annotations__)
    conn = orkio_mcp_connections(client)["cowork"]
    assert set(conn) <= allowed
    mcp_client.MultiServerMCPClient(orkio_mcp_connections(client))  # constructing must not connect or fail


# ---- sync node (no framework needed)


def _ai(*names: str) -> SimpleNamespace:
    return SimpleNamespace(type="ai", tool_calls=[{"name": n, "args": {}, "id": n} for n in names])


def test_last_tool_names() -> None:
    state = {"messages": [SimpleNamespace(type="human"), _ai("write_file", "bash"), SimpleNamespace(type="tool", tool_calls=None)]}
    assert last_tool_names(state) == {"write_file", "bash"}
    assert last_tool_names({"messages": [_ai("write_file"), SimpleNamespace(type="human")]}) == set()
    assert last_tool_names({"messages": [{"type": "ai", "tool_calls": [{"name": "edit_file"}]}]}) == {"edit_file"}


def test_sync_node_publishes_after_edit(client: OrkioClient, fake_run) -> None:
    fake_run.queue('{"published": true, "sha": "abc"}')
    node = orkio_sync_node(client, intent=lambda state: "Login form")
    update = node({"messages": [_ai("write_file")]})
    assert update == {"orkio_sync": {"published": True, "sha": "abc", "busy": False}}
    assert fake_run.last["argv"][-1] == "--intent=Login form"


def test_sync_node_skips_without_edit(client: OrkioClient, fake_run) -> None:
    node = orkio_sync_node(client)
    assert node({"messages": [_ai("team_status")]}) == {}
    assert fake_run.calls == []


def test_sync_node_always_when_after_tools_none(client: OrkioClient, fake_run) -> None:
    fake_run.queue('{"published": false, "sha": null, "busy": true}')
    assert orkio_sync_node(client, after_tools=None, state_key="snap")({"messages": []}) == {
        "snap": {"published": False, "sha": None, "busy": True}
    }


def test_sync_node_fails_open(client: OrkioClient, fake_run) -> None:
    fake_run.queue(stderr="push rejected", returncode=1)
    update = orkio_sync_node(client, after_tools=None)({"messages": []})
    assert update["orkio_sync"]["published"] is False
    assert "push rejected" in update["orkio_sync"]["error"]


def test_sync_node_raise_on_error(client: OrkioClient, fake_run) -> None:
    from orkio_adapter import OrkioCLIError

    fake_run.queue(stderr="nope", returncode=1)
    with pytest.raises(OrkioCLIError):
        orkio_sync_node(client, after_tools=None, raise_on_error=True)({"messages": []})


def test_find_tool() -> None:
    tools = [SimpleNamespace(name="cowork_team_status"), SimpleNamespace(name="post_intent")]
    assert find_tool(tools, "team_status").name == "cowork_team_status"
    with pytest.raises(LookupError):
        find_tool(tools, "agree")


# ---- team gate (needs langgraph)

needs_langgraph = pytest.mark.skipif(
    importlib.util.find_spec("langgraph") is None or importlib.util.find_spec("langchain_core") is None,
    reason="langgraph / langchain-core not installed (extra [langgraph])",
)


class FakeTeamStatusTool:
    """Stands in for the MCP team_status tool: replays texts, MCP content-block style."""

    name = "team_status"

    def __init__(self, *texts: str, error: Exception | None = None) -> None:
        self.texts = list(texts)
        self.error = error
        self.calls = 0

    async def ainvoke(self, args: dict[str, Any]) -> Any:
        self.calls += 1
        if self.error:
            raise self.error
        text = self.texts.pop(0) if len(self.texts) > 1 else self.texts[0]
        return [{"type": "text", "text": text}]


def _fake_agent():
    langgraph_graph = pytest.importorskip("langgraph.graph")
    from langchain_core.messages import AIMessage

    runs = {"count": 0}

    def model(state: Any) -> dict[str, Any]:
        runs["count"] += 1
        return {"messages": [AIMessage(content=f"done #{runs['count']}")]}

    builder = langgraph_graph.StateGraph(langgraph_graph.MessagesState)
    builder.add_node("model", model)
    builder.add_edge(langgraph_graph.START, "model")
    builder.add_edge("model", langgraph_graph.END)
    return builder.compile(), runs


@needs_langgraph
async def test_gate_lets_clear_agent_finish() -> None:
    from orkio_adapter.langgraph import with_team_gate

    agent, runs = _fake_agent()
    tool = FakeTeamStatusTool(TEAM_STATUS_CLEAR)
    out = await with_team_gate(agent, tool).ainvoke({"messages": [("user", "build it")]})
    assert runs["count"] == 1 and tool.calls == 1
    assert out["orkio_gate"]["blocked"] is False


@needs_langgraph
async def test_gate_nudges_once_on_open_task_then_finishes() -> None:
    from langchain_core.messages import HumanMessage
    from orkio_adapter.langgraph import with_team_gate

    agent, runs = _fake_agent()
    tool = FakeTeamStatusTool(TEAM_STATUS_TASKS, TEAM_STATUS_CLEAR)
    out = await with_team_gate(agent, tool).ainvoke({"messages": [("user", "build it")]})
    assert runs["count"] == 2
    nudges = [m for m in out["messages"] if isinstance(m, HumanMessage) and m.content.startswith("[cowork]")]
    assert len(nudges) == 1 and "Task #4" in nudges[0].content
    assert out["orkio_gate"]["blocked"] is False


@needs_langgraph
async def test_gate_respects_max_nudges_when_still_blocked() -> None:
    from orkio_adapter.langgraph import with_team_gate

    agent, runs = _fake_agent()
    tool = FakeTeamStatusTool(TEAM_STATUS_CONFLICT)  # never clears
    out = await with_team_gate(agent, tool, max_nudges=1).ainvoke({"messages": [("user", "x")]})
    assert runs["count"] == 2  # one push-back, then it may stop, like stop_hook_active
    assert out["orkio_gate_nudges"] == 1
    out = await with_team_gate(agent, FakeTeamStatusTool(TEAM_STATUS_CONFLICT), max_nudges=3).ainvoke({"messages": [("user", "x")]})
    assert out["orkio_gate_nudges"] == 3


@needs_langgraph
async def test_gate_counter_resets_each_invocation_with_checkpointer() -> None:
    pytest.importorskip("langgraph.checkpoint.memory")
    from langgraph.checkpoint.memory import InMemorySaver
    from orkio_adapter.langgraph import with_team_gate

    agent, runs = _fake_agent()
    graph = with_team_gate(agent, FakeTeamStatusTool(TEAM_STATUS_TASKS), checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "t1"}}
    await graph.ainvoke({"messages": [("user", "turn 1")]}, config)
    await graph.ainvoke({"messages": [("user", "turn 2")]}, config)
    assert runs["count"] == 4  # nudged once in each turn


@needs_langgraph
@pytest.mark.parametrize("tool", [FakeTeamStatusTool(NOT_CONFIGURED), FakeTeamStatusTool("x", error=RuntimeError("down"))])
async def test_gate_fails_open(tool: FakeTeamStatusTool) -> None:
    from orkio_adapter.langgraph import with_team_gate

    agent, runs = _fake_agent()
    out = await with_team_gate(agent, tool).ainvoke({"messages": [("user", "x")]})
    assert runs["count"] == 1 and out["orkio_gate"]["blocked"] is False


@needs_langgraph
async def test_gate_accepts_plain_callable_and_syncs_first(client: OrkioClient, fake_run) -> None:
    from orkio_adapter.langgraph import with_team_gate

    agent, runs = _fake_agent()
    fake_run.queue('{"published": true, "sha": "f00"}')
    out = await with_team_gate(agent, lambda: TEAM_STATUS_CLEAR, client=client).ainvoke({"messages": [("user", "x")]})
    assert out["orkio_sync"] == {"published": True, "sha": "f00", "busy": False}
    assert fake_run.last["argv"][4] == "sync"


@needs_langgraph
async def test_gate_wraps_prebuilt_react_agent() -> None:
    pytest.importorskip("langgraph.prebuilt")
    import warnings

    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage
    from langgraph.prebuilt import create_react_agent
    from orkio_adapter.langgraph import with_team_gate

    class ToolFake(GenericFakeChatModel):
        def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
            return self

    model = ToolFake(messages=iter([AIMessage(content="first"), AIMessage(content="after nudge")]))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        agent = create_react_agent(model, tools=[])
    out = await with_team_gate(agent, FakeTeamStatusTool(TEAM_STATUS_TASKS, TEAM_STATUS_CLEAR)).ainvoke({"messages": [("user", "x")]})
    assert [m.content for m in out["messages"] if m.type == "ai"] == ["first", "after nudge"]


# ---- real MCP server (opt-in: spawns Node; never configured, so it touches no database)


@pytest.mark.skipif(os.environ.get("ORKIO_MCP_E2E") != "1", reason="set ORKIO_MCP_E2E=1 to spawn the real Orkio MCP server")
async def test_load_real_orkio_tools(tmp_path: Path) -> None:
    pytest.importorskip("langchain_mcp_adapters")
    from orkio_adapter.langgraph import load_orkio_tools

    root = Path(__file__).resolve().parents[3]
    workspace = tmp_path / "ws"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q", str(workspace)], check=True)
    # Empty values win over the repo .env (process.loadEnvFile never overrides), so the server is
    # "not configured": no presence, no reducers, no Git pushes.
    env = {**os.environ, "COWORK_NAME": "", "STDB_DB": ""}
    client = OrkioClient(root, workspace, env=env)
    tools = await load_orkio_tools(client)
    names = {t.name for t in tools}
    assert names == {
        "ask_orchestrator", "post_intent", "team_status", "pull_teammate", "check_with_team",
        "message_teammate", "agree", "escalate", "complete_task", "get_full_stack",
    }
