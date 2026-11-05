"""CrewAI integration.

* :func:`orkio_crewai_server_params` -> ``mcp.StdioServerParameters`` for Orkio's MCP server.
* :func:`orkio_crewai_tools` -> a ``crewai_tools.MCPServerAdapter`` (use it as a context manager).
* :func:`orkio_task_callback` -> a ``Task(callback=...)`` / ``Crew(task_callback=...)`` that
  publishes a WIP snapshot after each task.

Why MCPServerAdapter and not ``Agent(mcps=[MCPServerStdio(...)])``: CrewAI's ``MCPServerStdio``
(crewai 1.15) has no ``cwd`` field, and Orkio's pull_teammate / check_with_team act on the server
process's working directory, which must be the agent's own clone. ``StdioServerParameters`` has
``cwd``. ``crewai`` / ``crewai-tools`` / ``mcp`` are imported lazily (extra ``[crewai]``).
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Callable
from typing import Any

from .client import OrkioClient, OrkioError

__all__ = ["orkio_crewai_server_params", "orkio_crewai_tools", "orkio_task_callback"]

log = logging.getLogger("orkio_adapter")

_EXTRA_HINT = "Install the extra: pip install 'orkio-adapter[crewai]'"


def orkio_crewai_server_params(client: OrkioClient) -> Any:
    """``mcp.StdioServerParameters`` (command, args, cwd = workspace, env)."""
    try:
        from mcp import StdioServerParameters  # noqa: PLC0415
    except ImportError as error:
        raise ImportError(f"the mcp package is required. {_EXTRA_HINT}") from error
    params = client.mcp_server_params()
    return StdioServerParameters(command=params.command, args=list(params.args), cwd=params.cwd, env=params.env)


def orkio_crewai_tools(client: OrkioClient, *tool_names: str, connect_timeout: int = 60) -> Any:
    """Starts Orkio's MCP server and returns the ``MCPServerAdapter``; iterate it for CrewAI tools.

    Prefer ``with orkio_crewai_tools(client) as tools: Agent(..., tools=tools)`` so the server
    process is stopped afterwards. ``tool_names`` filters the tools (e.g. ``"team_status"``).
    """
    try:
        from crewai_tools import MCPServerAdapter  # noqa: PLC0415
    except ImportError as error:
        raise ImportError(f"crewai-tools is required. {_EXTRA_HINT}") from error
    return MCPServerAdapter(orkio_crewai_server_params(client), *tool_names, connect_timeout=connect_timeout)


def orkio_task_callback(
    client: OrkioClient,
    *,
    intent: str | Callable[[Any], str | None] | None = None,
    then: Callable[[Any], Any] | None = None,
    raise_on_error: bool = False,
) -> Callable[[Any], Any]:
    """A CrewAI task callback that publishes the workspace after each task.

    ``intent`` is a fixed string or ``intent(task_output) -> str | None``. It is shown to teammates,
    so write a one-line summary; don't pass the task description or the model's raw output.
    ``then`` chains your own callback. Sync failures are logged and swallowed unless
    ``raise_on_error``, so a publishing hiccup never fails the crew.
    """

    def orkio_after_task(output: Any) -> Any:
        text = intent(output) if callable(intent) else intent
        try:
            result = client.sync(intent=text)
            log.info("orkio: published=%s sha=%s", result.published, result.sha)
        except OrkioError as error:
            if raise_on_error:
                raise
            log.warning("orkio sync after task failed: %s", error)
        if then is not None:
            value = then(output)
            if inspect.isawaitable(value):
                return value
        return None

    return orkio_after_task
