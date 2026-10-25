# Agent Cowork: plan

> **What this file is for:** the team's working plan for Cal Hacks 13.0. It covers what we build, who builds which part, and when. [structure.md](structure.md) lists every file in this folder, and each file starts with a note saying what it does.

Updated Sat Oct 24, 1:50 AM; the design part updated Sat 5:30 PM on branch `feat/orchestrator`, where an orchestrator (Droid) replaced the watcher ([checklists/orchestrator.md](checklists/orchestrator.md)). Submission is Sun Oct 25, 9:00 AM. Judging is 10:30–12:30, and all four of us have to be at the table.

## One line

A team of AI agents that coordinates like a team: each human tells their own agent what they want, an orchestrator (Droid) assigns the work to the agents that own each feature, and the agents settle clashes with each other before anyone commits.

## Who it's for

Hackathon teams of four where each person runs Claude Code on their own laptop. D interviews three Cal Hacks teams tonight and gets one quote for the pitch ([pitch/interviews.md](pitch/interviews.md)).

## The problem

Each agent only sees its own laptop. A changes `lastLogin` from seconds to milliseconds and updates every caller that is on `main`. Meanwhile B, on another laptop, writes new code that still assumes seconds. They edited different files, so git merges cleanly and the types still match. The app is broken anyway, and nobody finds out until integration at 4 AM.

## How it works

1. **Ask.** A human tells their own agent what they want. If it goes beyond that human's own feature, the agent calls `ask_orchestrator`, which stores a `request` row.
2. **Plan.** The orchestrator (one process, `npm run orchestrator`) starts a Droid session on a disposable worktree of `main`. Droid reads the code, `cowork.owners.json` and the team's live state (tasks in flight, every agent's uncommitted snapshot) and plans with our tools: `assign_task` per owner, `request_review` for each human whose feature a major change affects, `flag_conflict` for overlaps it expects.
3. **Contract rule.** Code applies it after Droid: a task touching a shared contract (`src/contracts/`) or another owner's files is major, and the owners whose code imports the contract (on `main` or in a snapshot) review it. `publish_plan` writes the plan in one transaction.
4. **Review.** With a review, the tasks wait. The reviewer's human clicks Approve or Send back on the dashboard.
5. **Work.** Each agent's listener hook wakes it with its task, even when idle (the listener also starts at session start and on every prompt). Snapshots still go to `wip/<name>` after every edit. Before finishing, an agent runs `check_with_team`: tsc + vitest on its work alone and merged with each teammate's work in progress. `complete_task` needs a green check.
6. **Settle.** A flagged overlap, or a red pair from a check, opens a conflict thread between the two agents. They talk (`message_teammate` wakes the other), change their own files, and both `agree`. Both agreeing plus a current green check covering both resolves it, and the agreed sentence becomes a verified fact.
7. **Escalate.** `escalate`, 12 messages without agreement, or 5 minutes open: the conflict goes to both humans, who decide on the dashboard. The decision wakes both agents.
8. **Full stack.** The orchestrator merges main and every agent's latest snapshot in a disposable worktree whenever one changes, runs tsc + vitest, and pushes the result to `cowork/full-stack` only when it's green (the team's working main; real `main` is never written). A finished request triggers a build and a note to every agent; `get_full_stack` / `npm run full-stack` puts it in `<clone>-full-stack` on any laptop. Droid's planning worktree starts from it.

Git, tsc and the tests decide red or green. Droid plans and the agents negotiate; no model declares green.

### Who adapts

Nobody is assigned. A conflict row still names a suggested agent: the orchestrator's suggestion for a flagged overlap, or, for a red check, the agent whose changed lines contain the first error (B's rule). The two agents decide between them who changes what. A change that fails alone but passes together with a teammate's (A changes the contract, B adapts sessions) counts as green: the two land together.

### Listener

Each edit, each prompt, each cowork tool call and each session start begins a background hook (`asyncRewake`). The newest one per agent stays alive for up to 25 minutes and wakes the agent for a task, a new conflict thread, or a message in one. Older ones exit as soon as a newer one starts.

## Architecture

```
human -> own agent (hooks + MCP) --ask_orchestrator--> SpacetimeDB <--requests/plan-- orchestrator (Droid)
            |  ^ wakes: task, conflict, message           |
  wip/<name>|  |                                           +--subscribe--> dashboard (plans, reviews, threads)
            v  |
         GitHub <-- each agent's check_with_team (git merge + tsc + vitest in its own clone)
```

Git stores the code. SpacetimeDB holds the team's live state: requests, plans, tasks, reviews, snapshots, check results, conflict threads, inboxes and memory.

## Components

