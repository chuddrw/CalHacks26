# Q&A prep

> This file holds the questions judges are likely to ask, with short answers we all give the same way, plus the "not built" slide. Every number here must be one we measured. Fill in the blanks after rehearsals. D owns this file; everyone reads it before judging.

## How is it different?

**From git or GitHub?** Git only checks at merge time, and only catches two people editing the same lines. Our demo conflict is in two different files, and git merges it cleanly. We check everyone's uncommitted work together, live, before anyone commits.

**From CI or a merge queue?** CI checks one branch after it's pushed. A merge queue checks committed pull requests one at a time. We check the combination of everyone's in-progress work, and we wake the agent that has to fix it.

**From Claude Code subagents or agent teams?** Those have one person directing agents on one machine. We connect different people's agents on different laptops.

**From shared-memory tools like MCP Agent Mail?** They share notes and reservations, but nobody runs the combined code. Memory helps prevent a conflict; we verify, by running it.

## Will it hold up?

**Isn't it slow or expensive?** Detection is git + tsc + the tests: seconds, with no AI tokens. AI only runs when something is red. Measured: a full check takes ___ s, red to wake-up takes ___ s, Droid's diagnosis takes ___ s.

**What if the repo has no tests?** The type checker still catches the most common breaks: a changed signature or a renamed field. A change of meaning, like seconds to milliseconds, needs a test, and we say so plainly. The next step is a Claude check that compares each agent's stated intent with the others' diffs and marks matches as "suspected", never red.

**Does it scale past four agents?** Pairs grow with the square of the team: 4 agents is 6 pairs, 10 agents is 45. We only test pairs when the full check is red, results are cached per commit, and checks run in parallel. For bigger teams, the import graph narrows the pairs to agents whose files depend on each other.

**What if an agent cheats and edits the test?** Any fix that edits or deletes an existing test goes to a person ("needs a human") and doesn't count as fixed. Try it: tell B's agent to delete the test.

**What if an agent is offline or never fixes it?** After 5 minutes the conflict escalates to the humans on the dashboard.

**What happens when the teammate commits?** `git stash -u && git pull && git stash pop` folds the pulled lines back in cleanly. We tested it.

## Why these technologies?

**Why SpacetimeDB?** It holds the whole team's live state with no other backend. The fixer is assigned in one transaction, so two agents never both start fixing the same thing. A schedule table handles escalation, lifecycle reducers handle who's online, and every screen subscribes directly.

**Why Droid?** Diagnosis is open-ended investigation: run the failing test, read both changes, compare. Droid does that in a throwaway worktree with its edit tools turned off, and every step shows on screen.

**Why Claude Code hooks?** They let us add teamwork without changing how anyone works: snapshot after each edit, wake an idle agent, block a fixer from quitting with an open conflict, and brief every new session.

## Honesty

**What's real and what's scripted?** The prompts are scripted, so the demo is repeatable. Everything after that is real agents, real git and real tests. We never fake agent output.

**What did you measure?** Rehearsals passed ___ of ___. Time to red ___ s, time to green ___ s. We don't claim speedups we haven't measured.

## The "not built" slide

- Security: in the demo, any client that knows the database name can call reducers. A real version checks identities.
- Semantic breaks in repos without tests (stretch: "suspected" conflicts).
- Function-level dependencies (we track imports between files).
- Conflicts that need 3 or more changes together are reported as the two most recent pushers.
- Agents from other vendors.
- Our own version control, review UI or auto-merge. On purpose: git stays git.
