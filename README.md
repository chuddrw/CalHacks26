# Agent Cowork

> **What this file is for:** the public README for GitHub, Devpost and judges. It explains what the project does, how to run it, and where each sponsor technology is used. C finishes it on Sunday between 3:00 and 5:00 AM; until then, the sections marked TODO are placeholders. The team's internal plan is in [plan.md](plan.md).

**Live CI for a team's AI agents.** Agent Cowork checks everyone's uncommitted work together and wakes up the agent that has to fix a break, before anyone commits.

## The problem

TODO (D, after the interviews): open with one real quote from a Cal Hacks team.

When four people each run a coding agent on their own laptop, every agent only sees its own machine. One agent changes `lastLogin` from seconds to milliseconds and updates every caller it can see. Another agent, on another laptop, writes new code that still assumes seconds. They touched different files, so git merges cleanly and the types still match. The app is broken anyway, and the team finds out at integration time.

## How it works

1. After every edit, a Claude Code hook snapshots the agent's working tree and force-pushes it to `wip/<name>`, without touching the agent's own branch.
2. A watcher merges every agent's latest snapshot onto `main` in a temporary worktree and runs `tsc` and the tests.
3. If the merged code fails, the watcher tests each snapshot alone and in pairs to find the two changes that clash, and picks which agent should fix it.
4. Droid investigates the failure in a disposable worktree and writes an explanation.
5. The fixer's background hook exits with code 2, which wakes the agent even when it's idle. The agent pulls the teammate's in-progress change into its own working tree, fixes its own code, and the check turns green.
6. The verified fact goes into shared memory, so the next agent gets it right the first time.

Git, the type checker and the tests decide red or green. AI only explains.

## Architecture

```
laptops: hooks + MCP server ──git push──▶ GitHub  wip/<name> ◀──fetch── watcher (tsc + vitest, Droid)
        │                                                              │
        └────────HTTP (hooks) / WebSocket (MCP)──▶ SpacetimeDB ◀──subscribe┘
                                                       │
                                                       └──subscribe──▶ dashboard (live)
```

## Where each sponsor technology is used

### SpacetimeDB

Implemented in [module/src/index.ts](module/src/index.ts) for SpacetimeDB **2.13.0**, using the frozen [shared interface](shared/src/schema.ts). Local transactional and HTTP integration checks pass:
- Seven public tables hold team state: `agent`, `snapshot`, `intent`, `check_run`, `conflict`, `inbox`, and `diagnosis_step`. Twelve public reducers preserve the shared argument order. Public IDs and millisecond timestamps remain JavaScript numbers.
- `report_conflict` creates the conflict, assigns the fixer and writes both inboxes in a single transaction, so two agents never both try to fix the same break.
- A schedule table escalates a conflict to a human if it stays open for 5 minutes.
- Lifecycle reducers track which agents are online.
- The dashboard subscribes directly, so all screens update at the same moment. There is no other backend server.

### Factory Droid SDK

Implemented in [watcher/src/diagnose/droid.ts](watcher/src/diagnose/droid.ts), behind the [injected diagnosis contract](watcher/src/diagnose/README.md):
- **Trigger:** Part B can invoke the diagnosis runner after recording a red conflict, supplying that run’s evidence, database callbacks, and a dedicated disposable worktree. Part B’s orchestration remains a separate implementation.
- **Permissions:** Droid has autonomy off, editing and connector tools disabled, and a deny-by-default command grammar that permits specific reads and checks. Its session closes after success, failure, or a 90-second timeout. This is SDK permission control, not an operating-system sandbox.
- **Visible work:** every Droid step is streamed into SpacetimeDB and shown live in the dashboard's Droid panel.
- **Output:** a plain-language cause and suggested fix for the deterministically chosen fixer, plus a proposed fact. Only a later green check publishes that fact as verified memory. Claude is the bounded fallback; missing credentials produce an unavailable step. SDK types and mocked regressions pass; paid live model calls have not been run.

### Claude

- Each teammate's agent is Claude Code. Our hooks (`asyncRewake`, `Stop`, `SessionStart`, `PostToolUse`) connect it to the team.
- If Droid is unavailable, one Claude API call writes the explanation instead (`watcher/src/diagnose/claude.ts`).
- Where it can go wrong, and what we do about it: an agent may try to make a check pass by weakening a test, so any fix that edits a test is sent to a human. A repo without tests gets false greens, so we say so plainly and rely on the type checker.

## Run it

Part C’s reproducible checks and database commands are in [module/README.md](module/README.md); the separate local demo app and five-run scenario are in [demo-app/README.md](demo-app/README.md). Parts A, B, and D still contain their own skeletons, so a complete live edit → wake → fix rehearsal remains dependent on those implementations. No API keys are included in this project.

1. Node 24 or newer, git, and the `spacetime` CLI.
2. `npm run setup` from this folder.
3. Copy `.env.example` to `.env` and fill it in ([external/api-keys.txt](external/api-keys.txt)).
4. `npm run module:generate` regenerates public bindings from the local module. Its verified generation wrapper preserves the frozen SQL names; see [module/generate.mjs](module/generate.mjs).
5. On each laptop: `npm run install-hooks -- --demo <path to demo-app> --name <you>`.
6. On one machine: `npm run watcher`. On the big screen: `npm run ui`.

## Limitations

TODO (D): copy the final "not built" list from [pitch/qa.md](pitch/qa.md).

## Team

TODO: names, and who built which part.
