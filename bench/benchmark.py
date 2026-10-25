#!/usr/bin/env python3
"""
bench/benchmark.py

WHAT IT'S FOR
  Measures one team task done two ways, by the same four people on their own laptops:
    arm A  the GitHub way: branches, pull requests, CI, people coordinating by talking
    arm B  Agent Cowork: the orchestrator, check_with_team, agents settling conflicts themselves
  It doesn't run any agent. After each run, every laptop reads its own local records (Claude Code,
  Codex, Cursor, Droid, git, and optionally GitHub and the team database) and saves a small JSON
  file of numbers, with no conversation text. One laptop then combines the files into a table for
  the presentation:
    - time: first prompt to the last agent reply (or the minutes you timed yourselves)
    - human touches: prompts typed to agents, interrupts, denied tool calls, talking to teammates
      (self-reported), GitHub reviews/comments/merges (A), dashboard decisions (B)
    - work done without a human: automatic wake-ups and agent-to-agent messages (B)
    - conflicts found at merge time vs caught before main, and CI / check failures
    - tokens, split into fresh input, cache write, cache read and output, per tool

USAGE (Python 3.9+, standard library only)
  After a run, on every laptop:
    python bench/benchmark.py collect --arm A --name terry --since 21:00 --until 21:45 \\
        --project C:/dvp/hackathon/demo-a [--talks 3] [--prompts 0] [--cursor-csv usage.csv]
    one laptop in arm A also adds   --repo owner/name   (PRs, reviews, merges, CI from GitHub)
    the orchestrator laptop in B adds  --db            (dashboard decisions, wake-ups; needs .env)
  Then on one laptop, with everyone's files in one folder:
    python bench/benchmark.py report bench-*.json [--minutes A=42 --minutes B=18] [--out report.md]
  See bench/README.md for the full checklist.

OWNER: A (benchmark, Oct 24).
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
TOKEN_KEYS = ("input", "cacheWrite", "cacheRead", "output", "other")
ARM_NAMES = {"A": "GitHub way", "B": "Agent Cowork"}
FILE_VERSION = 1


# ----------------------------------------------------------------------------- small helpers


def new_tokens() -> Dict[str, int]:
    return dict.fromkeys(TOKEN_KEYS, 0)


def add_tokens(into: Dict[str, int], more: Dict[str, Any]) -> None:
    for key in TOKEN_KEYS:
        into[key] += int(more.get(key, 0) or 0)


def token_total(tokens: Dict[str, int]) -> int:
    return sum(int(tokens.get(key, 0) or 0) for key in TOKEN_KEYS)


def parse_iso(value: Any) -> Optional[datetime]:
    """A timestamp from a log: ISO text (Z or offset) or epoch seconds / milliseconds."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        seconds = float(value) / 1000 if float(value) > 1e11 else float(value)
        return datetime.fromtimestamp(seconds, timezone.utc)
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    # Python 3.9's fromisoformat wants 0, 3 or 6 fraction digits.
    text = re.sub(r"\.(\d+)", lambda m: "." + m.group(1)[:6].ljust(6, "0"), text, count=1)
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def parse_user_time(text: str) -> tuple:
    """--since / --until: 'now', '21:00' (today, local time) or '2026-10-24 21:00'. Returns (utc, time_only)."""
    now = datetime.now().astimezone()
    if text == "now":
        return now.astimezone(timezone.utc), False
    match = re.fullmatch(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", text.strip())
    if match:
        hour, minute, second = int(match.group(1)), int(match.group(2)), int(match.group(3) or 0)
        return now.replace(hour=hour, minute=minute, second=second, microsecond=0).astimezone(timezone.utc), True
    moment = parse_iso(text) if text.strip().endswith("Z") or re.search(r"[+-]\d\d:\d\d$", text) else None
    if moment is None:
        try:
            moment = datetime.fromisoformat(text.strip()).astimezone()  # naive means local time
        except ValueError:
            raise SystemExit(f"Can't read the time {text!r}. Use 21:00, 2026-10-24 21:00 or now.")
    return moment.astimezone(timezone.utc), False


def local(moment: Optional[datetime]) -> str:
    return moment.astimezone().strftime("%Y-%m-%d %H:%M:%S") if moment else "-"


def iso(moment: Optional[datetime]) -> Optional[str]:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if moment else None


def norm_path(path: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(path))) if path else ""


def read_jsonl(path: Path) -> Iterable[Dict[str, Any]]:
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict):
                    yield record
    except OSError:
        return


