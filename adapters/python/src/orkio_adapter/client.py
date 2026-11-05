"""Typed wrapper around Orkio's adapter core CLI, plus the stdio launch spec for the MCP server.

The core CLI (``adapters/core/cli.ts``) owns all the real work: Git WIP snapshots on
``wip/<agent>``, SpacetimeDB reporting, presence and consent. This module only builds argv lists,
runs them without a shell, enforces timeouts and turns the CLI's JSON output into dataclasses.
It never reimplements publishing, so Python agents behave exactly like the Node adapters.

Call contract (``node --import tsx adapters/core/cli.ts <command> --adapter <id> ...``):

* ``sync``   -> one JSON line ``{"published": bool, "sha": str | null, "busy"?: bool}``
* ``status`` -> JSON ``{database, agent, online, status, intent, files, snapshotSha}``
* ``done``   -> JSON ``{"summary": str}``
* ``enable`` / ``start`` / ``stop`` -> human-readable text
* non-zero exit status on any error.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

__all__ = [
    "DEFAULT_TIMEOUTS",
    "McpServerParams",
    "OrkioCLIError",
    "OrkioClient",
    "OrkioError",
    "OrkioProtocolError",
    "OrkioSetupError",
    "OrkioTimeoutError",
    "StatusResult",
    "SyncResult",
]

# Seconds. sync pushes to the Git remote, so it gets the longest budget.
DEFAULT_TIMEOUTS: Mapping[str, float] = {
    "enable": 30.0,
    "sync": 120.0,
    "status": 30.0,
    "start": 30.0,
    "stop": 30.0,
    "done": 120.0,
}

_MAX_STDERR_CHARS = 2000
_COMMANDS = frozenset({"enable", "sync", "status", "start", "publish", "stop", "done"})
_ADAPTER_ID = re.compile(r"^[a-z0-9-]{1,40}$")  # same rule as adapters/core/runtime.ts


# ---- errors -------------------------------------------------------------------------------------


class OrkioError(RuntimeError):
    """Base class for every error this package raises."""


class OrkioSetupError(OrkioError):
    """The Orkio checkout, Node, tsx or the core CLI can't be found."""


class OrkioCLIError(OrkioError):
    """The core CLI exited non-zero. ``stderr`` holds its (truncated) explanation."""

    def __init__(self, command: str, returncode: int, stderr: str) -> None:
        self.command = command
        self.returncode = returncode
        self.stderr = stderr
        detail = stderr.strip() or "no error output"
        super().__init__(f"orkio {command} failed (exit {returncode}): {detail}")


class OrkioTimeoutError(OrkioError):
    """The core CLI didn't finish within the timeout. The child process has been killed."""

    def __init__(self, command: str, timeout: float) -> None:
        self.command = command
        self.timeout = timeout
        super().__init__(f"orkio {command} timed out after {timeout:g} s")


class OrkioProtocolError(OrkioError):
    """The core CLI exited 0 but its output wasn't the JSON the contract promises."""


# ---- results ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SyncResult:
    """Outcome of ``sync``. ``busy`` means another publish was in flight and this one was skipped."""

    published: bool
    sha: str | None
    busy: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class StatusResult:
    database: str
    agent: str
    online: bool
    status: str
    intent: str
    files: list[str] = field(default_factory=list)
    snapshot_sha: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class McpServerParams:
    """Everything needed to spawn Orkio's MCP server over stdio (exec form, no shell)."""

    command: str
    args: list[str]
    cwd: str
    env: dict[str, str] | None

    def to_dict(self) -> dict[str, Any]:
        return {"command": self.command, "args": list(self.args), "cwd": self.cwd, "env": self.env}

    def __repr__(self) -> str:  # never print the environment: it may hold credentials
        env = "None" if self.env is None else f"<{len(self.env)} vars>"
        return f"McpServerParams(command={self.command!r}, args={self.args!r}, cwd={self.cwd!r}, env={env})"


# ---- client -------------------------------------------------------------------------------------


