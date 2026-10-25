# Orchestrator: checklist

> What this file is for: the working checklist for replacing the watcher with an orchestrator (Droid), on branch `feat/orchestrator` (repo 1) and branch `orchestrator` (repo 2, demo-app). It records the decisions, the design, what's done, and what's left. `integration` stays as it is, so the watcher demo still works as a fallback.

Started Sat Oct 24, 4:00 PM; the build part done by about 6 PM. Code freeze in [final.md](final.md) is Sat 8:00 PM, submission Sun 9:00 AM.

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
- A conflict is a thread between the two agents. A conflict Droid flagged wakes both agents. A conflict a check found wakes the suggested agent (C's `report_conflict`, unchanged), and its first message wakes the other.
- It resolves when both agents' latest messages are `agree` and a current green check covers both of them.
- It escalates to both humans when either agent calls `escalate`, after 12 messages without agreement, or after 5 minutes open (C's existing timer).
- A change that fails alone but passes together with a teammate's counts as green (a coordinated change: A changes the contract, B adapts sessions). Found by the live test: without it neither agent could ever agree.
- Droid's old diagnosis role is dropped from the run time (the agents explain to each other). C's diagnosis code moved to `orchestrator/src/diagnose/` so C's tests keep passing.

## How it works

1. A human tells their own agent what they want. The agent calls `ask_orchestrator`, which stores a `request` row.
2. The orchestrator (one process, `npm run orchestrator`) picks it up and starts a Droid session in a read-only worktree of main. Droid reads the code, `cowork.owners.json` and the team's live state (tasks in flight, snapshots, intents), and builds a plan with its tools: `assign_task`, `request_review`, `flag_conflict`. Its steps stream to the dashboard.
3. The orchestrator applies the contract rule (a task touching `src/contracts/` or another owner's files is major, and the owners whose code imports the changed contract must review), then publishes the plan in one transaction.
4. No review needed: each assignee's listener hook wakes its agent with the task. Review needed: the tasks wait. The reviewer's human clicks Approve or Send back on the dashboard. Approve releases the tasks and opens the flagged conflicts. Send back cancels them and tells the requester why.
5. Agents work. Before finishing, an agent runs `check_with_team` (its work alone, then with each teammate's latest snapshot; tsc + vitest). A red pair opens a conflict thread with that teammate. `complete_task` only succeeds on a green check.
6. In a conflict thread the two agents talk directly (`message_teammate`, each message wakes the other), change their own code, and both call `agree`. Agreement plus a current green check resolves it, and the agreed fact goes into shared memory.
7. If they can't agree, the conflict escalates to both humans. They see both sides on the dashboard and send a decision, which wakes both agents.

## Checklist

### Repo 1, database (C's module)
- [x] `shared/src/schema.ts`: tables `request`, `task`, `review`, `message`, `plan_step`; conflict kind `potential`; inbox kinds `task`, `message`; the new reducers.
- [x] `module/src/index.ts`: the tables (private + authenticated views, C's pattern) and reducers `submit_request`, `start_request`, `add_plan_step`, `publish_plan`, `fail_request`, `decide_review`, `complete_task`, `post_message`, `decide_conflict`. The escalation timer notifies both agents. `report_conflict` keeps C's behavior, so C's tests stay valid.
- [x] Component tests for the orchestrator reducers (`module/tests/orchestrator.component.test.ts`, 15 tests). Module suite: 118/118.
- [x] Bindings regenerated (`npm run module:generate`).
- [x] `scripts/mock-stdb.ts` follows the new reducers.

### Repo 1, orchestrator (replaces the watcher)
- [x] `checks/`: B's merge + check code moved out of `watcher/`, with the repo path as a parameter (`useRepo`), plus `team-check.ts` (one agent's combined check).
- [x] `orchestrator/`: main loop, Droid planner (SDK MCP tools, read-only), contract rule + import scan, publish. Unit tests 6/6 (`npm run test:orchestrator`).
- [x] `watcher/` removed. C's diagnosis code moved to `orchestrator/src/diagnose/`, C's test paths updated. C's node suite 103/115; the 12 left fail on `integration` too (Mac/Linux-only tests). A Windows path bug in C's test loader is fixed, so the 4 diagnosis test files now run.
- [x] One real Droid run on the demo request (52 s): tasks for a (contract + users) and b (sessions + idle), reviews by b and d, conflict a x b on the lastLogin unit. Fix found on the way: the droid CLI defaults to script-only tool calls; the planner now asks for direct calls.

### Repo 1, agents (hooks + MCP)
- [x] MCP tools: `ask_orchestrator`, `check_with_team`, `message_teammate`, `agree` (runs the check and the test guard first), `escalate`, `complete_task`; `team_status` shows my tasks and threads.
- [x] Listener wakes on task, conflict and message; it also starts at SessionStart, UserPromptSubmit and after cowork tool calls.
- [x] Stop hook: one nudge while the agent owes a reply in a thread or has an unfinished task.
- [x] `install.ts` writes the new hook entries.
- [x] Wording in `hooks/src/lib/format.ts` and `hooks/src/lib/wake-message.ts` for tasks, threads, messages and decisions.
- [ ] Stretch: PreToolUse contract lock (an edit to a shared contract or another owner's file needs an approved task).

### Repo 1, dashboard (D's UI)
- [x] Orchestrator drawer (nav item, plus a callout under the hub while a review waits): requests with Droid's live steps and the resulting tasks.
- [x] Reviews with Approve / Send back (`decide_review`).
- [x] Conflict threads with the agents' messages; a decision box when escalated (`decide_conflict`).
- [x] Checked in a browser in `?demo` mode; dashboard tests 20/20; production build passes.

### Repo 2 (demo-app, branch `orchestrator`, commit 1ab20df)
- [x] `cowork.owners.json`.
- [x] `CLAUDE.md`: the new agent rules (ask_orchestrator, tasks, threads, agree/escalate, check_with_team).
- [x] `SCENARIO.md`: the new demo.

### Tests and docs
- [x] `npm run test:a` (mock): 83/83 checks pass, including request → scripted plan → rule → review → approval → task wakes from SessionStart → messages → stop nudge → escalate → decision.
- [x] `npm run test:live` on a real local server with real git, tsc and vitest: 29/29 (b woken 0.2 s and a 0.7 s after approval; each check 1-2.4 s; nothing left in the temp folder).
- [x] plan.md, structure.md, README.md (where Droid is used now), external/*.txt, pitch files (demo script, Q&A, Devpost text, evidence gates).
- [ ] Real run with two Claude Code sessions (needs two people at two laptops).

## Commits (branch feat/orchestrator, local only)
- c0ffb87 Replace the watcher with an orchestrator (Droid) and agent-to-agent conflict threads
- a0c1cbd Orchestrator: start Droid sessions with direct tool calls
- d30a0a2 Live test of the orchestrator flow; coordinated changes count as green
- 649e976 Dashboard: the orchestrator's requests, reviews and tasks; conflict threads and the humans' decision
- the docs commit: plan, structure, README, external notes, pitch files, this checklist

## Verify by hand
- [ ] `asyncRewake` on SessionStart and UserPromptSubmit wakes an idle session. The hooks reference ties asyncRewake to command hooks, not to events, but only PostToolUse was proven with a real session (Oct 24, 3:42 AM). If it fails, the first cowork tool call still starts the listener.
- [ ] Droid's planning time with a faster model: set `DROID_MODEL_ID` and rerun the demo request (52 s with the default).

## Open questions
- Push `feat/orchestrator` (repo 1) and `orchestrator` (repo 2)? Nothing is pushed yet.
- Repo 2's `main` and the `demo-base` tag still have the old rules. Moving them to the `orchestrator` branch is a merge to main, so it waits for your go.
- Catherine has to deploy the module from `feat/orchestrator` to maincloud before a run on the team database (five new tables; added tables keep existing data).
- The orchestrator's laptop needs its own approved editor identity (`spacetime login`, then Catherine grants it).