def run(command: List[str], cwd: Optional[str] = None, timeout: int = 60) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(command, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return subprocess.CompletedProcess(command, 1, "", str(error))


class Window:
    def __init__(self, since: datetime, until: datetime):
        self.since, self.until = since, until

    def has(self, moment: Optional[datetime]) -> bool:
        return moment is not None and self.since <= moment <= self.until


class Projects:
    """The folders the run happened in. Empty means every folder (collect prints what it counted)."""

    def __init__(self, paths: List[str]):
        self.paths = [norm_path(path) for path in paths]

    def has(self, cwd: str) -> bool:
        if not self.paths:
            return True
        folder = norm_path(cwd)
        return any(folder == path or folder.startswith(path.rstrip(os.sep) + os.sep) for path in self.paths)


class Source:
    """What one tool's local records say about the run."""

    def __init__(self, tool: str):
        self.tool = tool
        self.prompts = 0
        self.interrupts = 0
        self.denials = 0
        self.wakes = 0
        self.first_prompt: Optional[datetime] = None
        self.last_activity: Optional[datetime] = None
        self.tokens = new_tokens()
        self.models: Counter = Counter()
        self.modes: Counter = Counter()
        self.folders: Dict[str, Counter] = defaultdict(Counter)
        self.notes: List[str] = []

    def prompt_at(self, moment: datetime) -> None:
        self.prompts += 1
        self.first_prompt = min(filter(None, [self.first_prompt, moment]))
        self.activity_at(moment)

    def activity_at(self, moment: datetime) -> None:
        self.last_activity = max(filter(None, [self.last_activity, moment]))

    def found_anything(self) -> bool:
        return bool(self.prompts or self.wakes or token_total(self.tokens))

    def to_json(self) -> Dict[str, Any]:
        return {
            "prompts": self.prompts,
            "interrupts": self.interrupts,
            "denials": self.denials,
            "wakes": self.wakes,
            "firstPrompt": iso(self.first_prompt),
            "lastActivity": iso(self.last_activity),
            "tokens": self.tokens,
            "tokensByModel": dict(self.models),
            "permissionModes": dict(self.modes),
            "notes": self.notes,
        }


# ----------------------------------------------------------------------------- Claude Code


def text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text")
    return ""


def classify_claude_user(record: Dict[str, Any]) -> Optional[str]:
    """prompt | interrupt | denial | wake | None, for one `user` line of a Claude Code transcript."""
    if record.get("isSidechain"):
        return None  # a subagent's own prompt, not a person
    content = (record.get("message") or {}).get("content")
    text = text_of(content)
    if text.lstrip().startswith("[Request interrupted"):
        return "interrupt"
    if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("is_error"):
                result = block.get("content")
                result_text = result if isinstance(result, str) else text_of(result)
                if "doesn't want to proceed" in result_text or "doesn't want to take this action" in result_text:
                    return "denial"
        return None
    origin = record.get("origin")
    kind = origin.get("kind") if isinstance(origin, dict) else None
    if kind == "human":
        return "prompt"
    if kind == "task-notification" or "<task-notification>" in text:
        return "wake" if "[cowork]" in text else None  # a cowork hook woke the agent by itself
    if "origin" in record:
        return None  # tagged, and not by a person
    # Older Claude Code versions don't tag where a prompt came from.
    stripped = text.lstrip()
    if record.get("isMeta") or record.get("isCompactSummary") or not stripped or stripped.startswith("<"):
        return None
    return "prompt"


def collect_claude(window: Window, projects: Projects) -> Source:
    source = Source("claude")
    home = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    root = home / "projects"
    if not root.is_dir():
        return source
    seen_users = set()
    usage: Dict[str, Dict[str, int]] = {}
    model_of: Dict[str, str] = {}
    for path in root.rglob("*.jsonl"):
        try:
            if path.stat().st_mtime < window.since.timestamp():
                continue  # not touched during the run
        except OSError:
            continue
        for record in read_jsonl(path):
            moment = parse_iso(record.get("timestamp"))
            if not window.has(moment):
                continue
            cwd = record.get("cwd") or ""
            if not projects.has(cwd):
                continue
            kind = record.get("type")
            if kind == "user":
                key = record.get("uuid") or f"{path}:{record.get('timestamp')}"
                if key in seen_users:
                    continue  # resumed sessions copy earlier lines
                seen_users.add(key)
                what = classify_claude_user(record)
                if what == "prompt":
                    source.prompt_at(moment)
                    source.folders[norm_path(cwd)]["prompts"] += 1
                    if record.get("permissionMode"):
                        source.modes[record["permissionMode"]] += 1
                elif what == "interrupt":
                    source.interrupts += 1
                elif what == "denial":
                    source.denials += 1
                elif what == "wake":
                    source.wakes += 1
                    source.folders[norm_path(cwd)]["wakes"] += 1
            elif kind == "assistant":
                message = record.get("message") or {}
                source.activity_at(moment)
                source.folders[norm_path(cwd)]["replies"] += 1
                numbers = message.get("usage")
                if not isinstance(numbers, dict) or message.get("model") == "<synthetic>":
                    continue
                key = message.get("id") or record.get("uuid") or f"{path}:{record.get('timestamp')}"
                current = {
                    "input": int(numbers.get("input_tokens") or 0),
                    "cacheWrite": int(numbers.get("cache_creation_input_tokens") or 0),
                    "cacheRead": int(numbers.get("cache_read_input_tokens") or 0),
                    "output": int(numbers.get("output_tokens") or 0),
                }
                before = usage.get(key)
                # One reply is split over several lines that repeat its usage: keep it once.
                usage[key] = current if before is None else {k: max(before[k], current[k]) for k in current}
                model_of[key] = message.get("model") or "?"
    for key, numbers in usage.items():
        add_tokens(source.tokens, numbers)
        source.models[model_of.get(key, "?")] += sum(numbers.values())
    return source


# ----------------------------------------------------------------------------- Codex


def codex_usage(total: Dict[str, Any]) -> Dict[str, int]:
    cached = int(total.get("cached_input_tokens") or 0)
    return {
        "input": max(0, int(total.get("input_tokens") or 0) - cached),  # OpenAI counts cached input inside input
        "cacheRead": cached,
        "cacheWrite": int(total.get("cache_write_input_tokens") or 0),
        "output": int(total.get("output_tokens") or 0),  # includes reasoning tokens
    }


def collect_codex(window: Window, projects: Projects) -> Source:
    source = Source("codex")
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    files = list((home / "sessions").rglob("*.jsonl")) + list((home / "archived_sessions").rglob("*.jsonl"))
    for path in files:
        try:
            if path.stat().st_mtime < window.since.timestamp():
                continue
        except OSError:
            continue
        cwd, model = "", "?"
        previous: Optional[Dict[str, int]] = None
        events, items = [], []
        for record in read_jsonl(path):
            payload = record.get("payload") or {}
            kind, sub = record.get("type"), payload.get("type")
            moment = parse_iso(record.get("timestamp"))
            if kind in ("session_meta", "turn_context"):
                cwd = payload.get("cwd") or cwd
                model = payload.get("model") or model
                continue
            if kind != "event_msg":
                continue
            if sub == "token_count" and isinstance(payload.get("info"), dict):
                total = codex_usage(payload["info"].get("total_token_usage") or {})
                # The log repeats running totals: count only what each event adds.
                delta = {k: total[k] - (previous or {}).get(k, 0) for k in total}
                previous = total
                if window.has(moment) and projects.has(cwd) and any(v > 0 for v in delta.values()):
                    add_tokens(source.tokens, {k: max(0, v) for k, v in delta.items()})
                    source.models[model] += sum(max(0, v) for v in delta.values())
                    source.activity_at(moment)
                    source.folders[norm_path(cwd)]["replies"] += 1
            elif sub == "user_message":
                events.append((moment, str(payload.get("message") or "")))
            elif sub == "item_completed" and (payload.get("item") or {}).get("type") == "UserMessage":
                items.append((moment, text_of((payload.get("item") or {}).get("content"))))
            elif sub == "turn_aborted":
                if window.has(moment) and projects.has(cwd):
                    source.interrupts += 1
        # Newer Codex logs a prompt as item_completed, older ones as user_message; use one, not both.
        for moment, text in events or items:
            if not window.has(moment) or not projects.has(cwd):
                continue
            if "[cowork]" in text[:400] or "<task-notification>" in text:
                source.wakes += 1
            else:
                source.prompt_at(moment)
                source.folders[norm_path(cwd)]["prompts"] += 1
    return source


# ----------------------------------------------------------------------------- Droid (orchestrator)


def collect_droid(window: Window) -> Source:
    """Droid's planning sessions on the orchestrator laptop (it plans in temp folders named cowork-...)."""
    source = Source("droid")
    root = Path.home() / ".factory" / "sessions"
    if not root.is_dir():
        return source
    for settings_path in root.glob("*/*.settings.json"):
        log_path = settings_path.with_name(settings_path.name.replace(".settings.json", ".jsonl"))
        times = [parse_iso(record.get("timestamp")) for record in read_jsonl(log_path)]
        times = [moment for moment in times if moment]
        cwd = next((record.get("cwd", "") for record in read_jsonl(log_path) if record.get("type") == "session_start"), "")
        if not times or max(times) < window.since or min(times) > window.until:
            continue
        if "cowork" not in (cwd or settings_path.parent.name).lower():
            continue  # someone's own Droid session, not the orchestrator
        try:
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        usage = settings.get("inclusiveTokenUsage") or settings.get("tokenUsage") or {}
        numbers = {
            "input": usage.get("inputTokens", 0),
            "cacheWrite": usage.get("cacheCreationTokens", 0),
            "cacheRead": usage.get("cacheReadTokens", 0),
            "output": usage.get("outputTokens", 0),
        }
        add_tokens(source.tokens, numbers)
        source.models[settings.get("model") or "?"] += sum(int(v or 0) for v in numbers.values())
        source.activity_at(max(times))
        source.folders[cwd or settings_path.parent.name]["sessions"] += 1
    return source


# ----------------------------------------------------------------------------- Cursor


def cursor_number(text: str) -> int:
    digits = re.sub(r"[^\d.]", "", text or "")
    try:
        return int(float(digits)) if digits else 0
    except ValueError:
        return 0


def parse_loose_time(text: str) -> Optional[datetime]:
    moment = parse_iso(text)
    if moment:
        return moment
    for fmt in ("%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%b %d, %Y, %I:%M:%S %p", "%b %d, %Y, %I:%M %p", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text.strip(), fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def collect_cursor_csv(path: str, window: Window, source: Source) -> None:
    """The usage CSV from cursor.com/dashboard (Usage, Export). One row per model request."""
    try:
        handle = open(path, newline="", encoding="utf-8-sig")
    except OSError as error:
        source.notes.append(f"Couldn't open the Cursor CSV: {error}")
        return
    with handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames or []
        date_col = next((h for h in headers if re.search(r"date|time", h, re.I)), None)
        columns: Dict[str, str] = {}
        for header in headers:
            name = header.lower()
            if "cache read" in name:
                columns[header] = "cacheRead"
            elif "input" in name and ("w/o" in name or "without" in name):
                columns[header] = "input"
            elif "cache write" in name:
                columns[header] = "cacheWrite"
            elif "input" in name:
                columns[header] = "input"
            elif "output" in name:
                columns[header] = "output"
        total_col = next((h for h in headers if "total" in h.lower() and "token" in h.lower()), None)
        if not date_col:
            source.notes.append(f"The Cursor CSV has no date column (columns: {', '.join(headers)}).")
            return
        rows = kept = 0
        first = last = None
        for row in reader:
            rows += 1
            moment = parse_loose_time(row.get(date_col) or "")
            if not window.has(moment):
                continue
            kept += 1
            first, last = min(filter(None, [first, moment])), max(filter(None, [last, moment]))
            numbers = new_tokens()
            for header, key in columns.items():
                numbers[key] += cursor_number(row.get(header, ""))
            if not token_total(numbers) and total_col:
                numbers["other"] = cursor_number(row.get(total_col, ""))
            add_tokens(source.tokens, numbers)
            model = next((row[h] for h in headers if h.lower() == "model"), "?") or "?"
            source.models[model] += token_total(numbers)
            source.activity_at(moment)
        source.notes.append(f"Cursor CSV: {kept} of {rows} requests are inside the run ({local(first)} to {local(last)}).")
        if rows and not kept:
            source.notes.append("None of the Cursor rows fall inside the run. Check the export's time zone and the --since/--until times.")


def cursor_db_path() -> Optional[Path]:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", "")) / "Cursor"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "Cursor"
    else:
        base = Path.home() / ".config" / "Cursor"
    path = base / "User" / "globalStorage" / "state.vscdb"
    return path if path.is_file() else None


def collect_cursor_prompts(window: Window, source: Source) -> None:
    """Best effort: Cursor keeps chats in a local SQLite file whose format isn't documented."""
    path = cursor_db_path()
    if not path:
        return
    try:
        connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=2)
        rows = connection.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' OR key LIKE 'composerData:%'").fetchall()
        connection.close()
    except sqlite3.Error as error:
        source.notes.append(f"Couldn't read Cursor's chat database ({error}); pass --prompts N for Cursor prompts.")
        return
    composer_time: Dict[str, Optional[datetime]] = {}
    bubbles = []
    for key, value in rows:
        try:
            data = json.loads(value) if value else None
        except (TypeError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        if key.startswith("composerData:"):
            composer_time[key.split(":", 1)[1]] = parse_iso(data.get("lastUpdatedAt") or data.get("createdAt"))
            for bubble in data.get("conversation") or []:  # older Cursor keeps bubbles inline
                if isinstance(bubble, dict):
                    bubbles.append((key.split(":", 1)[1], bubble))
        else:
            bubbles.append((key.split(":")[1], data))
    counted = 0
    for composer, bubble in bubbles:
        if bubble.get("type") != 1:  # 1 = the person, 2 = the AI
            continue
        moment = parse_iso(bubble.get("createdAt") or bubble.get("timestamp")) or composer_time.get(composer)
        if window.has(moment):
            counted += 1
            source.prompt_at(moment)
    source.notes.append(f"Cursor chats: {counted} prompts found in its local database (best effort; check it, or pass --prompts N).")


# ----------------------------------------------------------------------------- git, GitHub, database


def collect_merges(project_paths: List[str], window: Window) -> List[Dict[str, Any]]:
    """Merge commits on main during the run, and whether each one had to resolve a conflict."""
    found: Dict[str, Dict[str, Any]] = {}
    for project in project_paths:
        if run(["git", "-C", project, "rev-parse", "--git-dir"]).returncode != 0:
            continue
        refs = [ref for ref in ("origin/main", "main", "origin/master", "master") if run(["git", "-C", project, "rev-parse", "--verify", "-q", ref]).returncode == 0]
        if not refs:
            continue
        log = run(["git", "-C", project, "log", *refs, "--merges", f"--since={iso(window.since)}", f"--until={iso(window.until)}", "--format=%H %P"])
        for line in log.stdout.splitlines():
            sha, *parents = line.split()
            if sha in found or len(parents) < 2:
                continue
            base = run(["git", "-C", project, "merge-base", parents[0], parents[1]]).stdout.strip()
            # Redo the merge without writing anything: conflict markers mean a person (or agent) had to resolve it.
            tree = run(["git", "-C", project, "merge-tree", base, parents[0], parents[1]]).stdout if base else ""
            found[sha] = {"sha": sha, "conflict": "<<<<<<<" in tree}
    return list(found.values())


def is_bot(author: Any) -> bool:
    login = (author or {}).get("login", "") if isinstance(author, dict) else ""
    return bool((author or {}).get("is_bot")) or login.endswith("[bot]") or login == "github-actions"


def gh_json(args: List[str]) -> Any:
    result = run(["gh", *args], timeout=90)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip()[:300])
    return json.loads(result.stdout or "null")


def collect_github(repo: str, window: Window) -> Dict[str, Any]:
    out: Dict[str, Any] = {"repo": repo}
    try:
        prs = gh_json(["pr", "list", "--repo", repo, "--state", "all", "--limit", "300", "--json",
                       "number,author,createdAt,mergedAt,closedAt,state,reviews,comments"])
    except (RuntimeError, ValueError) as error:
        return {"repo": repo, "error": f"gh pr list failed: {error}"}
    inside = lambda value: window.has(parse_iso(value))
    out["prsOpened"] = sum(1 for pr in prs if inside(pr.get("createdAt")))
    out["prsMerged"] = sum(1 for pr in prs if inside(pr.get("mergedAt")))
    reviews = [r for pr in prs for r in pr.get("reviews") or [] if inside(r.get("submittedAt")) and not is_bot(r.get("author"))]
    out["reviews"] = len(reviews)
    out["reviewsByState"] = dict(Counter(r.get("state", "?") for r in reviews))
    out["comments"] = sum(1 for pr in prs for c in pr.get("comments") or [] if inside(c.get("createdAt")) and not is_bot(c.get("author")))
    try:
        inline = gh_json(["api", f"repos/{repo}/pulls/comments?since={iso(window.since)}&per_page=100"])
        out["inlineComments"] = sum(1 for c in inline or [] if inside(c.get("created_at")) and not is_bot(c.get("user")))
    except (RuntimeError, ValueError) as error:
        out["inlineComments"] = 0
        out["note"] = f"inline comments not read: {error}"
    try:
        runs = gh_json(["api", f"repos/{repo}/actions/runs?created={iso(window.since)}..{iso(window.until)}&per_page=100"])
        workflow_runs = (runs or {}).get("workflow_runs") or []
        out["ciRuns"] = len(workflow_runs)
        out["ciFailed"] = sum(1 for r in workflow_runs if r.get("conclusion") in ("failure", "timed_out"))
    except (RuntimeError, ValueError) as error:
        out["ciRuns"] = out["ciFailed"] = 0
        out["ciNote"] = f"CI runs not read: {error}"
    return out


def collect_db(window: Window, name: str = "") -> Dict[str, Any]:
    script = REPO_ROOT / "bench" / "db-counts.ts"
    env = dict(os.environ, STDB_DB=name) if name else None
    since_ms = int(window.since.timestamp() * 1000)
    until_ms = int(window.until.timestamp() * 1000)
    try:
        result = subprocess.run(["node", str(script), "--since", str(since_ms), "--until", str(until_ms)], cwd=str(REPO_ROOT),
                                env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": str(error)}
    try:
        return json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": (result.stderr or result.stdout or "no output").strip()[:300]}


# ----------------------------------------------------------------------------- collect


def cmd_collect(args: argparse.Namespace) -> int:
    since, since_time_only = parse_user_time(args.since)
    until, until_time_only = parse_user_time(args.until)
    now = datetime.now(timezone.utc)
    if since_time_only and since > now:
        since -= timedelta(days=1)  # "23:30" typed after midnight means yesterday
    if until_time_only and until < since:
        until += timedelta(days=1)  # a run across midnight
    if until <= since:
        raise SystemExit("--until must be after --since.")
    window = Window(since, until)
    projects = Projects(args.project)

    sources = [collect_claude(window, projects), collect_codex(window, projects)]
    cursor = Source("cursor")
    if args.cursor_csv:
        collect_cursor_csv(args.cursor_csv, window, cursor)
    if not args.no_cursor_db:
        collect_cursor_prompts(window, cursor)
    sources.append(cursor)
    if args.arm == "B":
        sources.append(collect_droid(window))

    merges = collect_merges(args.project, window) if args.project else []
    github = collect_github(args.repo, window) if args.repo else None
    db = collect_db(window, args.db) if args.db is not None else None

    first = min((s.first_prompt for s in sources if s.first_prompt), default=None)
    last = max((s.last_activity for s in sources if s.last_activity), default=None)
    record = {
        "version": FILE_VERSION,
        "arm": args.arm,
        "name": args.name,
        "collectedAt": iso(now),
        "window": {"since": iso(since), "until": iso(until)},
        "projects": args.project,
        "firstPrompt": iso(first),
        "lastActivity": iso(last),
        "selfReported": {"talks": args.talks, "prompts": args.prompts, "minutes": args.minutes},
        "sources": {s.tool: s.to_json() for s in sources if s.found_anything() or s.notes},
        "merges": merges,
        "github": github,
        "db": db,
        "note": args.note or "",
    }
    out = Path(args.out or f"bench-{args.arm}-{re.sub(r'[^A-Za-z0-9_-]', '_', args.name)}.json")
    out.write_text(json.dumps(record, indent=2), encoding="utf-8")

    # What was counted, so the person can check it before sending the file.
    print(f"Arm {args.arm} ({ARM_NAMES[args.arm]}), {args.name}")
    print(f"Run window: {local(since)} -> {local(until)} ({(until - since).total_seconds() / 60:.0f} min)")
    if not args.project:
        print("No --project given: every folder below was counted. Rerun with --project if some aren't part of the run.")
    folders: Counter = Counter()
    for source in sources:
        for folder, counts in source.folders.items():
            folders[f"{source.tool:6} {folder}"] += sum(counts.values())
    for folder, _ in folders.most_common(12):
        print(f"  {folder}")
    if not folders:
        print("  (nothing found in this window: check the times and --project)")
    for source in sources:
        if not (source.found_anything() or source.notes):
            continue
        t = source.tokens
        print(f"{source.tool}: {source.prompts} prompts, {source.interrupts} interrupts, {source.denials} denied tool calls, "
              f"{source.wakes} automatic wake-ups; tokens {token_total(t):,} "
              f"(input {t['input']:,} / cache write {t['cacheWrite']:,} / cache read {t['cacheRead']:,} / output {t['output']:,})")
        if source.modes:
            print(f"  permission modes: {dict(source.modes)}")
        for note in source.notes:
            print(f"  {note}")
    print(f"First prompt {local(first)}, last agent activity {local(last)}")
    if args.talks or args.prompts:
        print(f"Self-reported: {args.talks} times talking to teammates, {args.prompts} extra prompts")
    if merges:
        print(f"Merges on main: {len(merges)} ({sum(1 for m in merges if m['conflict'])} had a conflict)")
    if github:
        print(f"GitHub: {json.dumps(github)}")
    if db:
        print(f"Database: {json.dumps(db)}")
    print(f"\nSaved {out}. Send it to whoever runs the report.")
    return 0


# ----------------------------------------------------------------------------- report


class Arm:
    def __init__(self, arm: str):
        self.arm = arm
        self.people: List[Dict[str, Any]] = []
        self.minutes: Optional[float] = None
        self.prompts = self.interrupts = self.denials = self.talks = self.wakes_seen = 0
        self.tokens = new_tokens()
        self.tokens_by_tool: Dict[str, Dict[str, int]] = defaultdict(new_tokens)
        self.merges: Dict[str, bool] = {}
        self.github: Dict[str, Dict[str, Any]] = {}
        self.db: Dict[str, Dict[str, Any]] = {}
        self.first: Optional[datetime] = None
        self.last: Optional[datetime] = None
        self.self_minutes: List[float] = []
        self.modes: Counter = Counter()

    def add(self, record: Dict[str, Any]) -> None:
        mine = {"name": record.get("name", "?"), "tools": [], "prompts": 0, "tokens": 0}
        for tool, source in (record.get("sources") or {}).items():
            self.prompts += source.get("prompts", 0)
            self.interrupts += source.get("interrupts", 0)
            self.denials += source.get("denials", 0)
            self.wakes_seen += source.get("wakes", 0)
            add_tokens(self.tokens, source.get("tokens") or {})
            add_tokens(self.tokens_by_tool[tool], source.get("tokens") or {})
            self.modes.update(source.get("permissionModes") or {})
            mine["tools"].append(tool)
            mine["prompts"] += source.get("prompts", 0)
            mine["tokens"] += token_total(source.get("tokens") or {})
        reported = record.get("selfReported") or {}
        self.talks += int(reported.get("talks") or 0)
        self.prompts += int(reported.get("prompts") or 0)
        mine["prompts"] += int(reported.get("prompts") or 0)
        if reported.get("minutes"):
            self.self_minutes.append(float(reported["minutes"]))
        for merge in record.get("merges") or []:
            self.merges[merge["sha"]] = self.merges.get(merge["sha"], False) or bool(merge.get("conflict"))
        github = record.get("github")
        if github and not github.get("error"):
            self.github.setdefault(github["repo"], github)  # the same repo read twice counts once
        db = record.get("db")
        if db and not db.get("error"):
            self.db.setdefault(f"{db.get('host')}/{db.get('db')}", db)
        first, last = parse_iso(record.get("firstPrompt")), parse_iso(record.get("lastActivity"))
        self.first = min(filter(None, [self.first, first]), default=None)
        self.last = max(filter(None, [self.last, last]), default=None)
        self.people.append(mine)

    def gh(self, key: str) -> int:
        return sum(int(g.get(key) or 0) for g in self.github.values())

    def dbn(self, key: str) -> int:
        return sum(int(d.get(key) or 0) for d in self.db.values())

    def time_minutes(self) -> Optional[float]:
        if self.minutes is not None:
            return self.minutes
        if self.self_minutes:
            return max(self.self_minutes)
        if self.first and self.last:
            return (self.last - self.first).total_seconds() / 60
        return None

    def time_source(self) -> str:
        if self.minutes is not None or self.self_minutes:
            return "is the minutes you entered"
        return "runs from the first prompt on any laptop to the last agent reply on any laptop"

    def github_touches(self) -> int:
        return self.gh("reviews") + self.gh("comments") + self.gh("inlineComments") + self.gh("prsMerged")

    def dashboard_touches(self) -> int:
        return self.dbn("reviewsDecided") + self.dbn("escalationDecisions") + self.dbn("conflictsNeedingPerson")

    def touches(self) -> int:
        return self.prompts + self.interrupts + self.denials + self.talks + self.github_touches() + self.dashboard_touches()

    def auto_wakes(self) -> int:
        return self.dbn("autoWakes") if self.db else self.wakes_seen


def fmt_int(value: Optional[float]) -> str:
    return "-" if value is None else f"{int(round(value)):,}"


def fmt_tokens(value: int) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}M"
    if value >= 10_000:
        return f"{value / 1000:.0f}k"
    return f"{value:,}"


def change(a: Optional[float], b: Optional[float], lower_is_better: bool = True) -> str:
    if a is None or b is None:
        return ""
    if a == 0 and b == 0:
        return "same"
    if a == 0:
        return "new in B"
    pct = (b - a) / a * 100
    if lower_is_better and b > 0 and a / b >= 1.5:
        return f"{a / b:.1f}x less"
    return f"{pct:+.0f}%"


def cmd_report(args: argparse.Namespace) -> int:
    files: List[str] = []
    for pattern in args.files:
        if os.path.isdir(pattern):
            files += glob.glob(os.path.join(pattern, "bench-*.json"))
        else:
            files += glob.glob(pattern) or [pattern]
    arms = {"A": Arm("A"), "B": Arm("B")}
    for path in sorted(set(files)):
        try:
            record = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            print(f"Skipping {path}: {error}", file=sys.stderr)
            continue
        if record.get("arm") in arms:
            arms[record["arm"]].add(record)
    for item in args.minutes or []:
        arm, _, value = item.partition("=")
        if arm.upper() in arms:
            arms[arm.upper()].minutes = float(value)
    a, b = arms["A"], arms["B"]
    if not a.people and not b.people:
        print("No benchmark files found. Pass the bench-*.json files (or their folder).", file=sys.stderr)
        return 1

    rows: List[tuple] = []

    def row(label: str, va: Optional[float], vb: Optional[float], show=fmt_int, delta=True, lower_is_better=True):
        rows.append((label, show(va) if va is not None else "-", show(vb) if vb is not None else "-",
                     change(va, vb, lower_is_better) if delta else ""))

    ta, tb = a.time_minutes(), b.time_minutes()
    row("**Time (minutes)**", ta, tb)
    row("**Human touches**", a.touches(), b.touches())
    row("· prompts typed to agents", a.prompts, b.prompts)
    row("· interrupts and denied tool calls", a.interrupts + a.denials, b.interrupts + b.denials)
    row("· talking to teammates (self-reported)", a.talks, b.talks)
    row("· GitHub reviews, comments, merges", a.github_touches(), b.github_touches())
    row("· dashboard decisions", a.dashboard_touches(), b.dashboard_touches())
    row("**Hand-offs with no human**", a.auto_wakes(), b.auto_wakes(), delta=False)
    row("· agent-to-agent messages", a.dbn("agentMessages"), b.dbn("agentMessages"), delta=False)
    row("**Conflicts found at merge time**", sum(a.merges.values()), sum(b.merges.values()))
    row("**Conflicts caught before main**", a.dbn("conflictsCaught"), b.dbn("conflictsCaught"), delta=False)
    row("**Failed CI runs / red checks**", a.gh("ciFailed") + a.dbn("checksRed"), b.gh("ciFailed") + b.dbn("checksRed"))
    row("**Tokens, total**", token_total(a.tokens), token_total(b.tokens), show=fmt_tokens)
    row("· output", a.tokens["output"], b.tokens["output"], show=fmt_tokens)
    row("· fresh input", a.tokens["input"] + a.tokens["other"], b.tokens["input"] + b.tokens["other"], show=fmt_tokens)
    row("· cache write", a.tokens["cacheWrite"], b.tokens["cacheWrite"], show=fmt_tokens)
    row("· cache read", a.tokens["cacheRead"], b.tokens["cacheRead"], show=fmt_tokens)
    for tool in sorted(set(a.tokens_by_tool) | set(b.tokens_by_tool)):
        row(f"· {tool}", token_total(a.tokens_by_tool.get(tool, new_tokens())),
            token_total(b.tokens_by_tool.get(tool, new_tokens())), show=fmt_tokens)

    lines = ["## Agent Cowork vs the GitHub way", "",
             "| | A: GitHub way | B: Agent Cowork | Change |", "|---|---:|---:|---:|"]
    lines += [f"| {label} | {va} | {vb} | {delta} |" for label, va, vb, delta in rows]
    lines += ["", "### Per person", "", "| Person | Arm | Tools | Prompts | Tokens |", "|---|---|---|---:|---:|"]
    for arm in (a, b):
        for person in arm.people:
            lines.append(f"| {person['name']} | {arm.arm} | {', '.join(person['tools']) or '-'} | {person['prompts']:,} | {fmt_tokens(person['tokens'])} |")
    notes = [
        "Time: " + "; ".join(f"{arm.arm} {arm.time_source()}" for arm in (a, b) if arm.people) + ".",
        "Human touches don't include clicking Allow on a permission prompt (not logged). Use the same permission mode in both arms"
        + (f"; seen: A {dict(a.modes) or '-'}, B {dict(b.modes) or '-'}" if (a.modes or b.modes) else "") + ".",
        "GitHub actions an agent takes with the person's gh login count as that person's.",
        "Conflicts at merge time: merge commits on main whose merge had to resolve conflict markers (git merge-tree); conflicts fixed by rebasing don't show.",
        "B's tokens include Droid's planning on the orchestrator laptop.",
        "The same people ran both arms, so the second run had the advantage of knowing the task.",
    ]
    if not a.github and a.people:
        notes.append("No GitHub numbers for A: nobody in arm A collected with --repo.")
    if not b.db and b.people:
        notes.append("No database numbers for B: nobody in arm B collected with --db; hand-offs come from the Claude Code logs only.")
    lines += ["", "Notes:"] + [f"- {note}" for note in notes]
    text = "\n".join(lines) + "\n"
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"Saved {args.out}")
    return 0


