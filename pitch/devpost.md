# Devpost draft

WHAT IT'S FOR: D's submission copy. The user confirmed Agent Cowork and a direct technical tone.
This is an internal draft; do not submit until submission-checklist.md is complete.
As of this branch, the dashboard is verified with simulated data. The live pipeline
still depends on A/B/C. Update tense only when the corresponding evidence exists.

## Project name

Agent Cowork

## Tagline

Live CI for a team's AI agents.

## Inspiration

Four teammates can each have an AI agent producing code quickly, while still having
no shared view of the changes being made on other laptops. An edit can be locally
correct and incompatible with a teammate's new work. Clean Git merges and matching
TypeScript types do not catch every mismatch in behavior.

We wanted the team to see those interactions while work is still in progress—and
give the agent responsible for a fix enough context to test it.

If a real interview quote is added, use only the exact words and attribution approved
in interviews.md. The scenario above is motivation, not a claimed research finding.

## What it does

Agent Cowork is designed to check a team's uncommitted work together, identify
incompatible changes, assign a fixer, and share the resulting knowledge with later
agents. Its dashboard organizes the workflow around connected agents, a combined
check, a conflict workspace, live investigation, and shared memory.

The verified dashboard supports both sides of a conflict as diff excerpts, assigned
fixers, diagnosis sources and steps, human-review states, verified facts, and an
activity timeline. It includes responsive and big-screen views. A clearly labeled
local simulator demonstrates the intended failure-to-recovery story without a backend.

## How we built it

The interface uses TypeScript, React, and Vite. Its table contracts come from the
shared schema. A read-only SpacetimeDB adapter waits for subscription synchronization,
validates incoming rows, reconnects after interruptions, and labels stale data.
The adapter's lifecycle is tested with an injected transport; connection to a real
published module is a separate integration gate.

The planned complete workflow uses Claude Code hooks to push working-tree snapshots,
a Git/TypeScript/test watcher to detect failures, SpacetimeDB to coordinate state,
and Factory Droid to investigate with a Claude API fallback. Describe these as
implemented only after a real rehearsal verifies them.

## Challenges

The interface needs to distinguish “no conflicts” from “no evidence.” A missing
connection or a new snapshot after a passing check must not look healthy. We made
connection readiness and check freshness explicit and tested those transitions.

Cross-agent debugging also requires the fixer to see the teammate's actual change.
The team's planned pull_teammate tool addresses that dependency; the dashboard shows
both changes and the assigned fixer so the coordination is visible.

## Accomplishments

The dashboard has a complete local story from independent agent activity through
conflict, diagnosis, and verified memory. Automated checks cover status truthfulness,
schema conversion, diff excerpts, event ordering, reconnects, and cleanup. Browser
checks exercise representative scenes, responsive layouts, and controls.

Add end-to-end success counts and timing figures only from demo-runbook.md after
actual measured rehearsals. No speedup or reliability claim is available yet.

## What we learned

Coordination needs shared evidence: intentions explain what an agent plans, tests
show whether changes work together, and a verified fact preserves what the team learned.
The interface needs to make the source and status of each of those signals clear.

## What's next

Complete live integration, measure real team usage, add identity-based authorization,
and explore contract approvals and dependency-aware warnings. Semantic mismatches
in untested behavior and conflicts requiring three or more changes remain limitations.

## Built with

Verified dashboard: TypeScript, React, Vite.
Live adapter dependency: SpacetimeDB.
Full-project stack to confirm before submission: Claude Code, Anthropic, Factory Droid,
Node.js, Git, Vitest, madge, and the published SpacetimeDB module.

## Links and assets

- Tool repository: https://github.com/chuddrw/CalHacks26
- Demo repository: awaiting the team URL.
- Video: awaiting an actual recorded and reviewed run.
- Dashboard screenshots: artifacts/work-d/ (simulated data; refresh after design approval).
- Team/table/submission details: submission-checklist.md.
