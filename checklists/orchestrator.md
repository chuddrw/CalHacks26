# Orchestrator: checklist

> What this file is for: the working checklist for replacing the watcher with an orchestrator (Droid), on branch `feat/orchestrator` (repo 1) and branch `orchestrator` (repo 2, demo-app). It records the decisions, the design, what's done, and what's left. `integration` stays as it is, so the watcher demo still works as a fallback.

Started Sat Oct 24, 4:00 PM. Code freeze in [final.md](final.md) is Sat 8:00 PM, submission Sun 9:00 AM.

## Decisions (asked Oct 24, 4:10 PM)

| Question | Answer |
|---|---|
| How are conflicts found without the watcher? | Droid flags overlaps when it assigns tasks, and every agent has a `check_with_team` tool that runs tsc + tests on its work plus teammates' snapshots. Tests still decide red or green. |
| Where does a human tell the orchestrator what they want? | In their own Claude Code: the agent forwards it with the `ask_orchestrator` tool. |
| What is a major change? | Always: a change to a shared contract (`src/contracts/`) or to another owner's files. Droid can also mark a task major. A major task waits until the human whose feature is affected approves it. |
| How do humans answer reviews and escalations? | On the dashboard only. Agents wait for the answer. |

Defaults I picked (say if you want them different):
- Who owns what is in repo 2, `cowork.owners.json` (like CODEOWNERS): agent, human, feature, paths. `src/contracts/` is shared.
- A plan lands in the database in one transaction (`publish_plan`): its reviews, tasks and flagged conflicts together.
- A conflict is a thread between the two agents. Both are woken. It resolves when both agents have said `agree` and a current green check covers both of them.
- It escalates to both humans when either agent calls `escalate`, after 12 messages without agreement, or after 10 minutes open.
- Droid's old diagnosis role is dropped from the runtime (the agents explain to each other). C's diagnosis code moves to `orchestrator/src/diagnose/` so C's tests keep passing.

## How it works

1. A human tells their own agent what they want. The agent calls `ask_orchestrator`, which stores a `request` row.
2. The orchestrator (one process, `npm run orchestrator`) picks it up and starts a Droid session in a read-only worktree of main. Droid reads the code, `cowork.owners.json` and the team's live state (tasks in flight, snapshots, intents), and builds a plan with its tools: `assign_task`, `request_review`, `flag_conflict`. Its steps stream to the dashboard.
3. The orchestrator applies the contract rule (a task touching `src/contracts/` or another owner's files is major, and the owners whose code imports the changed contract must review), then publishes the plan in one transaction.
4. No review needed: each assignee's listener hook wakes its agent with the task. Review needed: the tasks wait. The reviewer's human clicks Approve or Send back on the dashboard. Approve releases the tasks and opens the flagged conflicts. Send back cancels them and tells the requester why.
5. Agents work. Before finishing, an agent runs `check_with_team` (its work + each teammate's latest snapshot, tsc + vitest). A red pair opens a conflict thread with that teammate. `complete_task` only succeeds on a green check.
6. In a conflict thread the two agents talk directly (`message_teammate`, each message wakes the other), change their own code, and both call `agree`. Agreement plus a current green check resolves it, and the agreed fact goes into shared memory.
7. If they can't agree, the conflict escalates to both humans. They see both sides on the dashboard and send a decision, which wakes both agents.

## Checklist

### Repo 1, database (C's module)
- [ ] `shared/src/schema.ts`: tables `request`, `task`, `review`, `message`, `plan_step`; conflict kind `potential`; inbox kinds `task`, `message`; the new reducers. Done when: type checks pass.
- [ ] `module/src/index.ts`: the tables (private + authenticated views, C's pattern) and reducers `submit_request`, `start_request`, `add_plan_step`, `publish_plan`, `fail_request`, `decide_review`, `complete_task`, `post_message`, `decide_conflict`. `report_conflict` wakes both agents. The escalation timer notifies both humans' agents. Done when: C's 94 tests still pass.
- [ ] New component tests for the orchestrator reducers. Done when: plan with and without review, approve and send back, agree + green resolves, escalate and decide, complete_task needs green.
- [ ] Bindings regenerated (`npm run module:generate`).
- [ ] `scripts/mock-stdb.ts` follows the new reducers.

### Repo 1, orchestrator (replaces the watcher)
- [ ] `checks/`: B's merge + check code (git, check, localize, map-errors, fixer, guard) moved out of `watcher/`, with the repo path as a parameter, so agents can run it.
- [ ] `orchestrator/`: main loop, Droid planner (SDK MCP tools, read-only), contract rule, publish. Done when: a request becomes tasks on the right agents.
- [ ] `watcher/` removed. C's diagnosis code moved to `orchestrator/src/diagnose/`, C's test paths updated. Done when: C's tests pass.
- [ ] One real Droid run on a real request (needs the Factory key, which this laptop has).

### Repo 1, agents (hooks + MCP)
- [ ] MCP tools: `ask_orchestrator`, `check_with_team`, `message_teammate`, `agree`, `escalate`, `complete_task`; `team_status` shows my tasks and threads.
- [ ] Listener wakes on task, conflict and message; it also starts at SessionStart, UserPromptSubmit and after cowork tool calls, so an agent that hasn't edited anything yet can still be woken.
- [ ] Stop hook: one nudge while the agent owes a reply in a thread or has an unfinished task.
- [ ] `install.ts` writes the new hook entries.
- [ ] Wording in `hooks/src/lib/format.ts` for tasks, threads, messages and decisions.
- [ ] Stretch: PreToolUse contract lock (an edit to a shared contract or another owner's file needs an approved task).

### Repo 1, dashboard (D's UI)
- [ ] Requests with the orchestrator's live steps and the resulting tasks.
- [ ] Reviews with Approve / Send back.
- [ ] Conflict threads with the agents' messages; a decision box when escalated.

### Repo 2 (demo-app, branch `orchestrator`)
- [ ] `cowork.owners.json`.
- [ ] `CLAUDE.md`: the new agent rules (tasks, threads, agree/escalate, check_with_team).
- [ ] `SCENARIO.md`: the new demo.

### Tests and docs
- [ ] `npm run test:a` (mock) covers the new tools and wakes.
- [ ] `npm run test:live` on a real local server: request → plan (scripted planner, no model) → review → tasks → thread → agree → resolved.
- [ ] plan.md, structure.md, README.md (where Droid is used now), external/*.txt, pitch files.
- [ ] Real run with two Claude Code sessions.

## Verify by hand
- [ ] `asyncRewake` on SessionStart wakes an idle session. The docs list no event limits, but only PostToolUse was proven (Oct 24, 3:42 AM). If it fails, the first prompt or cowork tool call still starts the listener.

## Open questions
- Repo 2's `main` and the `demo-base` tag still have the old rules. Moving them to the `orchestrator` branch is a merge to main, so it waits for your go.
- Nothing is pushed yet.
