# Agent Cowork: plan

> **What this file is for:** the team's working plan for Cal Hacks 13.0. It covers what we build, who builds which part, and when. [structure.md](structure.md) lists every file in this folder, and each file starts with a note saying what it does.

Updated Sat Oct 24, 1:50 AM. Submission is Sun Oct 25, 9:00 AM. Judging is 10:30–12:30, and all four of us have to be at the table.

## One line

Live CI for a team's AI agents. It checks everyone's uncommitted work together and wakes up the agent that has to fix a break, before anyone commits.

## Who it's for

Hackathon teams of four where each person runs Claude Code on their own laptop. D interviews three Cal Hacks teams tonight and gets one quote for the pitch ([pitch/interviews.md](pitch/interviews.md)).

## The problem

Each agent only sees its own laptop. A changes `lastLogin` from seconds to milliseconds and updates every caller that is on `main`. Meanwhile B, on another laptop, writes new code that still assumes seconds. They edited different files, so git merges cleanly and the types still match. The app is broken anyway, and nobody finds out until integration at 4 AM.

## How it works

1. **Snapshot.** After every edit, a hook builds a throwaway commit of the working tree (without touching the agent's branch or index) and force-pushes it to `wip/<name>`. Then it calls the `post_snapshot` reducer.
2. **Check.** The watcher subscribes to the `snapshot` table. It merges every agent's latest wip commit onto `main` in a temporary worktree and runs `tsc --noEmit` and `vitest run`.
3. **Find the pair.** If the check is red, the watcher tests each wip alone and then in pairs, and picks a fixer (rule below). The `report_conflict` reducer creates the conflict, assigns the fixer and writes both inboxes in one transaction.
4. **Diagnose.** Droid (Factory's SDK) runs in a throwaway worktree with its edit tools turned off, investigates the failure and writes the explanation. If Droid is flaky, one Claude call does it instead.
5. **Wake and fix.** The fixer's listener hook sees the conflict and exits with code 2. Claude Code then wakes that agent, even if it's idle. The agent calls `pull_teammate` to bring the other agent's in-progress change into its own working tree (it isn't on that laptop otherwise), adapts its own files until the tests pass, and the next snapshot turns the check green.
6. **Remember.** On green, the verified fact (for example "`lastLogin` is milliseconds") goes into shared memory and into every agent's inbox. Agents also post their intent before changing exported code, and hooks pass teammates' intents along.

Git, tsc and the tests decide red or green. Droid and Claude only explain the failure.

### Who fixes

1. A snapshot that fails on its own: its author fixes it (kind `self`).
2. A textual merge conflict: whoever pushed last (kind `merge`).
3. A pair that only fails together: the agent whose changed lines contain the first error location. If that's neither or both of them, whoever pushed last (kind `pair`).

In the demo the error shows up in B's new file, so B fixes it even though A pushed last.

### Listener

Each edit starts a background hook (`asyncRewake`). The newest one per agent stays alive for up to 25 minutes and watches for conflicts assigned to that agent. Older ones exit as soon as a newer one starts. This is what lets an idle agent get woken: by the time the watcher turns red, the agent has usually finished its turn.

## Architecture

```
laptops: hooks + MCP server ──git push──▶ GitHub  wip/<name> ◀──fetch── watcher (tsc + vitest, Droid)
        │                                                              │
        └────────HTTP (hooks) / WebSocket (MCP)──▶ SpacetimeDB ◀──subscribe┘
                                                       │
                                                       └──subscribe──▶ UI (3 screens, live)
```

Git stores the code. SpacetimeDB holds the team's live state: who is doing what, snapshots, check results, conflicts, inboxes and memory.

## Components

| Part | What it does | Owner | Folder |
|---|---|---|---|
| Hooks | Snapshot and push, listener that wakes the agent, Stop guard, context injection | A | `hooks/` |
| MCP server | `post_intent`, `team_status` and `pull_teammate` tools; keeps a live connection so the UI knows who's online | A | `mcp/` |
| SpacetimeDB module | Tables, reducers, escalation timer, presence | C | `module/` |
| Shared interface | Frozen table and reducer definitions, config, HTTP client | C (everyone reads) | `shared/` |
| Watcher | Merge, check, find the pair, pick the fixer, guard against weakened tests, dependency heads-up | B | `watcher/` |
| Diagnosis | Droid diagnosis, with a Claude call as fallback | C | `watcher/src/diagnose/` |
| UI | Agent cards, conflict panel, Droid panel, memory, timeline, big-screen mode | D | `ui/` |
| Demo app | The small app the agents edit during the demo, with the scripted conflict | C | `demo-app/` |
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
2. Two laptops and the big screen. Agents are working and their intents show up live.
3. B's agent adds an idle-time feature that assumes seconds, then goes idle. A's agent switches `lastLogin` to milliseconds and updates every caller it can see. Git merges cleanly and the types match. About 10 seconds later the screen turns red: `src/users/user.ts × src/sessions/idle.ts`, with Droid's steps and explanation. B's agent wakes up on its own, pulls A's in-progress change, and fixes its own code. The screen turns green and the verified fact appears in memory.
4. C's agent starts a task that touches `lastLogin`, gets the fact injected and writes it correctly the first time.
5. Close: "Git stores the code. SpacetimeDB holds the team's live state. Tests decide red or green; Droid explains." Then say where Claude goes wrong: it may try to weaken a test to get green, and we send that to a human.

## Prizes

- **SpacetimeDB:** every bit of coordination state lives there. Fixer assignment is one transaction, escalation uses a schedule table, presence uses lifecycle reducers, and the UI updates live on three screens.
- **Factory (Best Use of Droid SDK, $2,000 + credits, one winner):** Droid starts on a trigger we built (a red check), runs with permission controls (edit tools off, `git push` blocked, disposable worktree), and its steps are visible in the UI. The README has to say where Droid is used.
- **Anthropic:** a named community, Claude Code hooks (`asyncRewake`, Stop, SessionStart), and failure modes we handle (weakened tests, false greens when a repo has no tests).
- **Most Technically Advanced:** speculative merging of uncommitted work across machines, pairwise culprit search, and waking idle agents.
- **Hacker's Choice:** see stretch item 5.

## Stretch, in order

1. Contract lock: a PreToolUse hook blocks edits under `src/contracts/`, and a person approves them in the UI.
2. Claude "suspected conflict": compare each agent's intent with the other agents' diffs, and mark matches as suspected, never red.
3. Explanation as a SpacetimeDB procedure (beta).
4. Function-level dependencies (who calls `getUser()`), on top of file-level `madge`.
5. Another team uses it for an hour. That gets us a real quote and real numbers.

## Risks

| Risk | What we do |
|---|---|
| `asyncRewake` doesn't wake an idle agent | Test it tonight. Fallback: warn on the next tool call, plus the Stop hook. |
| Two agents fight over one fix | Only the fixer gets woken; the other agent only gets an info note. |
| The fixer can't see the teammate's uncommitted change | `pull_teammate` brings it into the fixer's working tree. Tested with real git on Oct 24. |
| An agent "fixes" things by weakening a test | Rule in `demo-app/CLAUDE.md`, and the watcher sends test edits made during a fix to a human. |
| The watcher is slow | Small repo, cache per sha, and pairs only when the full check is red. |
| Real teams don't write tests | tsc catches most breaks. Say so in Q&A; stretch item 2 covers the rest. |
| The live demo is flaky | Scripted scenario, rehearsed five times, plus a recorded backup. Never fake agent output. |
| Droid is slow or down | Claude fallback in `watcher/src/diagnose/claude.ts`. |

## Not building

Our own version control, an integration branch or auto-merge, file ownership, a review UI, a permission system, or support for agents from other vendors.

## Team rules

- Every file starts with a note saying what it's for. When you change what a file does, update that note too.
- Don't commit `.env` or any key. Keys are listed in [external/api-keys.txt](external/api-keys.txt).
- Start from public templates (`npm create vite`, `spacetime init`), not our own starters. Cal Hacks rule: all project code is written during the event.
- When someone asks "what changed?", the answer goes in team chat in one line.
