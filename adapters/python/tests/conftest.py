"""Shared fixtures: a fake Orkio checkout and a recorder that stands in for subprocess.run."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from orkio_adapter import OrkioClient
import orkio_adapter.client as client_module


@pytest.fixture
def orkio_root(tmp_path: Path) -> Path:
    root = tmp_path / "orkio"
    (root / "adapters" / "core").mkdir(parents=True)
    (root / "adapters" / "core" / "cli.ts").write_text("// fake\n")
    (root / "mcp" / "src").mkdir(parents=True)
    (root / "mcp" / "src" / "server.ts").write_text("// fake\n")
    tsx = root / "node_modules" / "tsx"
    tsx.mkdir(parents=True)
    (tsx / "package.json").write_text(json.dumps({"name": "tsx", "bin": "./dist/cli.mjs"}))
    return root


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "my clone"  # a space on purpose: exec form must keep it one argument
    ws.mkdir()
    return ws


@dataclass
class FakeRun:
    """Records subprocess.run calls and replays queued results."""

    calls: list[dict[str, Any]] = field(default_factory=list)
    results: list[Any] = field(default_factory=list)

    def queue(self, stdout: str = "", stderr: str = "", returncode: int = 0) -> None:
        self.results.append(subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr))

    def raise_next(self, error: BaseException) -> None:
        self.results.append(error)

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append({"argv": argv, **kwargs})
        result = self.results.pop(0) if self.results else subprocess.CompletedProcess(argv, 0, "", "")
        if isinstance(result, BaseException):
            raise result
        return result

    @property
    def last(self) -> dict[str, Any]:
        return self.calls[-1]


@pytest.fixture
def fake_run(monkeypatch: pytest.MonkeyPatch) -> FakeRun:
    fake = FakeRun()
    monkeypatch.setattr(client_module.subprocess, "run", fake)
    monkeypatch.setattr(client_module.shutil, "which", lambda name: f"/usr/bin/{name}")
    return fake


@pytest.fixture
def client(orkio_root: Path, workspace: Path, fake_run: FakeRun) -> OrkioClient:
    return OrkioClient(orkio_root, workspace, adapter_id="langgraph", label="LangGraph", env={"PATH": "/usr/bin", "SECRET_TOKEN": "s3cr3t"})


# Texts in the exact shape of hooks/src/lib/format.ts teamStatus(); the gate parses these lines.
TEAM_STATUS_CLEAR = """[cowork] Team status
- alice: online, working, working on: login form
- bob: offline, idle
Verified facts (treat these as true):
- User.lastLogin is milliseconds since the Unix epoch
Before you change anything other files import, call the post_intent tool. To ask the orchestrator for something, use ask_orchestrator."""

TEAM_STATUS_TASKS = """[cowork] Team status
- alice: online, working
Your open tasks from the orchestrator:
- task #7 (waiting for review, don't start yet): Rename the API
- task #4: Add a dark mode toggle
Before you change anything other files import, call the post_intent tool. To ask the orchestrator for something, use ask_orchestrator."""

TEAM_STATUS_REVIEW_ONLY = """[cowork] Team status
Your open tasks from the orchestrator:
- task #7 (waiting for review, don't start yet): Rename the API
Before you change anything other files import, call the post_intent tool. To ask the orchestrator for something, use ask_orchestrator."""

TEAM_STATUS_CONFLICT = """[cowork] Team status
- alice: online, working
Your open tasks from the orchestrator:
- task #4: Add a dark mode toggle
Conflict #12 with bob is with both humans. Wait for their decision.
Conflict #9 with carol is open: settle it with message_teammate / agree / escalate first.
Before you change anything other files import, call the post_intent tool. To ask the orchestrator for something, use ask_orchestrator."""

TEAM_STATUS_ESCALATED_ONLY = """[cowork] Team status
Conflict #12 with bob is with both humans. Wait for their decision.
Before you change anything other files import, call the post_intent tool. To ask the orchestrator for something, use ask_orchestrator."""

NOT_CONFIGURED = "cowork isn't configured on this laptop: COWORK_NAME or STDB_DB is missing in repo 1's .env (see external/mcp.txt)."
