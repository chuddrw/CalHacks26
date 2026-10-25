# Benchmark: Agent Cowork vs the GitHub way

> What this file is for: the checklist for measuring the same task done two ways by the same four people. Arm A is the GitHub way: branches, pull requests, CI, and people telling each other what changed. Arm B is Agent Cowork. The judges see both results in the presentation. This page covers the numbers next to them.

`benchmark.py` runs no agents. After a run, each laptop reads its own records and saves a small JSON file. The file holds numbers only, never conversation text. One laptop then combines the files into a table.

## What it measures

| Row | Where it comes from |
|---|---|
| Time | First prompt on any laptop to the last agent reply on any laptop. If you timed it yourselves, use `report --minutes A=42 --minutes B=18`. |
| Human touches | Prompts typed to agents; interrupts (Esc) and denied tool calls; times you talked to a teammate to coordinate (`--talks`, self-reported); GitHub reviews, comments and merges (A); dashboard approvals, send-backs and escalation decisions (B) |
| Hand-offs with no human | B: tasks, conflicts and messages that woke an agent by themselves, plus messages the agents sent each other |
| Conflicts | A: merge commits on main that had to resolve conflict markers. B: conflicts caught before anything reached main |
| Failed CI runs / red checks | A: failed GitHub Actions runs. B: red `check_with_team` runs |
| Tokens | Fresh input, cache write, cache read and output, for each tool (Claude Code, Codex, Cursor), plus Droid's planning in B |

## Before the runs

- Use the same task prompt, the same model and the same permission mode in both arms. Allowing a permission prompt isn't logged, so a different mode would skew the touch count.
- Write down when each run starts and ends. One person says "go", and the run ends when the last person is done.
- Arm A: start everyone from the same starting code in a GitHub repo. Each person works on a branch and opens a PR, and a person reviews and merges it. Coordinate however you normally would, and count the times you had to talk to someone.
- Arm B: the team database must run the module from `integration`. Right now maincloud's `agent-cowork` is missing the `review`, `request`, `message`, `task` and `build` tables. Start the orchestrator and the dashboard, and give everyone a fresh session in their demo clone.
- Run A first, or say on the slide which arm went second, because the second run benefits from knowing the task.

## After each run, on every laptop

Run this from repo 1 (the folder with `bench/`). Use `python3` on a Mac. Run `git fetch` in your project folder first, so the script sees the merges on main.

```
python bench/benchmark.py collect --arm A --name a --since 21:00 --until 21:45 --project <the folder you worked in> --talks 3
```

- `--since` / `--until` are local times (`21:00`, or `2026-10-24 21:00`). A run that crosses midnight works too.
- `--project` can be given more than once, for example your clone plus its `-full-stack` folder. Without it, every folder used in that time is counted, and the script lists them so you can check.
- **Arm A, one laptop:** add `--repo owner/name` (needs `gh auth login`). This reads PRs, reviews, comments, merges and Actions runs.
- **Arm B, the orchestrator laptop:** add `--db`. This reads the team database with `.env` and your `spacetime login`, and it also picks up Droid's tokens from `~/.factory/sessions`.
- **Cursor users:** export the usage CSV (cursor.com/dashboard, Usage, Export) and pass `--cursor-csv <file>` to get tokens. The script tries to count your prompts from Cursor's local chat database. If the number it prints looks wrong, count them yourself and pass `--prompts N` (with `--no-cursor-db`).

Each laptop saves `bench-<arm>-<name>.json`. Check the summary it prints, then send the file to whoever makes the table (Slack or AirDrop).

## The table

```
python bench/benchmark.py report bench-*.json --out bench-report.md
```

It prints a Markdown table (A vs B, with the change) and a per-person table. `--out` also saves them to a file.

## Limits

- An agent that uses `gh` with a person's login to comment or merge counts as that person.
- A conflict fixed by rebasing instead of merging doesn't show in the A conflict count.
- Cursor's local chat format isn't documented, so its prompt count is a best effort. The CSV token numbers come from Cursor's own export.
- Droid's `thinkingTokens` are left out, because Factory's records don't say whether output already includes them.
