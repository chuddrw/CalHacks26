# Simple dashboard: checklist

WHAT IT'S FOR: track the dashboard simplification on branch `feat/simple-ui` (from `feat/orchestrator`).

Goal (from A, 2026-10-24): the dashboard is an agent tool, not a showcase. Drop the office picture and the fancy layout. Show two things: the graph (who is connected to whom / what) and what each agent is working on right now.

## Phase 1: understand
- [x] Branch `feat/simple-ui` created from `feat/orchestrator`
- [x] Run the current UI in demo mode and look at every scene
- [x] List what data the dashboard actually has (tables in `ui/src/dashboard.ts`, `ui/src/live.ts`, `ui/src/demo.ts`)
- [x] Write down my opinion of the current UI

What I found:
- The landing view is a 2 MB photo of an office table (`ui/public/office/shared-desk.png`) with frosted-glass laptops for the agents. It's pretty, but it reads as marketing, not a tool. The text on the glass is low contrast, and C and D show nothing but "Check passed".
- What each agent is doing (`agent.intent`, `task.title`) is hidden behind a click.
- The orchestrator flow is the new part of the product (request → plan → reviews → tasks → threads → full stack), and it's buried in a side drawer.
- There's no real graph. The seating hints at the team, but nothing shows who is assigned what, who reviews whom, or which pair is in a conflict thread.
- About 5,300 lines of CSS (`styles.css`, `office.css`, `overview.css`, `office-inspectors.css`, `orchestrator.css`).
- Data available: agent (online, status, intent, files), request, plan_step, task, review, conflict, message (threads), check_run, build (full stack), intent (shared memory), snapshot, diagnosis_step.
- Human actions that must keep working: approve / send back a review (`decideReview`), decide an escalated conflict (`decideConflict`), accept / send back a test change (`reviewTestChange`).

## Phase 2: agree with A
- [x] Ask A the open questions (what the graph shows, what stays, what goes, style)
- [x] Record the answers here

A's answers (2026-10-24):
- **Graph = who works with whom.** Nodes: orchestrator + agents. Live edges: orchestrator → agent = assigned task (labeled with its title); agent → agent dashed = review; agent ↔ agent red = conflict thread, green once both agree.
- **Layout = graph + "Now" list.** Graph on the left. One row per agent on the right: status, current task, files, last activity. A "Needs you" bar at the top only when a human must act. Clicking anything opens its details. Activity strip at the bottom.
- **Style = plain dark tool.** Neutral dark background, one accent, colors only for meaning (green / red / amber), monospace for files. No photo, no glass.
- **D's UI = rewrite all of it.** New main screen and new detail panels. Delete the old components, CSS and the office photo. Keep the data layer (`dashboard.ts`, `live.ts`, `demo.ts`, `stdb.ts`, `store.ts`, `session.ts`, `diff.ts`, `time.ts`, `useNow.ts`) and its tests.

## Phase 3: build
- [x] `src/team.ts`: pure derivations. `teamGraph()` (nodes + edges), `agentNow()` (what each agent is doing), `needsYou()` (pending human actions), `activity()` (timeline including orchestrator events)
- [x] `tests/team.test.ts`: graph, now and needs-you for every demo scene (10 tests)
- [x] `Graph.tsx`: HTML nodes over an SVG edge layer. Orchestrator on top, agents in a row. Task lines down; review and conflict arcs below the row, each with a short label
- [x] `NowList.tsx`: one row per agent
- [x] `NeedsYou.tsx`: bar shown only when a human must act
- [x] `Activity.tsx`: compact recent-events strip
- [x] `Details.tsx`: right drawer for agent / request / conflict / checks / memory / activity / connection; Esc closes and focus goes back
- [x] `Actions.tsx`: approve / send back review, decide escalation, accept / send back test change (same calls as before)
- [x] `DemoBar.tsx`: scene picker, Play story, Live mode link
- [x] `App.tsx` + `app.css`: header (project, Live / Simulated, team health, memory, big screen)
- [x] Delete the old components, the five CSS files and `public/office/`
- [x] Update `ui/README.md`, `structure.md` and the stage cues in `pitch/demo-script.md`

Found with live data and fixed: a task assigned to an offline agent was drawn as "working". It now shows as a dashed "#1 waiting · D offline" line. Long agent names (`c-codex`) now fit in the Now list.

## Phase 4: verify
- [x] `npm run typecheck -w ui`: clean
- [x] `npm test -w ui`: 30 / 30 (20 existing + 10 new)
- [x] `npm run build -w ui`: passes; CSS is 10.6 kB, down from about 5,300 lines across five files
- [x] Browser, `?demo`: every scene; Approve as B (bar clears, tasks start); escalation decision (conflict reopens with the decision in the thread); Accept test change; big screen; a 760 px window; Esc closes and focus returns
- [x] Browser, live mode against the team database (read only): 3 agents, request #1, task lines render
- [x] No leftover files (Playwright output deleted, dev server stopped)
- [x] Commit on `feat/simple-ui` (not pushed, not merged)

## Left for the team
- D: the old screenshots in `artifacts/work-d/` and the list in `pitch/submission-checklist.md` show the office UI. Retake them from `?demo` before submitting.
- `?demo` "Accept test change" resolves the conflict, but the health chip stays "Combined check failed" because the simulator adds no green check. That was already the case before this change.
