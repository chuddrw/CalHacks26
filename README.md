# Orkio — Making Multi-Agent Coding Work Together

**A team of AI agents that coordinates like a team.** Each developer keeps using their own coding agent and local workspace. Orkio gives those agents shared context, delegates cross-cutting work, tests unfinished changes together, and brings people in only when judgment or approval is needed.

## Inspiration

AI coding agents make individual developers faster, but multiple developers using agents on the same project still face a familiar problem: integration. Each agent sees one machine and one working tree, while the code they produce shares interfaces, dependencies, and assumptions.

One agent might change `lastLogin` from seconds to milliseconds while another writes a caller that still assumes seconds. Their Git branches can merge cleanly and their types can still match, yet the application is wrong. **Git can tell us whether code merges, but not necessarily whether it works together.**

As more agents work in parallel, developers become the bridge between isolated contexts: relaying decisions, comparing unfinished changes, resolving conflicts, and assembling a runnable build. We built Orkio as a real-time coordination layer that reduces that overhead without replacing developers' existing tools.

## What it does

### Coordinates unfinished work across computers

Each agent publishes its uncommitted working tree as a snapshot on a dedicated `wip/<agent>` branch. The snapshot process uses Git plumbing and does not commit to, switch, stage, stash, or modify the developer's active branch. Intent, affected files, presence, and snapshot metadata are reported to SpacetimeDB so teammates can see relevant work before final integration.

### Plans cross-cutting requests

A developer can send a request to the orchestrator from their own agent. The orchestrator reads the current code, feature ownership, shared state, and all agents' latest unpublished work. It produces owner-specific tasks, identifies expected overlaps, and requests human review when a shared contract or another person's feature is affected.

### Lets the responsible agents settle conflicts

Agents run `check_with_team` before finishing. It combines their work with teammates' current snapshots in an isolated worktree and runs TypeScript and Vitest. If work conflicts, the affected agents receive a shared thread, agree on who changes what, and validate the result. Stale checks and one-sided agreements cannot resolve a conflict. Unresolved threads escalate to people after five minutes or twelve messages.

### Maintains a runnable full stack

The orchestrator rebuilds `cowork/full-stack` whenever an agent publishes work. It pushes that branch only after the combined code passes the type checker and tests. When all tasks are complete, every agent is notified and can retrieve the integrated project with `get_full_stack` or `npm run full-stack`.

### Keeps humans in control

Major cross-owner changes wait for approval. Humans can approve or send plans back with a note, decide escalated conflicts, and retain control over final integration. Orkio never automatically publishes work to `main`.

## How it works

1. **Ask.** A human tells their own Claude Code agent what they want. If it goes beyond that human's own feature, the agent forwards it to the orchestrator (`ask_orchestrator`).
2. **Plan.** The orchestrator starts a Droid session on a read-only copy of `main`. Droid reads the code, `cowork.owners.json` (who owns which feature) and the team's live state, including every agent's uncommitted work, and builds a plan with our tools: a task for each owner's agent, a review for each human whose feature a major change affects, and the conflicts it expects between agents' work.
3. **Contract rule.** Code, not the model, then applies the rule: a change to a shared contract or to another owner's files is major, and the owners whose code imports that contract review it first. The plan lands in SpacetimeDB in one transaction.
4. **Review.** A major change waits on the dashboard until the affected humans click Approve (or Send back, with a note).
5. **Work.** Each agent is woken with its task by a background hook, even when idle. Before finishing, it runs `check_with_team`: its uncommitted work merged with each teammate's work in progress, then the type checker and the tests.
6. **Agents settle conflicts themselves.** When the orchestrator flags an overlap, or an agent's check finds a clash, the two agents get a conflict thread. They message each other (each message wakes the other), change their own files, and both call `agree`. Agreement plus a green check resolves it, and the agreed fact goes into shared memory for every later agent.
7. **Escalation.** If they can't agree, or after 12 messages or 5 minutes, the conflict goes to both humans, who decide on the dashboard. The decision wakes both agents.
8. **Full stack.** The orchestrator keeps everyone's latest work merged on `cowork/full-stack`, rebuilt whenever someone's work changes and pushed only when tsc and the tests pass on the whole thing: a main branch that always runs. When a request is done, every agent hears it, and `get_full_stack` (or `npm run full-stack`) puts the whole project next to each laptop's clone, ready to demo. Droid plans on top of it, so it sees everyone's files.

