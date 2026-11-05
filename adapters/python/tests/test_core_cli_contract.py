"""Cross-language contract: build_args output must parse in the real adapters/core/cli.ts parseCli.

Runs Node with tsx and imports parseCli only (cli.ts runs nothing on import), so no Git or database
is touched. Skips when node, tsx or the core CLI is missing.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from orkio_adapter import OrkioClient

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "adapters" / "core" / "cli.ts"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not (ROOT / "node_modules" / "tsx").is_dir() or not CLI.is_file(),
    reason="node, tsx or adapters/core/cli.ts not available",
)

SCRIPT = """
const { parseCli } = await import(process.env.ORKIO_CLI_URL);
const argv = JSON.parse(process.env.ORKIO_ARGS);
try {
  const a = parseCli(argv);
  console.log(JSON.stringify({ ok: true, command: a.command, id: a.adapter.id, label: a.adapter.label, cwd: a.cwd,
    intent: a.intent ?? null, forceReport: a.forceReport, allowPublish: a.allowPublish, allowAutomatic: a.allowAutomatic }));
} catch (e) { console.log(JSON.stringify({ ok: false, error: String(e && e.message) })); }
"""


def parse_with_node(args: list[str]) -> dict:
    # build_args starts with ["--import", "tsx", <cli.ts>, ...]; parseCli gets what follows the script.
    assert args[:3] == ["--import", "tsx", str(CLI)]
    env = {**os.environ, "COWORK_NAME": "", "STDB_DB": "", "ORKIO_CLI_URL": CLI.as_uri(), "ORKIO_ARGS": json.dumps(args[3:])}
    out = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", SCRIPT],
                         cwd=ROOT, env=env, capture_output=True, text=True, timeout=60, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("intent", ["- fixed login", "--allow-publish", "plain words", "-x"])
def test_intent_values_survive_strict_parse_args(tmp_path: Path, intent: str) -> None:
    client = OrkioClient(ROOT, tmp_path, adapter_id="langgraph", label="-Lang Graph")
    parsed = parse_with_node(client.build_args("sync", intent=intent, force_report=True))
    assert parsed["ok"], parsed
    assert parsed["command"] == "sync" and parsed["id"] == "langgraph" and parsed["label"] == "-Lang Graph"
    assert parsed["intent"] == intent
    assert parsed["cwd"] == str(tmp_path.resolve())
    assert parsed["forceReport"] is True and parsed["allowPublish"] is False


def test_consent_flags_parse(tmp_path: Path) -> None:
    client = OrkioClient(ROOT, tmp_path, adapter_id="crewai")
    parsed = parse_with_node(client.build_args("enable", allow_publish=True, allow_automatic=True))
    assert parsed["ok"] and parsed["allowPublish"] and parsed["allowAutomatic"] and parsed["label"] == "Crewai"


@pytest.mark.parametrize("command", ["enable", "sync", "status", "start", "publish", "stop", "done"])
def test_every_command_parses(tmp_path: Path, command: str) -> None:
    parsed = parse_with_node(OrkioClient(ROOT, tmp_path).build_args(command))
    assert parsed["ok"] and parsed["command"] == command
