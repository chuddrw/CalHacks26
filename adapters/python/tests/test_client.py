"""OrkioClient: argv building, subprocess handling, JSON parsing and error mapping (subprocess mocked)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from orkio_adapter import (
    OrkioCLIError,
    OrkioClient,
    OrkioProtocolError,
    OrkioSetupError,
    OrkioTimeoutError,
    StatusResult,
    SyncResult,
)


def test_build_args_full_contract(client: OrkioClient, orkio_root: Path, workspace: Path) -> None:
    args = client.build_args("sync", intent="  Build the\nlogin form ", force_report=True, allow_publish=True, allow_automatic=True)
    assert args == [
        "--import", "tsx", str(orkio_root.resolve() / "adapters" / "core" / "cli.ts"), "sync",
        "--adapter=langgraph", "--label=LangGraph", f"--cwd={workspace.resolve()}",
        "--intent=Build the login form", "--force-report", "--allow-publish", "--allow-automatic",
    ]


def test_build_args_minimal_and_blank_intent_dropped(client: OrkioClient) -> None:
    args = client.build_args("status", intent="   ")
    assert not any(a.startswith("--intent") for a in args) and "--force-report" not in args and "--allow-publish" not in args
    assert args[3] == "status"


def test_build_args_rejects_unknown_command(client: OrkioClient) -> None:
    with pytest.raises(ValueError):
        client.build_args("rm -rf /")


def test_label_omitted_lets_core_cli_default_it(orkio_root: Path, workspace: Path) -> None:
    args = OrkioClient(orkio_root, workspace, adapter_id="crewai", label="  ").build_args("sync")
    assert "--label" not in args and args[4] == "--adapter=crewai"


@pytest.mark.parametrize("bad", ["", "a b", "x;y", "../z", "Lang_Graph", "a" * 41])
def test_adapter_id_validated(orkio_root: Path, workspace: Path, bad: str) -> None:
    with pytest.raises(ValueError):
        OrkioClient(orkio_root, workspace, adapter_id=bad)


def test_run_uses_exec_form_without_shell(client: OrkioClient, fake_run, orkio_root: Path) -> None:
    fake_run.queue('{"published": true, "sha": "abc123"}\n')
    client.sync()
    call = fake_run.last
    assert isinstance(call["argv"], list)
    assert call["argv"][0] == "/usr/bin/node"
    assert call["shell"] is False
    assert call["cwd"] == orkio_root.resolve()  # so `--import tsx` resolves from Orkio's node_modules
    assert call["stdin"] is subprocess.DEVNULL
    assert call["timeout"] == 120.0
    assert call["check"] is False


def test_sync_parses_last_json_line_after_progress_output(client: OrkioClient, fake_run) -> None:
    fake_run.queue('Pushing wip/alice...\n{"published": true, "sha": "deadbeef", "busy": false}\n')
    assert client.sync(intent="Login form") == SyncResult(published=True, sha="deadbeef", busy=False)
    assert fake_run.last["argv"][-1] == "--intent=Login form"


def test_sync_busy_and_null_sha(client: OrkioClient, fake_run) -> None:
    fake_run.queue('{"published": false, "sha": null, "busy": true}')
    result = client.sync()
    assert result == SyncResult(published=False, sha=None, busy=True)
    assert result.to_dict() == {"published": False, "sha": None, "busy": True}


@pytest.mark.parametrize("stdout", ["", "not json", "[1, 2]", '{"published": "yes", "sha": null}', '{"sha": 5, "published": true}'])
def test_sync_rejects_bad_output(client: OrkioClient, fake_run, stdout: str) -> None:
    fake_run.queue(stdout)
    with pytest.raises(OrkioProtocolError):
        client.sync()


def test_protocol_error_does_not_echo_output(client: OrkioClient, fake_run) -> None:
    fake_run.queue("token=s3cr3t")
    with pytest.raises(OrkioProtocolError) as info:
        client.sync()
    assert "s3cr3t" not in str(info.value)


def test_pretty_printed_status_json(client: OrkioClient, fake_run) -> None:
    fake_run.queue('{\n  "database": "orkio-db",\n  "agent": "alice",\n  "online": true,\n  "status": "working",\n'
                   '  "intent": "Login form",\n  "files": ["src/a.ts"],\n  "snapshotSha": "abc"\n}\n')
    assert client.status() == StatusResult("orkio-db", "alice", True, "working", "Login form", ["src/a.ts"], "abc")


def test_status_tolerates_missing_optional_fields(client: OrkioClient, fake_run) -> None:
    fake_run.queue('{"database": "db", "agent": "a", "online": false, "status": "idle", "intent": "", "files": [], "snapshotSha": null}')
    status = client.status()
    assert status.snapshot_sha is None and status.files == [] and status.online is False


def test_done_returns_summary(client: OrkioClient, fake_run) -> None:
    fake_run.queue('{"summary": "Published abc as done"}')
    assert client.done() == "Published abc as done"
    assert fake_run.last["argv"][4] == "done"


def test_done_without_summary_is_protocol_error(client: OrkioClient, fake_run) -> None:
    fake_run.queue('{"ok": true}')
    with pytest.raises(OrkioProtocolError):
        client.done()


def test_enable_requires_explicit_consent_flags(client: OrkioClient, fake_run) -> None:
    fake_run.queue(stderr="Use --allow-publish only after approving GitHub snapshots and database reporting.", returncode=1)
    with pytest.raises(OrkioCLIError, match="approving"):
        client.enable()
    assert "--allow-publish" not in fake_run.last["argv"]
    fake_run.queue("Publishing enabled.\n")
    assert client.enable(allow_publish=True) == "Publishing enabled."
    assert "--allow-publish" in fake_run.last["argv"] and "--allow-automatic" not in fake_run.last["argv"]


def test_start_and_stop(client: OrkioClient, fake_run) -> None:
    fake_run.queue("Publisher started (pid 42).\n")
    assert client.start() == "Publisher started (pid 42)."
    fake_run.queue("Publisher stopped.\n")
    assert client.stop() == "Publisher stopped."
    assert [c["argv"][4] for c in fake_run.calls] == ["start", "stop"]


def test_non_zero_exit_raises_cli_error_with_stderr(client: OrkioClient, fake_run) -> None:
    fake_run.queue(stdout="", stderr="Publishing is disabled. Run enable --allow-publish first.\n", returncode=2)
    with pytest.raises(OrkioCLIError) as info:
        client.sync()
    assert info.value.returncode == 2
    assert "Publishing is disabled" in str(info.value)


def test_long_stderr_is_truncated(client: OrkioClient, fake_run) -> None:
    fake_run.queue(stderr="x" * 10_000 + "END", returncode=1)
    with pytest.raises(OrkioCLIError) as info:
        client.status()
    assert len(info.value.stderr) <= 2003 and info.value.stderr.endswith("END")


def test_timeout_maps_to_orkio_timeout(client: OrkioClient, fake_run) -> None:
    fake_run.raise_next(subprocess.TimeoutExpired(cmd="node", timeout=1))
    with pytest.raises(OrkioTimeoutError) as info:
        client.status(timeout=1)
    assert info.value.timeout == 1
    assert fake_run.last["timeout"] == 1


def test_timeout_overrides(orkio_root: Path, workspace: Path, fake_run) -> None:
    client = OrkioClient(orkio_root, workspace, timeouts={"sync": 5})
    fake_run.queue('{"published": false, "sha": null}')
    client.sync()
    assert fake_run.last["timeout"] == 5


def test_missing_node_is_setup_error(client: OrkioClient, fake_run, monkeypatch) -> None:
    import orkio_adapter.client as module

    monkeypatch.setattr(module.shutil, "which", lambda name: None)
    with pytest.raises(OrkioSetupError, match="Node.js"):
        client.sync()
    assert fake_run.calls == []


def test_file_not_found_from_subprocess_is_setup_error(client: OrkioClient, fake_run) -> None:
    fake_run.raise_next(FileNotFoundError("node"))
    with pytest.raises(OrkioSetupError):
        client.status()


def test_missing_core_cli_is_setup_error(client: OrkioClient, fake_run, orkio_root: Path) -> None:
    (orkio_root / "adapters" / "core" / "cli.ts").unlink()
    with pytest.raises(OrkioSetupError, match="core CLI"):
        client.sync()
    assert fake_run.calls == []


def test_agent_name_overrides_cowork_name(orkio_root: Path, workspace: Path, fake_run) -> None:
    client = OrkioClient(orkio_root, workspace, agent_name="alice-langgraph", env={"COWORK_NAME": "alice", "PATH": "/bin"})
    fake_run.queue('{"published": true, "sha": "a"}')
    client.sync()
    assert fake_run.last["env"]["COWORK_NAME"] == "alice-langgraph"
    assert fake_run.last["env"]["PATH"] == "/bin"


def test_env_defaults_to_process_env(orkio_root: Path, workspace: Path, fake_run, monkeypatch) -> None:
    monkeypatch.setenv("ORKIO_TEST_MARKER", "1")
    client = OrkioClient(orkio_root, workspace)
    fake_run.queue('{"published": true, "sha": "a"}')
    client.sync()
    assert fake_run.last["env"]["ORKIO_TEST_MARKER"] == "1"


def test_mcp_server_params_exec_form(client: OrkioClient, orkio_root: Path, workspace: Path) -> None:
    params = client.mcp_server_params()
    root = orkio_root.resolve()
    assert params.command == "/usr/bin/node"
    assert params.args == [str(root / "node_modules" / "tsx" / "dist" / "cli.mjs"), str(root / "mcp" / "src" / "server.ts")]
    assert params.cwd == str(workspace.resolve())
    assert params.env is not None and params.env["SECRET_TOKEN"] == "s3cr3t"
    assert "s3cr3t" not in repr(params)
    assert "s3cr3t" not in repr(client)


def test_mcp_server_params_tsx_bin_object(client: OrkioClient, orkio_root: Path) -> None:
    (orkio_root / "node_modules" / "tsx" / "package.json").write_text('{"bin": {"tsx": "./dist/cli.mjs"}}')
    assert client.mcp_server_params().args[0].endswith("cli.mjs")


def test_mcp_server_params_without_tsx(client: OrkioClient, orkio_root: Path) -> None:
    (orkio_root / "node_modules" / "tsx" / "package.json").unlink()
    with pytest.raises(OrkioSetupError, match="npm run setup"):
        client.mcp_server_params()


def test_base_import_needs_no_framework() -> None:
    code = (
        "import sys, orkio_adapter, orkio_adapter.langgraph, orkio_adapter.crewai\n"
        "bad = [m for m in ('langgraph', 'langchain_core', 'langchain_mcp_adapters', 'crewai', 'crewai_tools') if m in sys.modules]\n"
        "assert not bad, bad\n"
    )
    subprocess.run([sys.executable, "-c", code], check=True)
