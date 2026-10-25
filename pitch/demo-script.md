# Demo script — two minutes

WHAT IT'S FOR: D's narration and stage cues. Keep the actual pacing from rehearsals.
The user confirmed the Agent Cowork name and direct technical tone. No interview quote is assumed.

## Choose the truthful version

Use the **live-loop version** only after the evidence gates in submission-checklist.md
pass. Until then, use the dashboard walkthrough and explicitly identify simulated data.
The preview's Play story button drives local fixtures, not real agents.

## Live-loop version (after verified integration)

D narrates; B's agent is already idle after adding its seconds-based idle feature; A
sends the request; B (or D on the big screen) approves; C is ready for the memory beat.
Keep A's and B's terminals visible. Steps: demo-app/SCENARIO.md (branch `orchestrator`).

| Time | Say | Stage cue |
| ---- | --- | --------- |
| 0:00 | “Four teammates. Four coding agents. Each agent knows its own laptop, but the changes have to work together.” | Show the hive: SpacetimeDB in the middle, the orchestrator and four agents around it, each with what it is doing. Agents never talk directly; everything goes through the shared database. |
| 0:12 | “A's human wants lastLogin in milliseconds. That's a shared contract, so A's agent hands it to the orchestrator.” | A pastes the request; click the Orchestrator node. |
| 0:25 | “The orchestrator is Factory's Droid. It reads the code and the team's live state, including B's work that was never committed. These are its actual steps.” | Point at the steps streaming in. |
| 0:50 | “Its plan: A changes the contract, B adapts sessions, B's human reviews first, and it flags a clash between A's change and B's uncommitted idle feature. Code enforces the review rule; the model can't skip it.” | Show the tasks, the review and the flagged conflict. |
| 1:05 | “B's human approves. Both agents wake up on their own with their tasks.” | Click Approve as B; show both terminals. |
| 1:15 | “Nobody assigns a fixer. A changes the unit and tells B. B pulls A's in-progress change, adapts its own code, and the combined tests pass. Both agree.” | Click the red #12 arc: show the thread as messages arrive. Point at the arrows: A's code goes through GitHub to B, then B's agreement goes through SpacetimeDB to A. |
| 1:35 | “The conflict closes only because both agreed and the combined check is green. The agreed fact is now shared memory.” | Show the green #12 arc, then Memory. |
| 1:45 | “If they couldn't agree, it would go to both humans, right here.” | Point at where the decision box appears (or run the optional beat). |
| 1:52 | “Droid plans. The agents that own the code settle clashes between them. Tests decide green, and people decide what changes their features.” | Finish by 2:00. |

If a beat has not happened, describe what the screen actually shows. The proposed
timestamps are stage targets, not performance measurements. Droid's planning took
52 s in the one real run; rehearse the narration over it.

An interview quote can replace the first sentence once recorded with permission in
interviews.md. Attribute it exactly and keep the opening under fifteen seconds.

## Dashboard walkthrough (available before full integration)

Say at the start: “This is a simulated walkthrough of the interface. The live agent
integration is still being built.” Keep the SIMULATED DEMO banner visible.

1. Select **Agents working**. Show the graph and the Now list; B's review waits in the **Needs you** bar.
2. Select **Conflict detected**. Click the red #12 arc, then **Code and failing output**. Show A's milliseconds edit, B's seconds assumption,
   the failed assertion, and who was suggested to adapt.
3. Select **B is fixing**. Explain how the diagnosis suggests a unit-consistent fix.
4. Select **Verified & green**. Click the green #12 arc for the fixed line and **Memory** for the fact. Show the fixed line, passing check, resolution event,
   and fact in shared memory. Explain that these are example rows.
5. Select **Test-edit guard**. Show the required human review. Do not imply the
   backend guard ran during this walkthrough.
6. Close with the integration work still required and offer the source/architecture.

## Optional one-minute technical extension

“A request becomes a plan in one SpacetimeDB transaction: tasks, reviews and expected
clashes land together, and every agent's hook is woken from that. Droid plans with
read-only access and our own tools; code then applies the contract rule, so a change
to a shared contract always waits for the humans whose code imports it.

There's no central checker. Each agent merges its uncommitted work with each
teammate's snapshot and runs the type checker and the tests itself. Two agents
resolve a clash by agreeing in a thread, and the database only accepts that when a
current green check covers both of them. Twelve messages without agreement, or five
minutes, and it goes to both humans.

A passing typecheck can't prove that seconds and milliseconds mean the same thing.
That needs a behavioral test, and the agreed fact helps the next agent get it right.”

Describe each architecture claim as planned if its evidence gate remains open.

## Recovery

If a live run stalls, briefly name the issue and play a previously verified local
recording. If no such recording exists, switch to the labeled simulated walkthrough.
Never represent a fixture, typed correction, or prerecorded result as a live agent run.