Git, the type checker and the tests decide red or green. Droid plans and the agents talk, but no model ever declares a change green.

## Architecture

```text
human --> own agent (Claude Code + hooks + MCP) --ask_orchestrator--> SpacetimeDB <-- orchestrator (Droid plans)
               |   ^                                                      |   ^
    wip/<name> |   | wakes: task, conflict, message           plan, tasks |   | requests
               v   |                                                      v   |
            GitHub <-- each agent's check_with_team (git merge + tsc + vitest, in its own clone)
                                                                          |
                                           dashboard (live): plans, reviews, threads, decisions
```

## How we built it

Orkio uses Claude Code hooks, MCP, Git, TypeScript, Vitest, Factory Droid SDK, and SpacetimeDB. Local agents keep their existing workspaces; Git carries immutable snapshots; SpacetimeDB holds synchronized coordination state; the orchestrator plans and maintains the integrated branch; and the dashboard makes this background activity visible.

### SpacetimeDB

Implemented in [module/src/index.ts](module/src/index.ts) for SpacetimeDB 2.13.0, using the frozen [shared interface](shared/src/schema.ts):
- Twelve authenticated views over private backing tables hold team state: `agent`, `snapshot`, `intent`, `check_run`, `conflict`, `inbox`, `diagnosis_step`, plus the orchestrator's `request`, `task`, `review`, `message` and `plan_step`. Owner-only grant/revoke reducers manage Reader/Editor membership; signing in alone grants no access. See [access setup](module/ACCESS.md).
- `publish_plan` writes a whole plan in one transaction: its reviews, its tasks (held while a review is pending) and its flagged conflicts, plus every inbox row that wakes an agent.
- `post_message` is the agents' conversation. It resolves a conflict only when both agents' latest messages are agreements and a current green check covers both of them, so a stale or one-sided agreement can't close it.
- A schedule table escalates a conflict to both humans after 5 minutes.
- Lifecycle reducers track which agents are online. The dashboard subscribes directly, so all screens update at the same moment. There is no other backend server.

#### Sponsor track alignment — Best Use of SpacetimeDB

SpacetimeDB is Orkio's core real-time backend, not an auxiliary database added for submission. The product stops coordinating if SpacetimeDB is removed: agents can no longer discover teammates, publish shared intent, receive tasks, negotiate conflicts, request reviews, or observe completion.

- **Live shared state:** agents on separate computers share presence, intentions, snapshots, tasks, reviews, conflict threads, decisions, and test results through one persistent state model.
- **Instant synchronization:** agents and the React dashboard subscribe to changes, so a new plan, message, approval, escalation, or status update appears without polling or a separate synchronization server.
- **Transactional updates:** reducers apply related state transitions atomically. Publishing a plan creates its tasks, reviews, predicted conflicts, and wake-up notifications together; conflict resolution verifies both agents' agreement and a current green check before committing the result.
- **Server-side logic close to the data:** permissions, stale-result protection, task lifecycle rules, conflict escalation, and completion checks execute in the SpacetimeDB module rather than being trusted to individual clients.
- **Multi-user and multi-agent interaction:** Orkio is a multiplayer productivity system for AI-assisted development. Each developer and agent acts independently while SpacetimeDB maintains a consistent shared coordination world across machines.
- **Visible working demo:** judges can watch agents come online, publish unfinished work, receive orchestrated tasks, exchange conflict messages, approve major changes, and update the full-stack build live in the dashboard.

### Factory Droid SDK