class OrkioClient:
    """Drives Orkio's adapter core CLI for one agent workspace.

    Args:
        orkio_root: the Orkio checkout (holds ``adapters/core/cli.ts``, ``mcp/src/server.ts`` and
            ``node_modules/tsx``). Its ``.env`` supplies ``COWORK_NAME``, ``STDB_DB`` and friends.
        workspace: the agent's own Git clone, the working tree that gets snapshotted.
        adapter_id: the adapter name reported to Orkio (``langgraph``, ``crewai``, ...).
        label: human-readable name (``--label``). Omitted: the core CLI title-cases ``adapter_id``.
        agent_name: overrides ``COWORK_NAME`` for the child processes. Give every concurrently
            running workspace its own name; two agents must never share a ``wip/<agent>`` branch.
        node: the Node.js executable (24+). Defaults to ``node`` on ``PATH``.
        env: exact environment for child processes. Defaults to this process's environment
            (the same thing a shell or Claude Code would pass). ``agent_name`` is applied on top.
        timeouts: per-command overrides of :data:`DEFAULT_TIMEOUTS`, in seconds.
    """

    def __init__(
        self,
        orkio_root: str | os.PathLike[str],
        workspace: str | os.PathLike[str],
        adapter_id: str = "langgraph",
        label: str | None = None,
        *,
        agent_name: str | None = None,
        node: str = "node",
        env: Mapping[str, str] | None = None,
        timeouts: Mapping[str, float] | None = None,
    ) -> None:
        if not _ADAPTER_ID.match(adapter_id):
            raise ValueError("adapter_id must be 1-40 characters of a-z, 0-9 or '-'")
        self.orkio_root = Path(orkio_root).expanduser().resolve()
        self.workspace = Path(workspace).expanduser().resolve()
        self.adapter_id = adapter_id
        self.label = label.strip() if label and label.strip() else None
        self.agent_name = agent_name
        self.node = node
        self._env = dict(env) if env is not None else None
        self.timeouts = {**DEFAULT_TIMEOUTS, **(timeouts or {})}

    def __repr__(self) -> str:
        return (
            f"OrkioClient(orkio_root={str(self.orkio_root)!r}, workspace={str(self.workspace)!r}, "
            f"adapter_id={self.adapter_id!r}, label={self.label!r})"
        )

    # ---- paths and environment

    @property
    def cli_path(self) -> Path:
        return self.orkio_root / "adapters" / "core" / "cli.ts"

    @property
    def server_path(self) -> Path:
        return self.orkio_root / "mcp" / "src" / "server.ts"

    def child_env(self) -> dict[str, str]:
        """Environment for child processes. Not logged anywhere: it may contain credentials."""
        env = dict(self._env) if self._env is not None else dict(os.environ)
        if self.agent_name:
            env["COWORK_NAME"] = self.agent_name
        return env

    def _node_executable(self) -> str:
        resolved = shutil.which(self.node) if not os.path.isabs(self.node) else self.node
        if not resolved:
            raise OrkioSetupError(f"Node.js executable {self.node!r} not found on PATH (Orkio needs Node 24+).")
        return resolved

    def tsx_cli_path(self) -> Path:
        """tsx's command-line entry, resolved the same way hooks/src/install.ts does."""
        pkg_file = self.orkio_root / "node_modules" / "tsx" / "package.json"
        try:
            pkg = json.loads(pkg_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise OrkioSetupError(f"tsx isn't installed in {self.orkio_root}. Run `npm run setup` there first.") from None
        except (OSError, ValueError) as error:
            raise OrkioSetupError(f"Couldn't read {pkg_file}: {error}") from None
        binary = pkg.get("bin")
        entry = binary if isinstance(binary, str) else (binary or {}).get("tsx")
        if not entry:
            raise OrkioSetupError("Couldn't find tsx's command-line entry in its package.json.")
        return pkg_file.parent / entry

    # ---- argv

    def build_args(
        self,
        command: str,
        *,
        intent: str | None = None,
        force_report: bool = False,
        allow_publish: bool = False,
        allow_automatic: bool = False,
    ) -> list[str]:
        """The argv (without the node executable) for one core CLI call. Pure; no I/O."""
        if command not in _COMMANDS:
            raise ValueError(f"unknown orkio command {command!r}; expected one of {sorted(_COMMANDS)}")
        args = [
            "--import",
            "tsx",
            str(self.cli_path),
            command,
            # `--flag=value` form: node's strict parseArgs rejects a separate value starting with '-'.
            f"--adapter={self.adapter_id}",
        ]
        if self.label:
            args.append(f"--label={self.label}")
        args.append(f"--cwd={self.workspace}")
        if intent is not None:
            intent = " ".join(intent.split())
            if intent:
                args.append(f"--intent={intent}")
        if force_report:
            args.append("--force-report")
        if allow_publish:
            args.append("--allow-publish")
        if allow_automatic:
            args.append("--allow-automatic")
        return args

    # ---- running

    def run(self, command: str, *, timeout: float | None = None, **flags: Any) -> str:
        """Runs one core CLI command and returns its stdout. Raises an :class:`OrkioError` subclass."""
        if not self.cli_path.is_file():
            raise OrkioSetupError(f"Orkio core CLI not found at {self.cli_path}.")
        argv = [self._node_executable(), *self.build_args(command, **flags)]
        limit = timeout if timeout is not None else self.timeouts.get(command, 60.0)
        try:
            # cwd = Orkio checkout so `--import tsx` resolves from its node_modules;
            # the workspace travels as --cwd. List argv and shell=False: nothing is shell-parsed.
            completed = subprocess.run(
                argv,
                cwd=self.orkio_root,
                env=self.child_env(),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=limit,
                shell=False,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise OrkioTimeoutError(command, limit) from None
        except FileNotFoundError as error:
            raise OrkioSetupError(f"Couldn't start Node.js: {error}") from None
        if completed.returncode != 0:
            raise OrkioCLIError(command, completed.returncode, _tail(completed.stderr))
        return completed.stdout

    def _run_json(self, command: str, **kwargs: Any) -> dict[str, Any]:
        return _last_json_object(command, self.run(command, **kwargs))

    # ---- typed commands

    def enable(self, *, allow_publish: bool = False, allow_automatic: bool = False, timeout: float | None = None) -> str:
        """Records the human's consent. Call it only after your human approved publishing:
        the core CLI refuses (``OrkioCLIError``) without ``allow_publish=True``, and the continuous
        publisher additionally needs ``allow_automatic=True``."""
        return self.run("enable", allow_publish=allow_publish, allow_automatic=allow_automatic, timeout=timeout).strip()

    def sync(self, *, intent: str | None = None, force_report: bool = False, timeout: float | None = None) -> SyncResult:
        """Publishes the workspace's current working tree as this agent's WIP snapshot."""
        data = self._run_json("sync", intent=intent, force_report=force_report, timeout=timeout)
        published = data.get("published")
        sha = data.get("sha")
        busy = data.get("busy", False)
        if not isinstance(published, bool) or not (sha is None or isinstance(sha, str)) or not isinstance(busy, bool):
            raise OrkioProtocolError(f"orkio sync returned an unexpected shape (keys: {sorted(data)})")
        return SyncResult(published=published, sha=sha, busy=busy)

    def status(self, *, timeout: float | None = None) -> StatusResult:
        data = self._run_json("status", timeout=timeout)
        files = data.get("files") or []
        if not isinstance(files, list):
            raise OrkioProtocolError("orkio status returned non-list 'files'")
        sha = data.get("snapshotSha")
        return StatusResult(
            database=str(data.get("database") or ""),
            agent=str(data.get("agent") or ""),
            online=bool(data.get("online", False)),
            status=str(data.get("status") or ""),
            intent=str(data.get("intent") or ""),
            files=[str(f) for f in files],
            snapshot_sha=sha if isinstance(sha, str) and sha else None,
        )

    def done(self, *, timeout: float | None = None) -> str:
        """Posts a ``Done:`` intent for the last published snapshot and returns the CLI's summary.

        This is NOT a test result: it reports no green check. Run the MCP ``check_with_team`` tool
        (or ``complete_task`` for an orchestrator task) first; only those produce a green check.
        """
        data = self._run_json("done", timeout=timeout)
        summary = data.get("summary")
        if not isinstance(summary, str):
            raise OrkioProtocolError("orkio done returned no 'summary' string")
        return summary

    def start(self, *, timeout: float | None = None) -> str:
        """Starts the background publisher (requires prior ``enable(allow_publish=True, allow_automatic=True)``)."""
        return self.run("start", timeout=timeout).strip()

    def stop(self, *, timeout: float | None = None) -> str:
        """Stops the background publisher and its online presence."""
        return self.run("stop", timeout=timeout).strip()

    # ---- MCP

    def mcp_server_params(self) -> McpServerParams:
        """How to spawn Orkio's MCP server: ``node <tsx cli> <orkio>/mcp/src/server.ts``, cwd = workspace.

        Same exec form as hooks/src/install.ts. The cwd matters: pull_teammate and check_with_team
        act on the server process's working directory, so it must be the agent's own clone.
        """
        if not self.server_path.is_file():
            raise OrkioSetupError(f"Orkio MCP server not found at {self.server_path}.")
        return McpServerParams(
            command=self._node_executable(),
            args=[str(self.tsx_cli_path()), str(self.server_path)],
            cwd=str(self.workspace),
            env=self.child_env(),
        )


# ---- helpers ------------------------------------------------------------------------------------


def _tail(text: str) -> str:
    text = text.strip()
    return text if len(text) <= _MAX_STDERR_CHARS else "..." + text[-_MAX_STDERR_CHARS:]


def _last_json_object(command: str, stdout: str) -> dict[str, Any]:
    """The last stdout line that is a JSON object (the CLI may print progress lines before it)."""
    lines: Sequence[str] = [line.strip() for line in stdout.splitlines() if line.strip()]
    for line in reversed(lines):
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    # Multi-line (pretty-printed) JSON as a whole.
    try:
        value = json.loads(stdout)
    except ValueError:
        value = None
    if isinstance(value, dict):
        return value
    raise OrkioProtocolError(f"orkio {command} printed no JSON object ({len(stdout)} bytes of output)")
