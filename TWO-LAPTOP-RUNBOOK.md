# Two-laptop runbook: run Orkio and the benchmarks on two machines

> Laptop B reads **LAPTOP-B.md** (one page, with its prompts). This file is for laptop A, the owner.

Laptop **A** runs the orchestrator, the dashboard and agent `a`. Laptop **B** runs agent `b`.
Team database: `orkio-catherine` (owner: Catherine). Workspace repo: `catou88/OrkioDemo`.
The planner only knows the agents `a`, `b`, `c`, `d` (`cowork.owners.json`), so use those handles.

## 0. What each laptop needs

| | Laptop A | Laptop B |
|---|---|---|
| Node 24+, git | yes | yes |
| `spacetime` CLI, signed in | yes (owner account) | yes (a DIFFERENT SpacetimeDB account, so a different identity) |
| Claude Code signed in | yes | yes |
| `OPENROUTER_API_KEY` (+ `OPENROUTER_MODEL`) in `.env`, or `droid` CLI + `FACTORY_API_KEY` | **yes (it runs the planner)** | no |
| Push access to `catou88/OrkioDemo` | yes | yes (add as collaborator) |

One identity can only be one handle, so B cannot reuse A's SpacetimeDB account.

## 0b. Before laptop B can start (you, laptop A)

1. **Commit and push this branch.** Laptop B clones `catherine-branch-update-after-hackathon`; anything uncommitted on your machine does not reach it.
2. Add GitHub user `mizuamiii` (laptop B) as a collaborator on `catou88/OrkioDemo`, then have them accept the emailed invite (write access: snapshots push to `wip/<handle>` branches).
3. Put `OPENROUTER_API_KEY` in `.env` on this laptop only.
4. `hooks/test/e2e.ts` passes again (it runs the scripted-plan flow, review, conflict thread and wake-ups on a local mock): run `node hooks/test/e2e.ts` once to confirm on your machine.

## 1. Laptop B: get on the team

```sh
git clone https://github.com/chuddrw/CalHacks26.git && cd CalHacks26
git checkout catherine-branch-update-after-hackathon
./teammate-setup.sh                  # prints B's PUBLIC identity (also copied to the clipboard)
```
Send that identity to Catherine. Never send a token.

## 2. Laptop A (owner): approve B

```sh
export PATH="$HOME/.local/bin:$PATH"
npm run access --prefix module -- grant orkio-catherine <B-identity> editor --name b --display "B"
```
If B was already granted under another handle (for example `maria`), rebind it:
```sh
spacetime call orkio-catherine set_member_profile <B-identity> b "B" --server https://maincloud.spacetimedb.com
```

## 3. Join

```sh
# Laptop B
./teammate-setup.sh join b

# Laptop A  (needs OPENROUTER_API_KEY, or FACTORY_API_KEY, in .env first)
./run.sh --orchestrator --name a
```
Both: `npm run doctor -- --demo ../workspace` must say "ready". Dashboard: http://localhost:5173/ on A.

## 4. Smoke test (do this before any benchmark)

On A, tell agent `a`: "The frontend needs User.lastLogin in milliseconds."
Confirm on the dashboard: a plan appears, B gets a task, a review or conflict thread opens, and
**agent b's Claude session is woken without you typing anything**. If b is not woken, stop and report it:
the whole Orkio condition depends on that.

No model key yet? You can still test wake-ups with a scripted plan (no model): see
`COWORK_PLAN_FILE` in `orchestrator/src/index.ts`. Do not report benchmark results from scripted plans.

## 5. One benchmark trial

Same two prompts for both conditions (copy from `bench/live/run-live.ts`, the `TASKS` array).
Tasks: `units-change`, `rename-field`, `independent-feature`. Alternate which condition goes first.

**Orkio condition**
1. Reset: both laptops `./run.sh clean --yes`; then laptop A `./run.sh clean --db --yes`; then both `./run.sh` again.
2. Start a stopwatch. Send agent a its prompt and agent b its prompt (2 human prompts, plus any extra you type).
3. Stop when the full stack (`cowork/full-stack`) is green or the agents give up. Note extra prompts you had to type.
4. Hidden test: put the task's hidden test (`bench/seeded-bugs/scenarios.ts`, the matching scenario's `hidden`) in the integrated checkout and run `npm test`.
5. Read tokens and cost from `/cost` in each Claude Code session and add them.

**Plain-git condition**
1. Fresh clones of `catou88/OrkioDemo` on both laptops, no `./run.sh`, no hooks.
2. Same prompts, same stopwatch. Merge through GitHub as two teammates would.
3. Same hidden test and the same cost reading.

**Record** (on the laptop with this repo), one file per run:
`bench/recorded/<condition>/<task>/<trial>.json` with condition `plain-git` or `orchestrated`:
```json
{ "wallMs": 0, "humanPrompts": 0, "tokens": 0, "costUsd": 0, "hiddenTestPass": true }
```
Then:
```sh
node bench/run-matrix.ts --trials 1 && node bench/report.ts bench/results/latest.json
```
Run at least 5 trials per task and condition before quoting any number. State n every time.

### Keeping token cost down

- The agents' own sessions are the big cost (about 360K tokens for one plain-git pair in the pilot). The planner is a few cents per request.
- Use one model for the agents in every trial, and give exactly one prompt per agent per trial.
- Planner cost: set `OPENROUTER_MODEL_FAST=anthropic/claude-haiku-5.5` to plan small requests with the cheap model and re-plan with `OPENROUTER_MODEL` only when the plan is hard. Each planning run prints `planning used N tokens ... $X` in the dashboard's orchestrator steps; record it per trial.
- To check that the cheap setup is as accurate as the strong one: `node bench/planner-golden/run-planner.ts --config tiered` then `node bench/planner-golden/score-plans.ts bench/results/plans-tiered.json` (about $1 for 23 cases).

## 6. If something breaks

| Symptom | Cause / fix |
|---|---|
| Dashboard 403 or "not authorized" | The identity was not granted, or the laptop signed in with another account. |
| `You are X, not b` | The handle bound to that identity differs from `--name`. Rebind with `set_member_profile` (step 2). |
| Push rejected to OrkioDemo | Add the account as a collaborator on the repo. |
| `Permission denied` cloning `../workspace` | Dev container: `sudo chown "$USER" /workspaces`. |
| Orchestrator stops asking for a key | Add `OPENROUTER_API_KEY` (or `FACTORY_API_KEY`) to `.env` on laptop A. |
| `database is paused` | Resume it on https://spacetimedb.com (owner only). |
