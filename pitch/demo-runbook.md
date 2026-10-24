# Demo runbook

WHAT IT'S FOR: D's repeatable checklist for screenshots, rehearsals, recording,
and the table presentation. Record real results here before using them in the pitch.

## Prerequisites from the team

- A: working hooks, MCP registration, teammate pull, and confirmed idle wake behavior.
- B: a running watcher, combined checks, conflict localization, and test-edit guard.
- C: published database, generated bindings, diagnosis, and the separate demo repository.
- Everyone: correct local configuration, git access, and an agreed demo baseline.
- D: dashboard connected to the same database, presentation assets, and backup playback.
- C's protected views: approve D's own reader identity and configure browser sign-in;
  never copy the owner's token into the dashboard or shared environment files.

Local sample data is for dashboard development. Label it as simulated; use real
agents and checks for the final recording and any claims about end-to-end behavior.

## Rehearsal

1. Ask C to reset the demo using the agreed procedure. Confirm nobody has unsaved work.
2. Confirm the dashboard connection, all expected agents, and a real passing baseline check.
3. Have B add the feature that assumes seconds, then let B's agent become idle.
4. Start the timer when A changes the timestamp unit to milliseconds.
5. Record the time until the combined check fails and the conflict appears.
6. Confirm the named fixer is B. Observe diagnosis and whether the idle agent wakes.
7. Confirm B pulls A's snapshot, changes its own implementation, and passes unchanged tests.
8. Record the time until the combined check passes and the conflict resolves.
9. Confirm a verified fact appears. Start C's fresh session and observe fact delivery.
10. Check a proposed test modification separately: it should require human review.
11. Save logs and recording references. Record failures as failures; investigate before repeating.

## Measurement log

Times are elapsed seconds from A's triggering edit. Fill entries from actual runs.

| Run | Revision | To red | To wake | To green | Diagnosis duration | Passed? | Evidence / issue |
| --- | -------- | ------ | ------- | -------- | ------------------ | ------- | ---------------- |
| 1   |          |        |         |          |                    |         |                  |
| 2   |          |        |         |          |                    |         |                  |
| 3   |          |        |         |          |                    |         |                  |
| 4   |          |        |         |          |                    |         |                  |
| 5   |          |        |         |          |                    |         |                  |

## Capture list

- Dashboard with online agents and a real passing check.
- Open conflict showing both locations, the fixer, and failure output.
- Diagnosis showing an actual tool call and its result.
- Resolved conflict and verified fact in shared memory.
- Human-review state after the test-edit guard triggers.

Use the same visual style and legible text size across captures. Confirm the
user's chosen visual direction before preparing final screenshot compositions.
Keep API keys, terminals containing credentials, and private notifications out of frame.

## Backup recording

1. Rehearse once with the final prompts and exact baseline.
2. Record dashboard and agent behavior together, so the wake-and-fix claim is visible.
3. Narrate using demo-script.md, adjusting timing to observed behavior.
4. Watch the exported file from start to finish. Check readable text and audible narration.
5. Keep the file on the presentation laptop and verify playback without network access.
6. Record the actual video link and local file location in the submission checklist.

## Table and submission

- Confirm current event deadlines and table instructions with the organizers.
- Bring monitor, compatible cable, power strip, chargers, and mouse.
- Rehearse on the venue network. Have the local video ready before judging.
- Open the dashboard on all three presentation screens and confirm a real row
  change appears on each. Record the devices, build revision, and result below.
- Confirm team names, table number, public repository URLs, and video URL.
- Review Devpost text against what the finished product actually does.
- Ask the user to authorize publication/submission of the final reviewed materials.
- Verify the saved submission and accessible links after submission.

### Presentation hardware evidence

Not verified yet. Complete this on the actual devices; a local browser test does
not establish venue readiness.

| Screen / device | Build revision | Same live update received? | Offline backup plays? | Network / issue |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

## If the live loop fails

Say what happened briefly and play the verified recording. If only simulated UI
data is available, identify it as a dashboard demonstration and describe which
integration steps remain unfinished.
