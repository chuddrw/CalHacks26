# Demo script (2 minutes)

> This file has the words we say and the keys we press when judges come to the table, plus the checklist before they arrive and the fallback if the live demo breaks. The technical steps behind each beat are in [../demo-app/SCENARIO.md](../demo-app/SCENARIO.md). D owns this file.

D narrates and stands by the big screen. A and B sit at their laptops. C is ready for beat 4.

## Before judges arrive

- [ ] Reset done (SCENARIO.md, "Reset"). Every card online, none red.
- [ ] Beat 2 already done: B's idle feature is written, green, and B's agent is idle.
- [ ] A's prompt pasted into A's terminal, **not sent**.
- [ ] Laptop C: a fresh Claude session, prompt ready.
- [ ] Big screen on `http://localhost:5173/?big`. Watcher terminal visible but small.
- [ ] Backup video open in a player, paused at 0:00, stored on the laptop (no Wi-Fi needed).
- [ ] Chargers plugged in. Notifications off on every screen.

## The script

| Time | Who | Say | Do |
|---|---|---|---|
| 0:00 | A | | Press Enter on A's prompt as D starts talking. A's agent needs about 40 s. |
| 0:00 | D | "*[the quote from another Cal Hacks team, pitch/interviews.md]*. Every team here has four people, each with an AI agent writing code on its own laptop. Each agent only sees its own laptop." | |
| 0:15 | D | "This is Agent Cowork. These are our four agents, live. B's agent just added an idle-time feature, and it's green." | Point at the cards. |
| 0:25 | D | "Meanwhile A's agent is switching `lastLogin` to milliseconds, because the frontend needs it. It updates every caller it can see. Git would merge this cleanly, and the types still match." | Point at A's card and intent. |
| 0:45 | D | "And there it is: red. A's change times B's change, and neither one has committed anything. Droid is investigating; you can watch every step it takes." | Point at the conflict panel, then the Droid panel. |
| 1:00 | D | "B's agent was idle. It just woke up on its own, pulled A's work in progress, and is fixing its own file." | Point at laptop B. |
| 1:15 | D | "Green. And it's now a verified fact in shared memory: `lastLogin` is milliseconds." | Point at the memory panel. |
| 1:20 | A, C | | A commits and pushes. C runs `git pull`, then sends C's prompt. |
| 1:25 | D | "A merges. C starts a task that touches `lastLogin`. Its session opens with that fact, so it writes milliseconds the first time. No conflict." | Point at laptop C. |
| 1:45 | D | "Git stores the code. SpacetimeDB holds the team's live state. Tests decide red or green; Droid explains. And where Claude can go wrong, for example weakening a test to get a green check, we send it to a human." | |
| 2:00 | D | "Want to try it? Tell B's agent to delete that test." | Hand the judge the keyboard if they want. |

The timings are targets. Replace them with what you measure in rehearsals (SCENARIO.md, rehearsal log). If beat 3 runs long, keep talking over the timeline panel; don't skip the wake-up moment.

## Fallback

If the screen doesn't turn red within 20 s, or anything crashes:

> "Live demos at hackathons... here's the run we recorded an hour ago."

Play the backup video from the conflict onwards. Never fake agent output or type the fix yourself.

## The one-liner (for the end, and for Devpost)

**Live CI for a team's AI agents: it checks everyone's uncommitted work together and wakes up the agent that has to fix a break, before anyone commits.**