| Part | What it does | Owner | Folder |
|---|---|---|---|
| Hooks | Snapshot and push, listener that wakes the agent (tasks, conflicts, messages), Stop nudge, context injection | A | `hooks/` |
| MCP server | `ask_orchestrator`, `post_intent`, `team_status`, `pull_teammate`, `check_with_team`, `message_teammate`, `agree`, `escalate`, `complete_task`; presence | A | `mcp/` |
| SpacetimeDB module | Tables, reducers (plans in one transaction, conflict threads, reviews), escalation timer, presence | C | `module/` |
| Shared interface | Frozen table and reducer definitions, config, HTTP client, owners file reader | C (everyone reads) | `shared/` |
| Checks | Merge snapshots, run tsc + vitest, find the pair, suggest who adapts, guard against weakened tests | B | `checks/` |
| Orchestrator | Droid planner with our tools, contract rule, import scan, publish | A (was B's watcher slot) | `orchestrator/` |
| Diagnosis (not wired) | C's Droid and Claude diagnosis, kept with its tests | C | `orchestrator/src/diagnose/` |
| UI | Agent cards, orchestrator drawer (plans, reviews), conflict threads, decisions, memory, timeline, big-screen mode | D | `ui/` |
| Demo app | The small app the agents edit during the demo, its owners file and the scripted story | C | `demo-app/` |
| Pitch | Demo script, Q&A, interviews, Devpost text, video | D | `pitch/` |

Anything that isn't a file (accounts, keys, the hosted database, the MCP registration on each laptop) is written up in [external/](external/).

## Freeze tonight

- [shared/src/schema.ts](shared/src/schema.ts): tables, row shapes, reducer names and argument order.
- SpacetimeDB version (picked: 2.x, CLI and SDK 2.13) and database name ([external/spacetimedb-maincloud.txt](external/spacetimedb-maincloud.txt)).
- Formats: branch `wip/<name>`, env var `COWORK_NAME`, location `path:line`, timestamps in milliseconds.
- Repos: this folder is repo 1 (the tool, our submission). `demo-app/` is repo 2 with its own git, and repo 1 ignores it.

## Schedule

### Tonight, 1:50–3:20 AM

| Time | Who | Task |
|---|---|---|
| 0:00–0:20 | All four | Read `shared/src/schema.ts` together and freeze it. Pick the SpacetimeDB version. Create both GitHub repos. |
| 0:20–1:20 | A | Run `hooks/src/rewake-spike.ts`: does an idle Claude session wake up? Then push a test `wip/<name>` branch with the snapshot commands. |
| 0:20–1:20 | B | `watcher/src/spike.ts`: two branch names → temp worktree → merge → `tsc` → print errors. No database yet. |
| 0:20–1:20 | C | SpacetimeDB quickstart, then publish the real module with every table and stub reducers. |
| 0:20–1:20 | D | Interview teams for 20 minutes (people are integrating right now). Then a React client that subscribes to C's tables. |
| 1:20–1:30 | All four | Push. One line each in team chat: "works" or "blocked on X". Sleep. |

### Saturday

| Time | A (hooks + MCP) | B (watcher) | C (module, demo app, diagnosis) | D (UI + pitch) |
|---|---|---|---|---|
| 9:00–9:20 | Standup: read last night's results. If `asyncRewake` failed, switch to the fallback (next tool call plus the Stop hook). | | | |
| 9:20–13:00 | Snapshot hook and `post_snapshot`, then the listener, then the Stop hook | Subscribe to snapshots, fetch, merge every wip, tsc + vitest, `report_check` | Real reducers (`report_conflict` in one transaction, `resolve_conflict`, the escalation timer). Demo app and scripted conflict. | Agent cards and conflict panel against fake rows (`scripts/seed-fake.ts`) |
| **13:00** | **Checkpoint 1:** a fake snapshot goes to the watcher, becomes a conflict row and shows up in the UI. | | | |
| 14:00–19:00 | With B on two laptops: real edit → red → idle agent wakes → fix → green | Pairwise search, mapping `file:line` back to the diffs, fixer rule | Droid diagnosis (Claude fallback). Scenario reproduces 5 out of 5. Agent rules in `demo-app/CLAUDE.md`. | Timeline, Droid panel, big-screen mode. Drafts of the pitch and Devpost text. |
| **19:00** | **Checkpoint 2:** the whole real loop runs end to end. From here the demo exists. | | | |
| 20:00–24:00 | MCP server (`post_intent`, `pull_teammate`, presence) and injecting intents through the hooks | Guard against fixes that edit tests, cache by sha, keep each check under 15 s | Verified facts written back to memory. Second scenario: memory prevents the bug. Whoever of A or C is free adds `madge` (`watcher/src/deps.ts`). | Memory panel. Record a rough backup video. **Submit a Devpost draft tonight** (the Guide strongly recommends it). |
| **0:00** | **Checkpoint 3:** first full demo rehearsal. | | | |
| 0:00–3:00 | Stretch: contract lock (with D) | Bug fixes | Bug fixes, README | Stretch: approve button |

### Sunday

- 3:00–5:00: bug fixes only. **Code freeze at 5:00.**
- 5:00–8:30: D records the video twice and finishes Devpost. C finishes the README. A and B run the demo five times. **Submit by 8:30**, which leaves 30 minutes of buffer.
- Before 8:00: one of us claims the table (Devpost says tables are claimed by then; the Guide says they're assigned after 9). Ask in #0-ask-directors on Saturday.
- Between 0:00 and 4:00, nap in pairs, two hours each, so everyone is awake by 4:00.

### If we fall behind

If a checkpoint slips by more than an hour, cut the lowest item in that block. Priority order: real loop, then the explanation, then memory, then the escalation timer, then stretch. B is the critical path, so whoever finishes early helps B.

## Demo (2 minutes)

The full script is in [pitch/demo-script.md](pitch/demo-script.md), and the exact steps are in [demo-app/SCENARIO.md](demo-app/SCENARIO.md).

1. Open with the other team's quote.
2. Two laptops and the big screen. B's agent has built an idle-time feature that assumes seconds and gone idle.
3. A's human asks their agent for milliseconds; the agent asks the orchestrator. Droid's steps stream on the big screen and the plan lands: a task for a, a task for b, B's human to review, and a flagged clash a x b with B's uncommitted idle.ts.
4. B's human clicks Approve. Both agents wake with their tasks. A changes the unit and tells B; B pulls A's change, adapts, and agrees on a green check; A agrees. The fact appears in memory.
5. C's agent starts a task that touches `lastLogin`, gets the fact injected and writes it correctly the first time.
6. Close: "Droid plans. The agents that own the code settle clashes between them. Tests decide red or green, and people decide what changes their features." Then say where it goes wrong: an agent may weaken a test to get green, and we send that to a person; two agents may disagree, and their humans decide.

## Prizes

- **SpacetimeDB:** every bit of coordination state lives there. A plan is one transaction (tasks, reviews, conflicts, wakeups), a conflict resolves only on two agreements plus a current green check, escalation uses a schedule table, presence uses lifecycle reducers, and the UI updates live on three screens.
- **Factory (Best Use of Droid SDK, $2,000 + credits, one winner):** Droid is the orchestrator: our trigger (a request in the database), our own SDK tools, permission controls (autonomy off, read tools only, disposable worktree), and every step visible on the dashboard. The README says where Droid is used.
- **Anthropic:** a named community, Claude Code hooks (`asyncRewake` on tool calls, prompts and session start; Stop; SessionStart), agents negotiating through MCP tools, and failure modes we handle (weakened tests, endless arguments, false greens when a repo has no tests).
- **Most Technically Advanced:** an AI planner bounded by a code-enforced contract rule, speculative merging of uncommitted work run by each agent, agent-to-agent negotiation that only closes on tests, and waking idle agents.
- **Hacker's Choice:** see stretch item 5.

## Stretch, in order

1. Contract lock: a PreToolUse hook blocks an agent's edit to a shared contract or another owner's file unless an approved task covers it.
2. Droid explains a red check in the conflict thread (C's diagnosis code in `orchestrator/src/diagnose/`).
3. Explanation as a SpacetimeDB procedure (beta).
4. Function-level dependencies (who calls `getUser()`) for the contract rule, on top of the import scan.
5. Another team uses it for an hour. That gets us a real quote and real numbers.

## Risks

| Risk | What we do |
|---|---|
| Droid is slow (about 50 s per plan) | Its steps stream to the big screen, so the wait is part of the show. Try a faster DROID_MODEL_ID before the demo. |
| Droid is down or out of credits | The request shows "Planning failed" with the reason; ask again. `COWORK_PLAN_FILE` runs a scripted plan, labeled as scripted on the dashboard: rehearsals only, never presented as Droid. |
| Two agents argue in circles | 12 messages, or 5 minutes, and it goes to both humans. |
| An agent "fixes" things by weakening a test | Rule in `demo-app/CLAUDE.md`; `agree` runs the test guard, and a fix that edited an existing test goes to a person. |
| An idle agent isn't woken by its first task | The listener starts at session start and on every prompt as well as after edits. If it still doesn't wake, type `continue`: inject-context delivers it. |
| The fixer can't see the teammate's uncommitted change | `pull_teammate` brings it into the agent's working tree. Tested with real git. |
| Real teams don't write tests | tsc catches most breaks, and the orchestrator flags overlaps before any test runs. Say so in Q&A. |
| The live demo is flaky | Scripted scenario, rehearsed five times, plus a recorded backup. Never fake agent output. |

## Not building

Our own version control, auto-merge to main, a permission system beyond the contract rule, or support for agents from other vendors.

## Team rules

- Every file starts with a note saying what it's for. When you change what a file does, update that note too.
- Don't commit `.env` or any key. Keys are listed in [external/api-keys.txt](external/api-keys.txt).
- Start from public templates (`npm create vite`, `spacetime init`), not our own starters. Cal Hacks rule: all project code is written during the event.
- When someone asks "what changed?", the answer goes in team chat in one line.
