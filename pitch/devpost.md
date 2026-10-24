# Devpost text

> **What this file is for:** the text for our Devpost page, ready to paste into each field. D fills the blanks; submit a draft on Saturday night and the final version by Sunday 8:30 AM. What Devpost requires is listed in [../external/devpost.txt](../external/devpost.txt).

## Name and tagline

**Agent Cowork**: live CI for a team's AI agents.

## Inspiration

TODO: the quote from pitch/interviews.md, then two sentences. Four people, four AI agents, four laptops: each agent only sees its own machine. Changes that each work alone break when they meet, and teams find out at integration time.

## What it does

Agent Cowork checks everyone's uncommitted work together, live. After every edit, a Claude Code hook snapshots the agent's working tree to a throwaway branch. A watcher merges all the snapshots onto main and runs the type checker and the tests. When the combination fails, it tests each change alone and in pairs to find the two that clash, picks who should fix it, and wakes that agent, even if it's idle. Droid explains the failure on screen, the agent pulls its teammate's in-progress change and fixes its own code, and the verified fact goes into shared memory so the next agent gets it right the first time.

## How we built it

- **Claude Code hooks**: snapshot and push after each edit; a background listener (`asyncRewake`) that wakes an idle agent; a Stop hook that keeps the fixer on task; SessionStart and context hooks that deliver team memory.
- **SpacetimeDB**: every piece of team state, with no other backend. Fixer assignment happens in one transaction; a schedule table escalates stuck conflicts; lifecycle reducers track presence; every screen subscribes live.
- **Factory Droid SDK**: diagnoses each conflict in a disposable worktree with editing disabled, streaming its steps to the dashboard.
- **Claude API**: fallback diagnosis with structured output.
- **git, TypeScript, Vitest, React, Vite, madge.**

## Challenges we ran into

TODO (fill in honestly on Sunday). One we already hit: the fixer's laptop doesn't have its teammate's uncommitted change, so "fix it" was impossible to test locally. We added `pull_teammate`, which applies the teammate's snapshot into the fixer's working tree.

## Accomplishments we're proud of

TODO: measured numbers from rehearsals (time to red, time to green, rehearsals passed).

## What we learned

TODO.

## What's next

"Suspected" conflicts for repos without tests, function-level dependencies, identity checks on every reducer, and support for other coding agents.

## Built with

claude-code, claude, anthropic, spacetimedb, factory, droid, typescript, react, vite, vitest, git, node.js, madge

## Links

- Repo 1 (the tool): TODO
- Repo 2 (demo app): TODO
- Video: TODO (also stored on the laptop, per Devpost rules)