# ----------------------------------------------------------------------------- main


def main(argv: Optional[List[str]] = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass
    parser = argparse.ArgumentParser(description="Agent Cowork vs the GitHub way: collect each laptop's numbers, then report.")
    sub = parser.add_subparsers(dest="command", required=True)

    c = sub.add_parser("collect", help="read this laptop's records for one run and save bench-<arm>-<name>.json")
    c.add_argument("--arm", required=True, type=str.upper, choices=["A", "B"], help="A = GitHub way, B = Agent Cowork")
    c.add_argument("--name", required=True, help="your name or letter (a, b, c, d)")
    c.add_argument("--since", required=True, help="when the run started: 21:00, '2026-10-24 21:00' (local time)")
    c.add_argument("--until", default="now", help="when it ended (default: now)")
    c.add_argument("--project", action="append", default=[], help="the folder you worked in (repeatable). Default: every folder")
    c.add_argument("--talks", type=int, default=0, help="times you had to talk to or message a teammate to coordinate")
    c.add_argument("--prompts", type=int, default=0, help="extra prompts the logs can't see (for example Cursor)")
    c.add_argument("--minutes", type=float, default=None, help="if you timed the run yourselves")
    c.add_argument("--cursor-csv", help="Cursor usage CSV (cursor.com/dashboard, Usage, Export) for token counts")
    c.add_argument("--no-cursor-db", action="store_true", help="don't read Cursor's local chat database")
    c.add_argument("--repo", help="arm A, one laptop: owner/name of the GitHub repo, for PRs, reviews, merges and CI")
    c.add_argument("--db", nargs="?", const="", default=None, metavar="NAME",
                   help="arm B, one laptop: read the team database (NAME, or STDB_DB from .env)")
    c.add_argument("--note", help="anything worth remembering about this run")
    c.add_argument("--out", help="file to write (default bench-<arm>-<name>.json)")
    c.set_defaults(func=cmd_collect)

    r = sub.add_parser("report", help="combine everyone's bench-*.json into one table")
    r.add_argument("files", nargs="+", help="the bench-*.json files, a glob, or their folder")
    r.add_argument("--minutes", action="append", help="override the time, e.g. --minutes A=42 --minutes B=18")
    r.add_argument("--out", help="also save the table as Markdown")
    r.set_defaults(func=cmd_report)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
