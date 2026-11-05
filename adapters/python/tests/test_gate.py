"""Gate logic: parsing team_status text and the Stop-hook-equivalent decision."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from orkio_adapter import gate_decision, parse_team_status, tool_result_text
from conftest import (
    NOT_CONFIGURED,
    TEAM_STATUS_CLEAR,
    TEAM_STATUS_CONFLICT,
    TEAM_STATUS_ESCALATED_ONLY,
    TEAM_STATUS_REVIEW_ONLY,
    TEAM_STATUS_TASKS,
)


def test_clear_status_lets_agent_finish() -> None:
    status = parse_team_status(TEAM_STATUS_CLEAR)
    assert status.known and status.tasks == [] and status.conflicts == []
    assert gate_decision(status).block is False


def test_assigned_task_blocks_and_review_task_does_not() -> None:
    status = parse_team_status(TEAM_STATUS_TASKS)
    assert [(t.id, t.waiting_review) for t in status.tasks] == [(7, True), (4, False)]
    decision = gate_decision(status)
    assert decision.block and decision.task_id == 4
    assert "complete_task(4" in decision.reason and decision.reason.startswith("[cowork]")


def test_waiting_review_only_does_not_block() -> None:
    assert gate_decision(parse_team_status(TEAM_STATUS_REVIEW_ONLY)).block is False


def test_open_conflict_beats_task_and_escalated_is_ignored() -> None:
    status = parse_team_status(TEAM_STATUS_CONFLICT)
    assert {(c.id, c.other, c.escalated) for c in status.conflicts} == {(12, "bob", True), (9, "carol", False)}
    decision = gate_decision(status)
    assert decision.block and decision.conflict_id == 9
    assert "message_teammate(9" in decision.reason and "escalate(9" in decision.reason
    assert "Keep every existing test" in decision.reason


def test_escalated_only_does_not_block() -> None:
    assert gate_decision(parse_team_status(TEAM_STATUS_ESCALATED_ONLY)).block is False


def test_oldest_conflict_first() -> None:
    text = TEAM_STATUS_CLEAR + "\nConflict #30 with a is open: x\nConflict #3 with b is open: y"
    assert gate_decision(parse_team_status(text)).conflict_id == 3


@pytest.mark.parametrize("text", ["", NOT_CONFIGURED, "team_status failed: boom", "random words"])
def test_unknown_status_fails_open(text: str) -> None:
    status = parse_team_status(text)
    assert status.known is False
    assert gate_decision(status).block is False


def test_task_lines_only_count_under_header() -> None:
    text = "[cowork] Team status\n- task #5: looks like a task but is a plan line\n"
    assert parse_team_status(text).tasks == []


@pytest.mark.parametrize(
    "result",
    [
        TEAM_STATUS_TASKS,
        [{"type": "text", "text": TEAM_STATUS_TASKS}],
        (TEAM_STATUS_TASKS, None),
        SimpleNamespace(content=TEAM_STATUS_TASKS),
        SimpleNamespace(content=[{"type": "text", "text": TEAM_STATUS_TASKS}]),
        {"content": [{"type": "text", "text": TEAM_STATUS_TASKS}]},
        [TEAM_STATUS_TASKS],
    ],
)
def test_tool_result_text_shapes(result: object) -> None:
    assert tool_result_text(result) == TEAM_STATUS_TASKS


def test_tool_result_text_none() -> None:
    assert tool_result_text(None) == ""
