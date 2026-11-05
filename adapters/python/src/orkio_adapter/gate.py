"""Framework-free "check with the team before you finish" logic.

Approximates Claude Code's Stop hook (hooks/src/stop.ts): before an agent ends its turn, look at
its open conflict threads and its open orchestrator tasks; if something is hanging, push back once
with a concrete next step. Difference: stop.ts blocks on a conflict only when the thread's last
message isn't the agent's own; team_status doesn't expose who spoke last, so this gate blocks on
any open (not escalated) conflict. An escalated conflict never blocks (the humans have it), a task
waiting for review never blocks (it hasn't started), and every failure fails open.

Input is the text of the MCP ``team_status`` tool (hooks/src/lib/format.ts ``teamStatus``). That
wording is the contract here; tests/test_gate.py pins the lines this parser relies on.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

__all__ = ["GateDecision", "TeamConflict", "TeamStatus", "TeamTask", "gate_decision", "parse_team_status", "tool_result_text"]

MESSAGE_PREFIX = "[cowork]"
TEST_RULE = (
    "Keep every existing test as it is; tests are the team's shared contract. "
    "If you believe a test is wrong, say so in one line and stop, so a person can decide."
)

_TASKS_HEADER = "Your open tasks from the orchestrator:"
_TASK_LINE = re.compile(r"^- task #(?P<id>\d+)(?P<review> \(waiting for review[^)]*\))?: (?P<title>.*)$")
_CONFLICT_OPEN = re.compile(r"^Conflict #(?P<id>\d+) with (?P<other>.+?) is open:")
_CONFLICT_ESCALATED = re.compile(r"^Conflict #(?P<id>\d+) with (?P<other>.+?) is with both humans\.")
_NOT_CONFIGURED = "isn't configured"


@dataclass(frozen=True)
class TeamTask:
    id: int
    title: str
    waiting_review: bool = False


@dataclass(frozen=True)
class TeamConflict:
    id: int
    other: str
    escalated: bool = False


@dataclass(frozen=True)
class TeamStatus:
    tasks: list[TeamTask] = field(default_factory=list)
    conflicts: list[TeamConflict] = field(default_factory=list)
    #: False when the text wasn't a team status at all (not configured, error, empty).
    known: bool = True


@dataclass(frozen=True)
class GateDecision:
    block: bool
    reason: str = ""
    conflict_id: int | None = None
    task_id: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"blocked": self.block, "reason": self.reason, "conflict_id": self.conflict_id, "task_id": self.task_id}


def tool_result_text(result: Any) -> str:
    """Flattens whatever a LangChain/CrewAI MCP tool returned into plain text.

    Handles a str, a ToolMessage-like object with ``.content``, a list of MCP content blocks
    (``{"type": "text", "text": ...}``), a ``(content, artifact)`` tuple, or a list of strings.
    """
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, tuple) and result:
        return tool_result_text(result[0])
    content = getattr(result, "content", None)
    if content is not None and not isinstance(result, dict):
        return tool_result_text(content)
    if isinstance(result, dict):
        if isinstance(result.get("text"), str):
            return result["text"]
        if "content" in result:
            return tool_result_text(result["content"])
        return ""
    if isinstance(result, (list, tuple)):
        return "\n".join(part for part in (tool_result_text(item) for item in result) if part)
    text = getattr(result, "text", None)
    return text if isinstance(text, str) else str(result)


def parse_team_status(text: str) -> TeamStatus:
    """Reads tasks and conflict threads out of the team_status tool's text."""
    if not text or MESSAGE_PREFIX not in text or _NOT_CONFIGURED in text:
        return TeamStatus(known=False)
    tasks: list[TeamTask] = []
    conflicts: list[TeamConflict] = []
    in_tasks = False
    for raw in text.splitlines():
        line = raw.strip()
        if line == _TASKS_HEADER:
            in_tasks = True
            continue
        if in_tasks:
            match = _TASK_LINE.match(line)
            if match:
                tasks.append(TeamTask(int(match["id"]), match["title"].strip(), bool(match["review"])))
                continue
            in_tasks = False
        if match := _CONFLICT_OPEN.match(line):
            conflicts.append(TeamConflict(int(match["id"]), match["other"]))
        elif match := _CONFLICT_ESCALATED.match(line):
            conflicts.append(TeamConflict(int(match["id"]), match["other"], escalated=True))
    return TeamStatus(tasks=tasks, conflicts=conflicts)


def gate_decision(status: TeamStatus) -> GateDecision:
    """Block on the oldest open (not escalated) conflict, else on the oldest assigned task."""
    if not status.known:
        return GateDecision(block=False, reason="team status unavailable; not blocking")
    open_conflicts = sorted((c for c in status.conflicts if not c.escalated), key=lambda c: c.id)
    if open_conflicts:
        c = open_conflicts[0]
        return GateDecision(
            block=True,
            conflict_id=c.id,
            reason=(
                f"{MESSAGE_PREFIX} Conflict #{c.id} with {c.other} is open. Before you finish, reply with "
                f"message_teammate({c.id}, ...), agree({c.id}, \"<the fact>\") once your side is done and "
                f"check_with_team is green, or escalate({c.id}, \"<why>\"). {TEST_RULE}"
            ),
        )
    assigned = sorted((t for t in status.tasks if not t.waiting_review), key=lambda t: t.id)
    if assigned:
        t = assigned[0]
        return GateDecision(
            block=True,
            task_id=t.id,
            reason=(
                f"{MESSAGE_PREFIX} Task #{t.id} (\"{t.title}\") is still open. If it's done, call check_with_team "
                f"and then complete_task({t.id}, \"<what you did>\"). If you're waiting on a teammate, tell them "
                "with message_teammate in your conflict thread, then you can stop."
            ),
        )
    return GateDecision(block=False)