The orchestrator is Droid: [orchestrator/src/planner.ts](orchestrator/src/planner.ts), run by [orchestrator/src/index.ts](orchestrator/src/index.ts).
- **Trigger:** a human's request in the database (`ask_orchestrator` from any teammate's agent).
- **Our tools:** Droid gets in-process SDK MCP tools (`team_status`, `assign_task`, `request_review`, `flag_conflict`, `finish_plan`). They only record into the plan; code applies the contract rule and publishes it.
- **Permissions:** autonomy off, so every tool call goes through our permission handler. It allows Read, Grep, Glob and LS on a disposable worktree of `main` plus our own tools, and refuses everything else; Edit, Create, ApplyPatch, Execute, Task and Skill are disabled before the first turn. The session runs with direct tool calls (we set this on the CLI's initialize request) and a 150-second deadline, and is always closed.
- **Visible work:** every step Droid takes is streamed into SpacetimeDB and shown live in the dashboard's Orchestrator drawer.
- **SDK features used** (all in [planner.ts](orchestrator/src/planner.ts)): `createSession` (a full coding agent with its own read and search tools, started on the worktree), `AutonomyLevel.Off` with a `permissionHandler`, `createSdkMcpServer` for our in-process tools, `disabledToolIds` and `listTools`/`updateSettings` to switch off every built-in tool that isn't a read tool, `disableBuiltinSkills`, and `session.stream()` for the live steps. A request deadline (`AbortController`) and a `finally` block close the session and the tool server.
- **Why Droid and not a bare model API:** the SDK gives us the agent harness (file reading, search, the tool-permission loop, streaming) so we only configure its limits. The read-only boundary, the worktree and the contract rule are our own design and would work with another model; Droid saves us from building the harness.
- **Measured:** on the demo request it planned in 52 s: tasks for the users and sessions owners, reviews by the two affected humans, and the seconds-versus-milliseconds clash with uncommitted work.

### Claude Code, hooks, and MCP

- Each teammate's agent is Claude Code. Our hooks (`asyncRewake`, `Stop`, `SessionStart`, `PostToolUse`) connect it to the team.
- Agents publish snapshots after edits without changing their current branch, receive tasks and messages while idle, and load shared context when a session begins.
- Agents talk through MCP tools such as `message_teammate`, `agree`, and `escalate`. A fix that edits an existing test requires human review, and a repository without tests is reported honestly rather than treated as strong evidence.

### Git and isolated verification

Snapshots are built with `write-tree` and `commit-tree` and pushed to per-agent WIP branches. Verification happens in disposable worktrees, so failed combinations never modify developers' active branches. The same mechanism builds the tested `cowork/full-stack` branch.

### Dashboard

The React dashboard subscribes directly to SpacetimeDB. It shows presence, active intent, plans, required reviews, tasks, integration results, conflict conversations, escalations, and the orchestrator's streamed progress.

## Challenges we ran into

### Finding the right architecture

An earlier design centered on a watcher that diagnosed every combined failure. The current design gives the orchestrator a narrower planning role, lets the agents that own affected code negotiate repairs directly, and relies on deterministic checks for green or red status. This reduced central complexity while keeping coordination state shared.

### Preserving local workflows

Developers should not have to surrender their working branch to participate. Producing publishable snapshots without touching the real index, stash, branch, or uncommitted files required careful use of Git plumbing and isolated worktrees.

### Preventing stale evidence

Distributed checks and model responses can finish after newer work has arrived. Snapshot IDs, run keys, guarded reducers, and transactional state changes ensure an old result cannot mark newer code green or resolve a newer conflict.

### Balancing autonomy and oversight

Automatic delegation is useful until a change alters someone else's contract or weakens a test. We separated model-generated plans from code-enforced review rules and made escalation part of the normal workflow rather than an exceptional failure.

### Visualizing an invisible process

Most activity happens between hooks, Git branches, background processes, and database transactions. The dashboard had to expose enough state to make decisions understandable without overwhelming developers with raw agent traces.

## Accomplishments we're proud of

We built a real-time coordination layer that works across separate computers while preserving each developer's existing coding workflow. It combines local agents, safe Git snapshots, transactional shared state, human review, peer-to-peer repair conversations, and a continuously tested full-stack branch.

### Putting Orkio to the test

We compared two groups building the same Flappy Bird project: agents coordinated through Orkio and agents collaborating through ordinary GitHub workflows across two computers.

| Metric | Orkio | GitHub only |
|---|---:|---:|
| Prompts required | 2 | 9 |
| Conflicts recorded | 0 | 1 |
| Total time | 10 minutes | 16 minutes |
| Tokens used | 406K, including 26K planning | 430K |

In this run, Orkio used approximately **78% fewer prompts**, finished **37.5% faster**, and used approximately **5.6% fewer tokens**. This was one comparison rather than a statistically established performance result, but it provided an encouraging demonstration that shared context can reduce human intervention during parallel agent development.

## What we learned

Making agents individually more capable does not automatically make a team of agents productive. Their work still has to share assumptions, satisfy contracts, and run together.

We learned to give agents targeted context rather than broadcasting every event, to separate failure detection from repair proposals and approval, and to let deterministic checks—not a model—decide whether code is green. We also learned that another centralized fixer is not always the best answer: the agents responsible for the affected components often have the strongest context for negotiating a repair.

## Run it

You need Node 24 or newer, Git, the `spacetime` CLI, and a SpacetimeDB identity that the database owner has granted access. No API keys are committed to the repository.

| Command | What it does |
|---|---|
| `./run.sh` | Joins as an agent: installs packages, fills `.env`, signs in to SpacetimeDB, clones `WORKSPACE_REPO` into `../workspace`, installs hooks and the MCP server, runs the doctor, and opens the workspace in VS Code. |
| `./run.sh --orchestrator` | Performs agent setup and also starts the orchestrator and dashboard. Requires `FACTORY_API_KEY` in `.env`. |
| `./run.sh --screen` | Starts only the dashboard at http://localhost:5173. |
| `./run.sh clean --yes` | Deletes `../workspace`, `.orchestrator/`, and the current agent's WIP branch. Without `--yes`, it only previews the targets. The database owner can add `--db` to clear shared state and all WIP branches. |

Running setup again is safe because completed steps are skipped. On PowerShell without Git Bash, use `npm run join -- <same options>`. The default team database is `agent-cowork-orch`; setup details live in [scripts/join.ts](scripts/join.ts).

Useful verification commands:

```sh
npm run typecheck
npm run test:a
npm run test:orchestrator
npm run test:live
npm run module:generate
```

Part C's reproducible database checks are documented in [module/README.md](module/README.md), access setup in [module/ACCESS.md](module/ACCESS.md), and the editable demo application in [demo-app/README.md](demo-app/README.md).

## Limitations

- Orkio can only catch behavior represented by the project's type checks and tests; a weak test suite can still produce a false sense of safety.
- Each participant needs Git push access to the workspace repository and Reader or Editor access to the team database.
- The current adapters target the tested Claude Code hook and MCP workflow; broader coding-agent compatibility still needs dedicated adapters.
- A single orchestrator instance owns planning and full-stack rebuilds for a team, and it requires its configured provider credentials.
- WIP branches are coordination artifacts rather than durable release history and are replaced as agents publish newer snapshots.
- The benchmark above is a single controlled comparison, not a general performance guarantee.

## What's next

- **Broader agent compatibility:** standardize adapters across different MCP, hook, and coding-agent environments.
- **Proactive negotiation:** let agents agree on shared interfaces before making incompatible changes.
- **Smarter conflict attribution:** improve analysis for failures involving three or more agents.
- **Generated contract tests:** detect semantic inconsistencies that existing type checks and tests miss.
- **Configurable oversight:** let teams choose which repairs can proceed autonomously and which require approval.

Our long-term goal is to make working with a team of AI coding agents as straightforward as working with one.
