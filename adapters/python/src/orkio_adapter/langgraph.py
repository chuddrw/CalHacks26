"""LangGraph / LangChain integration.

* :func:`orkio_mcp_connections` -> the dict ``langchain_mcp_adapters.client.MultiServerMCPClient`` takes.
* :func:`orkio_mcp_config` -> the ``{"mcpServers": ...}`` dict for the beta ``langchain.mcp.MCPAdapter``.
* :func:`load_orkio_tools` -> the ten Orkio MCP tools as LangChain tools.
* :func:`orkio_sync_node` -> a graph node that publishes a WIP snapshot after file-editing steps.
* :func:`with_team_gate` -> wraps an agent graph so it can't finish with an open conflict or task.

``langgraph``, ``langchain-core`` and ``langchain-mcp-adapters`` are imported lazily, so importing
this module (and the base package) works without them; the functions that need them raise a clear
ImportError naming the ``[langgraph]`` extra.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Callable, Collection, Mapping
from typing import Annotated, Any, NotRequired, TypedDict

from .client import OrkioClient, OrkioError
from .gate import GateDecision, gate_decision, parse_team_status, tool_result_text

__all__ = [
    "DEFAULT_EDIT_TOOLS",
    "last_tool_names",
    "find_tool",
    "load_orkio_tools",
    "orkio_mcp_config",
    "orkio_mcp_connections",
    "orkio_sync_node",
    "team_gate_node",
    "with_team_gate",
]

log = logging.getLogger("orkio_adapter")

SERVER_NAME = "cowork"  # same name hooks/src/install.ts gives the server in .mcp.json

#: Tool names that usually mean "files on disk changed". Pass your own set to orkio_sync_node.
DEFAULT_EDIT_TOOLS: frozenset[str] = frozenset(
    {
        "write_file", "edit_file", "create_file", "delete_file", "move_file", "apply_patch",
        "str_replace_editor", "file_write", "shell", "bash", "terminal", "run_shell_command",
        "pull_teammate",
    }
)

_EXTRA_HINT = "Install the extra: pip install 'orkio-adapter[langgraph]'"


def _require(module: str) -> Any:
    try:
        return __import__(module, fromlist=["_"])
    except ImportError as error:
        raise ImportError(f"{module} is required for this function. {_EXTRA_HINT}") from error


# ---- MCP connection ------------------------------------------------------------------------------


def orkio_mcp_connections(client: OrkioClient, *, server_name: str = SERVER_NAME) -> dict[str, dict[str, Any]]:
    """``{server_name: StdioConnection}`` for ``MultiServerMCPClient(connections)``."""
    params = client.mcp_server_params()
    connection: dict[str, Any] = {
        "transport": "stdio",
        "command": params.command,
        "args": list(params.args),
        "cwd": params.cwd,
    }
    if params.env is not None:
        connection["env"] = params.env
    return {server_name: connection}


def orkio_mcp_config(client: OrkioClient, *, server_name: str = SERVER_NAME) -> dict[str, Any]:
    """``{"mcpServers": {...}}`` (FastMCP config shape) for the beta ``langchain.mcp.MCPAdapter``."""
    params = client.mcp_server_params()
    server: dict[str, Any] = {"command": params.command, "args": list(params.args), "cwd": params.cwd}
    if params.env is not None:
        server["env"] = params.env
    return {"mcpServers": {server_name: server}}


async def load_orkio_tools(
    client: OrkioClient,
    *,
    server_name: str = SERVER_NAME,
    tool_names: Collection[str] | None = None,
) -> list[Any]:
    """The Orkio MCP tools as LangChain ``BaseTool`` objects (each call opens a short MCP session).

    Pass ``tool_names`` to keep only some of them, e.g. ``{"team_status", "check_with_team"}``.
    """
    mcp_client_module = _require("langchain_mcp_adapters.client")
    mcp = mcp_client_module.MultiServerMCPClient(orkio_mcp_connections(client, server_name=server_name))
    tools = await mcp.get_tools(server_name=server_name)
    if tool_names is not None:
        wanted = set(tool_names)
        tools = [tool for tool in tools if tool.name in wanted]
    return list(tools)


def find_tool(tools: Collection[Any], name: str) -> Any:
    """The tool called ``name`` (also matches a ``<server>_<name>`` prefixed name)."""
    for tool in tools:
        tool_name = getattr(tool, "name", "")
        if tool_name == name or tool_name.endswith(f"_{name}"):
            return tool
    raise LookupError(f"no tool named {name!r} among {[getattr(t, 'name', '?') for t in tools]}")


# ---- state ---------------------------------------------------------------------------------------


def _messages(state: Any) -> list[Any]:
    if isinstance(state, Mapping):
        return list(state.get("messages") or [])
    return list(getattr(state, "messages", None) or [])


def _tool_calls(message: Any) -> list[Any]:
    calls = message.get("tool_calls") if isinstance(message, Mapping) else getattr(message, "tool_calls", None)
    return list(calls or [])


def last_tool_names(state: Any) -> set[str]:
    """Names of the tools the most recent tool-calling AI message asked for."""
    for message in reversed(_messages(state)):
        calls = _tool_calls(message)
        if calls:
            return {str(c.get("name") if isinstance(c, Mapping) else getattr(c, "name", "")) for c in calls}
        kind = message.get("type") if isinstance(message, Mapping) else getattr(message, "type", None)
        if kind == "human":  # a new human turn: nothing was edited since
            return set()
    return set()


# ---- sync node -----------------------------------------------------------------------------------


def orkio_sync_node(
    client: OrkioClient,
    *,
    intent: str | Callable[[Any], str | None] | None = None,
    after_tools: Collection[str] | None = DEFAULT_EDIT_TOOLS,
    state_key: str = "orkio_sync",
    force_report: bool = False,
    raise_on_error: bool = False,
) -> Callable[[Any], dict[str, Any]]:
    """A LangGraph node that publishes the workspace as a WIP snapshot and records the result.

    Put it after your tool node (``tools -> orkio_sync -> agent``). With ``after_tools`` (default:
    :data:`DEFAULT_EDIT_TOOLS`), it only publishes when the last AI message called one of those
    tools; pass ``None`` to publish every time. Failures fail open: the error goes into
    ``state[state_key]["error"]`` and the graph continues, unless ``raise_on_error``.

    ``intent`` is a fixed string or ``intent(state) -> str | None``. It is published to teammates,
    so give a one-line summary, never the raw prompt.
    """
    wanted = None if after_tools is None else frozenset(after_tools)

    def orkio_sync(state: Any) -> dict[str, Any]:
        if wanted is not None and not (last_tool_names(state) & wanted):
            return {}
        text = intent(state) if callable(intent) else intent
        try:
            result = client.sync(intent=text, force_report=force_report)
        except OrkioError as error:
            if raise_on_error:
                raise
            log.warning("orkio sync failed: %s", error)
            return {state_key: {"published": False, "sha": None, "busy": False, "error": str(error)}}
        return {state_key: result.to_dict()}

    return orkio_sync


# ---- team gate -----------------------------------------------------------------------------------


async def _call_team_status(team_status: Any) -> str:
    if hasattr(team_status, "ainvoke"):
        return tool_result_text(await team_status.ainvoke({}))
    result = team_status()
    if inspect.isawaitable(result):
        result = await result
    return tool_result_text(result)


def team_gate_node(
    team_status: Any,
    *,
    max_nudges: int = 1,
    client: OrkioClient | None = None,
) -> Callable[[Any], Any]:
    """The async gate node used by :func:`with_team_gate`; exposed for hand-built graphs.

    ``team_status`` is the MCP ``team_status`` tool (anything with ``ainvoke``) or a callable
    returning its text. With ``client``, the workspace is published first so teammates see the
    final state. Returns ``{"orkio_gate": {...}}`` plus, when blocking, a ``[cowork]`` human
    message and an incremented ``orkio_gate_nudges``.
    """
    from langchain_core.messages import HumanMessage  # noqa: PLC0415  (optional dependency)

    async def team_gate(state: Any) -> dict[str, Any]:
        nudges = int((state.get("orkio_gate_nudges") if isinstance(state, Mapping) else 0) or 0)
        if nudges >= max_nudges:
            return {"orkio_gate": GateDecision(block=False, reason="already nudged this turn").to_dict()}
        update: dict[str, Any] = {}
        if client is not None:
            try:
                update["orkio_sync"] = (await asyncio.to_thread(client.sync)).to_dict()
            except OrkioError as error:
                log.warning("orkio sync before team gate failed: %s", error)
        try:
            text = await _call_team_status(team_status)
        except Exception as error:  # noqa: BLE001  fail open, like the Stop hook
            log.warning("team_status failed; letting the agent finish: %s", error)
            return {**update, "orkio_gate": GateDecision(block=False, reason="team_status failed").to_dict()}
        decision = gate_decision(parse_team_status(text))
        update["orkio_gate"] = decision.to_dict()
        if decision.block:
            update["messages"] = [HumanMessage(content=decision.reason)]
            update["orkio_gate_nudges"] = nudges + 1
        return update

    return team_gate


def with_team_gate(
    agent: Any,
    team_status: Any,
    *,
    max_nudges: int = 1,
    client: OrkioClient | None = None,
    state_schema: type | None = None,
    **compile_kwargs: Any,
) -> Any:
    """Wraps a compiled agent graph (``create_react_agent``, ``langchain.agents.create_agent`` or
    your own ``StateGraph`` with a ``messages`` key) in a "check with the team before finishing" loop::

        START -> reset -> agent -> team_gate --(open conflict/task, nudges left)--> agent
                                           \\--(clear, or nudged max_nudges times)--> END

    ``max_nudges`` defaults to 1, like the Stop hook's single push-back per turn (the counter
    resets on every invocation). Invoke the result with ``ainvoke``/``astream``: MCP tools are
    async. ``compile_kwargs`` (e.g. ``checkpointer=``) go to ``StateGraph.compile``.
    """
    graph_module = _require("langgraph.graph")
    _require("langchain_core.messages")
    from langgraph.graph.message import add_messages  # noqa: PLC0415

    if state_schema is None:
        # Functional form: real objects, not strings, since this module uses postponed annotations.
        state_schema = TypedDict(
            "OrkioGateState",
            {
                "messages": Annotated[list, add_messages],
                "orkio_gate": NotRequired[dict[str, Any]],
                "orkio_gate_nudges": NotRequired[int],
                "orkio_sync": NotRequired[dict[str, Any]],
            },
        )

    def reset(_: Any) -> dict[str, Any]:
        return {"orkio_gate_nudges": 0}

    def route(state: Any) -> str:
        gate = state.get("orkio_gate") or {}
        return "agent" if gate.get("blocked") else graph_module.END

    builder = graph_module.StateGraph(state_schema)
    builder.add_node("orkio_reset", reset)
    builder.add_node("agent", agent)
    builder.add_node("team_gate", team_gate_node(team_status, max_nudges=max_nudges, client=client))
    builder.add_edge(graph_module.START, "orkio_reset")
    builder.add_edge("orkio_reset", "agent")
    builder.add_edge("agent", "team_gate")
    builder.add_conditional_edges("team_gate", route, ["agent", graph_module.END])
    return builder.compile(**compile_kwargs)
