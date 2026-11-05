"""CrewAI helpers. The callback needs no framework; server params need `mcp`; the adapter needs crewai-tools."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from orkio_adapter import OrkioCLIError, OrkioClient
from orkio_adapter.crewai import orkio_crewai_server_params, orkio_crewai_tools, orkio_task_callback


def test_task_callback_syncs_with_intent(client: OrkioClient, fake_run) -> None:
    fake_run.queue('{"published": true, "sha": "abc"}')
    seen = []
    callback = orkio_task_callback(client, intent=lambda output: "Backend done", then=seen.append)
    output = SimpleNamespace(raw="model output that must not be published")
    callback(output)
    argv = fake_run.last["argv"]
    assert argv[4] == "sync" and argv[-1] == "--intent=Backend done"
    assert "model output" not in " ".join(argv)
    assert seen == [output]


def test_task_callback_without_intent_publishes_no_text(client: OrkioClient, fake_run) -> None:
    fake_run.queue('{"published": true, "sha": "abc"}')
    orkio_task_callback(client)(SimpleNamespace(description="secret prompt text", raw="x"))
    assert not any(a.startswith("--intent") for a in fake_run.last["argv"])


def test_task_callback_fails_open(client: OrkioClient, fake_run) -> None:
    fake_run.queue(stderr="no network", returncode=1)
    orkio_task_callback(client)(SimpleNamespace(raw=""))  # must not raise


def test_task_callback_raise_on_error(client: OrkioClient, fake_run) -> None:
    fake_run.queue(stderr="no network", returncode=1)
    with pytest.raises(OrkioCLIError):
        orkio_task_callback(client, raise_on_error=True)(SimpleNamespace(raw=""))


def test_server_params(client: OrkioClient, workspace: Path) -> None:
    pytest.importorskip("mcp")
    params = orkio_crewai_server_params(client)
    assert params.command == "/usr/bin/node"
    assert params.args[1].endswith("server.ts")
    assert str(params.cwd) == str(workspace.resolve())
    assert params.env is not None


def test_crewai_tools_passes_params_and_filter(client: OrkioClient, monkeypatch) -> None:
    crewai_tools = pytest.importorskip("crewai_tools")
    captured = {}

    class FakeAdapter:
        def __init__(self, serverparams, *tool_names, connect_timeout=30):
            captured.update(params=serverparams, names=tool_names, timeout=connect_timeout)

    monkeypatch.setattr(crewai_tools, "MCPServerAdapter", FakeAdapter)
    orkio_crewai_tools(client, "team_status", "check_with_team", connect_timeout=90)
    assert captured["names"] == ("team_status", "check_with_team")
    assert captured["timeout"] == 90
    assert captured["params"].args[1].endswith("server.ts")


def test_callback_signature_matches_crewai_task() -> None:
    task_module = pytest.importorskip("crewai.task")
    assert "callback" in task_module.Task.model_fields
