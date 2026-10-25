# Judge Q&A

WHAT IT'S FOR: D's concise answers, plus evidence limits. Use the current status in
submission-checklist.md; architecture intent is not proof of a working live loop.

## Opening answer

**What is Agent Cowork?** A team of coding agents that coordinates like a team. Each
human asks their own agent; an orchestrator built on Factory's Droid plans the request
and assigns each part to the agent that owns that feature; the agents settle clashes
with each other, and a fact they agree on (with a green check) becomes shared memory.
People review major changes to their own features and break deadlocks. Confirm the
live-loop evidence before saying the full loop is running.

## Differentiation

**Why isn't Git enough?** A clean merge proves the text can be combined, not that the
behavior is compatible. Seconds and milliseconds can both be numbers; detecting the
mismatch requires a meaningful check. Our scenario tests the combined in-progress work.

**How does this relate to CI?** It uses the same foundation—Git, a type checker, and tests—
but the intended input is the combination of teammates' uncommitted snapshots. It adds
fixer assignment and context delivery while agents are still working. It does not
replace a team's normal pull requests, reviews, or release checks.

**Is this just shared memory?** Intentions and facts supply context. Each agent also runs
the combined code (its work merged with each teammate's). A note saying the changes should
work is not a passing test, and a conflict only closes on a green check.

**Isn't the orchestrator just a chatbot?** It never writes code or declares anything
green. It reads the repository and the team's live state, then calls our tools to assign
tasks, request reviews and flag clashes. Code applies the contract rule afterwards, and
the plan lands in one database transaction. Its steps are visible on the dashboard.

**What if two agents disagree?** Either can escalate, and twelve messages without
agreement or five minutes also escalate. Both humans see the thread on the dashboard and
send one decision, which wakes both agents.

## Correctness and limitations

**Who decides red or green?** Git, the type checker, and tests. The model explains a
failure and suggests a fix; its confidence does not override the check result.

**What if there are no tests?** The type checker can catch changed types or signatures.
It cannot establish every behavioral contract. A seconds/milliseconds mismatch needs
a relevant test. The tool cannot promise compatibility for behavior nobody checks.

**What if the agent changes a test to get green?** The planned guard flags modifications,
deletions, and renames of existing test files during a fix for human review. Adding a
new test is allowed. Show an actual guard run only after B's implementation is verified;
the local UI includes a labeled simulation of that state.

**Who changes their code when A changed the timestamp unit?** The two agents decide.
The conflict carries a suggestion (Droid's, or for a failing check the author of the
changed line containing the failure), but the agents agree in their thread who changes
what. It isn't a claim that one teammate is to blame.

**Can a stale dashboard look green?** No: connection readiness is separate from check
status. Disconnected data is marked stale, and a new snapshot after a passing check
returns the overall signal to waiting. These states have automated coverage.

**Does a resolved conflict mean the diagnosis is correct?** A passing check validates
only the tested combination and assertions. The shared fact is associated with that
recovery; broader semantic correctness still depends on test coverage and review.

**Does it scale?** For n agents, all pairs number n(n−1)/2: four agents means six pairs.
Each agent only checks its own pairs, caches checked combinations, and the plan flags most
clashes before any test runs.
Actual throughput has not been measured. Three-way-only interactions need a better
localization strategy than this project's planned fallback.

**What if an agent stays idle or offline?** A background hook wakes an idle agent for a
task or a message within a second or two. An unresolved conflict goes to both humans
after five minutes. Confirm the timer on the deployed module before demonstrating it.

**What happens when the teammate commits?** The fixer must reconcile the snapshot with
main through the agreed Git workflow. Use the team's tested demo procedure and inspect
local changes before applying or stashing anything; the dashboard does not merge code.

## Technology choices

**Why SpacetimeDB?** The design puts shared team state and assignment transactions in
one module, with clients subscribing to updates. C still needs to provide the published
module and generated bindings for this branch's real integration check.

**Why Droid?** Its intended role is investigation in a disposable worktree: inspect the
changes, run a failing check, and explain the mismatch. Its steps appear in the diagnosis
feed. Claude is the planned fallback. Demonstrate actual SDK activity when available.

**Why hooks and MCP?** Hooks connect edits and session events to coordination. MCP tools
carry intent, retrieve status, and bring a teammate's snapshot to the fixer. Those
services belong to A; the UI alone cannot wake an agent or apply a patch.

**What about security?** The scaffold's planned module does not include production
identity checks. The dashboard calls no reducers and never exposes server tokens.
Production use needs authorization, controlled reads/writes, retention, and isolation
appropriate to the repositories involved. No production-security claim is made.

## Evidence questions

**What is real in this preview?** The interface, state derivation, excerpts, filtering,
connection lifecycle implementation, and local simulation are real code. The sample
agents and diagnosis messages in ?demo are fixtures. Live database and agent behavior
have separate evidence gates.

**How fast is it?** No end-to-end latency measurement is available yet. After rehearsals,
report the actual time to red, wake, and green from demo-runbook.md, with the revision
and number of successful runs. Never present stage-script timings as benchmarks.

**What isn't built yet?** Read the current evidence table. Expected remaining items
include A/B/C integration, real rehearsals, an end-to-end recording, and real interview
notes. Optional contract approval, function-level dependency analysis, broader agent
support, and production authorization remain beyond D's dashboard implementation.
