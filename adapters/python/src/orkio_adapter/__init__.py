"""Orkio adapter for Python agent frameworks.

The base package depends on nothing outside the standard library. Framework helpers live in
``orkio_adapter.langgraph`` (extra ``[langgraph]``) and ``orkio_adapter.crewai`` (extra ``[crewai]``).
"""

from .client import (
    DEFAULT_TIMEOUTS,
    McpServerParams,
    OrkioCLIError,
    OrkioClient,
    OrkioError,
    OrkioProtocolError,
    OrkioSetupError,
    OrkioTimeoutError,
    StatusResult,
    SyncResult,
)
from .gate import GateDecision, TeamConflict, TeamStatus, TeamTask, gate_decision, parse_team_status, tool_result_text

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_TIMEOUTS",
    "GateDecision",
    "McpServerParams",
    "OrkioCLIError",
    "OrkioClient",
    "OrkioError",
    "OrkioProtocolError",
    "OrkioSetupError",
    "OrkioTimeoutError",
    "StatusResult",
    "SyncResult",
    "TeamConflict",
    "TeamStatus",
    "TeamTask",
    "gate_decision",
    "parse_team_status",
    "tool_result_text",
]
