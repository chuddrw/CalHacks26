# Agent Cowork

> **What this file is for:** the public README for GitHub, Devpost and judges. It explains what the project does, how to run it, and where each sponsor technology is used. C finishes it on Sunday between 3:00 and 5:00 AM; until then, the sections marked TODO are placeholders. The team's internal plan is in [plan.md](plan.md). This version describes branch `feat/orchestrator`, where an orchestrator (Droid) replaced the watcher.

**A team of AI agents that coordinate like a team.** Each human tells their own agent what they want. An orchestrator built on Factory's Droid turns the request into tasks for the agents that own each feature, and the agents settle clashes with each other directly. People only step in for major changes to their own features, or when two agents can't agree.

## The problem

TODO (D, after the interviews): open with one real quote from a Cal Hacks team.

When four people each run a coding agent on their own laptop, every agent only sees its own machine. One agent changes `lastLogin` from seconds to milliseconds and updates every caller it can see. Another agent, on another laptop, writes new code that still assumes seconds. They touched different files, so git merges cleanly and the types still match. The app is broken anyway, and the team finds out at integration time.

## How it works

1. **Ask.** A human tells their own Claude Code agent what they want. If it goes beyond that human's own feature, the agent forwards it to the orchestrator (`ask_orchestrator`).
2. **Plan.** The orchestrator starts a Droid session on a read-only copy of `main`. Droid reads the code, `cowork.owners.json` (who owns which feature) and the team's live state, including every agent's uncommitted work, and builds a plan with our tools: a task for each owner's agent, a review for each human whose feature a major change affects, and the conflicts it expects between agents' work.
3. **Contract rule.** Code, not the model, then applies the rule: a change to a shared contract or to another owner's files is major, and the owners whose code imports that contract review it first. The plan lands in SpacetimeDB in one transaction.
4. **Review.** A major change waits on the dashboard until the affected humans click Approve (or Send back, with a note).
5. **Work.** Each agent is woken with its task by a background hook, even when idle. Before finishing, it runs `check_with_team`: its uncommitted work merged with each teammate's work in progress, then the type checker and the tests.
6. **Agents settle conflicts themselves.** When the orchestrator flags an overlap, or an agent's check finds a clash, the two agents get a conflict thread. They message each other (each message wakes the other), change their own files, and both call `agree`. Agreement plus a green check resolves it, and the agreed fact goes into shared memory for every later agent.
7. **Escalation.** If they can't agree, or after 12 messages or 5 minutes, the conflict goes to both humans, who decide on the dashboard. The decision wakes both agents.

Git, the type checker and the tests decide red or green. Droid plans and the agents talk, but no model ever declares a change green.

## Architecture

```
human --> own agent (Claude Code + hooks + MCP) --ask_orchestrator--> SpacetimeDB <-- orchestrator (Droid plans)
               |   ^                                                      |   ^
    wip/<name> |   | wakes: task, conflict, message           plan, tasks |   | requests
               v   |                                                      v   |
            GitHub <-- each agent's check_with_team (git merge + tsc + vitest, in its own clone)
                                                                          |
                                           dashboard (live): plans, reviews, threads, decisions
```

## Where each sponsor technology is used

### SpacetimeDB

Implemented in [module/src/index.ts](module/src/index.ts) for SpacetimeDB **2.13.0**, using the frozen [shared interface](shared/src/schema.ts):
- Twelve authenticated views over private backing tables hold team state: `agent`, `snapshot`, `intent`, `check_run`, `conflict`, `inbox`, `diagnosis_step`, plus the orchestrator's `request`, `task`, `review`, `message` and `plan_step`. Owner-only grant/revoke reducers manage Reader/Editor membership; signing in alone grants no access. See [access setup](module/ACCESS.md).
- `publish_plan` writes a whole plan in one transaction: its reviews, its tasks (held while a review is pending) and its flagged conflicts, plus every inbox row that wakes an agent.
- `post_message` is the agents' conversation. It resolves a conflict only when both agents' latest messages are agreements and a current green check covers both of them, so a stale or one-sided agreement can't close it.
- A schedule table escalates a conflict to both humans after 5 minutes.
- Lifecycle reducers track which agents are online. The dashboard subscribes directly, so all screens update at the same moment. There is no other backend server.

### Factory Droid SDK

The orchestrator is Droid: [orchestrator/src/planner.ts](orchestrator/src/planner.ts), run by [orchestrator/src/index.ts](orchestrator/src/index.ts).
- **Trigger:** a human's request in the database (`ask_orchestrator` from any teammate's agent).
- **Our tools:** Droid gets in-process SDK MCP tools (`team_status`, `assign_task`, `request_review`, `flag_conflict`, `finish_plan`). They only record into the plan; code applies the contract rule and publishes it.
- **Permissions:** autonomy off, so every tool call goes through our permission handler. It allows Read, Grep, Glob and LS on a disposable worktree of `main` plus our own tools, and refuses everything else; Edit, Create, ApplyPatch, Execute, Task and Skill are disabled before the first turn. The session runs with direct tool calls (we set this on the CLI's initialize request) and a 150-second deadline, and is always closed.
- **Visible work:** every step Droid takes is streamed into SpacetimeDB and shown live in the dashboard's Orchestrator drawer.
- **Measured:** on the demo request it planned in 52 s: tasks for the users and sessions owners, reviews by the two affected humans, and the seconds-versus-milliseconds clash with uncommitted work.

### Claude

- Each teammate's agent is Claude Code. Our hooks (`asyncRewake`, `Stop`, `SessionStart`, `PostToolUse`) connect it to the team.
- Agents talk to each other through our MCP tools (`message_teammate`, `agree`, `escalate`) and settle who changes what without a central fixer.
- Where it can go wrong, and what we do about it: an agent may try to make a check pass by weakening a test, so an agreement after a fix that edited an existing test goes to a person instead. A repo without tests gets false greens, so we say so plainly and rely on the type checker. Two agents can talk in circles, so a thread goes to both humans after 12 messages.

## Run it

Part C’s reproducible checks and database commands are in [module/README.md](module/README.md); the demo app and its scenario are in [demo-app/README.md](demo-app/README.md) and [demo-app/SCENARIO.md](demo-app/SCENARIO.md). `npm run test:live` plays the whole story on a temporary local SpacetimeDB. No API keys are included in this project.

1. Node 24 or newer, git, and the `spacetime` CLI.
2. `npm run setup` from this folder.
3. Copy `.env.example` to `.env` and fill it in ([external/api-keys.txt](external/api-keys.txt)).
4. `npm run module:generate` regenerates public bindings from the local module. Its verified generation wrapper preserves the frozen SQL names; see [module/generate.mjs](module/generate.mjs).
5. On each laptop: `npm run install-hooks -- --demo <path to demo-app> --name <you>`.
6. On one machine (with `FACTORY_API_KEY` and `DEMO_REPO_PATH` set): `npm run orchestrator`. On the big screen: `npm run ui`.

## Limitations

TODO (D): copy the final "not built" list from [pitch/qa.md](pitch/qa.md).

## Team

TODO: names, and who built which part.
