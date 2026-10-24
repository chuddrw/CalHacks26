# Demo script — two minutes

WHAT IT'S FOR: D's narration and stage cues. Keep the actual pacing from rehearsals.
The user confirmed the Agent Cowork name and direct technical tone. No interview quote is assumed.

## Choose the truthful version

Use the **live-loop version** only after the evidence gates in submission-checklist.md
pass. Until then, use the dashboard walkthrough and explicitly identify simulated data.
The preview's Play story button drives local fixtures, not real agents.

## Live-loop version (after verified integration)

D narrates; A triggers the timestamp change; B's agent is already idle after adding
its seconds-based feature; C is ready for the memory beat. Keep B's terminal visible.

| Time | Say                                                                                                                                                                                            | Stage cue                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0:00 | “Four teammates. Four coding agents. Each agent knows its own laptop, but the changes have to work together.”                                                                                  | A sends the timestamp-change prompt.                                |
| 0:12 | “Agent Cowork gives the team a shared picture before anyone commits. Here are the agents, their plans, and the files they're changing.”                                                        | Open an agent symbol to reveal intent/files, then close.                          |
| 0:25 | “B added an idle-time feature that assumes seconds, then went idle. A is changing login timestamps to milliseconds and updating the callers it can see.”                                       | Inspect A and B in turn, then return to the map.                                        |
| 0:40 | “The edits are in different files. Git can merge them, and the types still match. But the combined test fails.”                                                                                | Open the red hub, then Changes & diagnosis to show both excerpts.              |
| 0:52 | “The watcher found the conflicting pair and assigned B to fix it. Droid investigates the failed combination; these are its actual steps.”                                                      | Show the real diagnosis feed and result.                            |
| 1:05 | “B's agent has woken up. It pulls A's in-progress change so it can test both together, then adjusts its own code.”                                                                             | Show B's terminal. Never infer waking from the dashboard alone.     |
| 1:22 | “The combined check passes. The verified contract now lives in shared memory: lastLogin is milliseconds.”                                                                                      | Return to the green hub, then open Memory to show the fact.                       |
| 1:35 | “A commits the change. C pulls it and starts a fresh task. That new agent receives the fact before writing code.”                                                                              | Perform the actual commit/pull/session step in the agreed scenario. |
| 1:49 | “Git stores the code. SpacetimeDB holds the team's live state. Tests decide whether the changes work; AI explains the failure. If a proposed fix changes existing tests, a person reviews it.” | Show the actual guard result if time permits; finish by 2:00.       |

If a beat has not happened, describe what the screen actually shows. The proposed
timestamps are stage targets, not performance measurements.

An interview quote can replace the first sentence once recorded with permission in
interviews.md. Attribute it exactly and keep the opening under fifteen seconds.

## Dashboard walkthrough (available before full integration)

Say at the start: “This is a simulated walkthrough of the interface. The live agent
integration is still being built.” Keep the SIMULATED DEMO banner visible.

1. Select **Agents working**. Show the agent symbols; open an agent for its intent and files.
2. Select **Conflict detected**. Open the red hub, then **Changes & diagnosis**. Show A's milliseconds edit, B's seconds assumption,
   the failed assertion, and the assigned fixer.
3. Select **B is fixing**. Explain how the diagnosis suggests a unit-consistent fix.
4. Select **Verified & green**. Open the hub for the fixed line and **Memory** for the fact. Show the fixed line, passing check, resolution event,
   and fact in shared memory. Explain that these are example rows.
5. Select **Test-edit guard**. Show the required human review. Do not imply the
   backend guard ran during this walkthrough.
6. Close with the integration work still required and offer the source/architecture.

## Optional one-minute technical extension

“Every agent's working tree becomes a disposable Git snapshot. The watcher checks
all snapshots together. If the combination fails, singles and pairs help identify
where the failure comes from. Fixer assignment is deterministic; the model's role
is to explain the error and suggest a change.

The shared state belongs in SpacetimeDB so the watcher, agent hooks, and screens
observe the same conflict and assignment. An explicit recipient owns the fix;
other agents receive context rather than competing to fix the same thing.

A passing typecheck can't prove that seconds and milliseconds mean the same thing.
That needs a behavioral test. The interface makes failures and human-review states
visible, while shared facts help a later agent avoid repeating the assumption.”

Describe each architecture claim as planned if its evidence gate remains open.

## Recovery

If a live run stalls, briefly name the issue and play a previously verified local
recording. If no such recording exists, switch to the labeled simulated walkthrough.
Never represent a fixture, typed correction, or prerecorded result as a live agent run.
