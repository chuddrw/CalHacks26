# Simple dashboard: checklist

WHAT IT'S FOR: track the dashboard simplification on branch `feat/simple-ui` (from `feat/orchestrator`).

Goal (from A, 2026-10-24): the dashboard is a tool for working with agents. Drop the office picture and the fancy layout, and show two things: the graph (who is connected to whom / what) and what each agent is working on right now.

## Phase 1: understand
- [x] Branch `feat/simple-ui` created from `feat/orchestrator`
- [x] Run the current UI in demo mode and look at every scene
- [x] List what data the dashboard actually has (tables in `ui/src/dashboard.ts`, `ui/src/live.ts`, `ui/src/demo.ts`)
- [x] Write down my opinion of the current UI

What I found:
- The landing view is a 2 MB photo of an office table (`ui/public/office/shared-desk.png`) with frosted-glass laptops for the agents. It's pretty, but it looks like a marketing page. The text on the glass is low contrast, and C and D show nothing but "Check passed".
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

## Round 2: data moving between them (A, 2026-10-24)

A asked to see every data transfer as an arrow from one to another that appears for a few seconds, and for task lines to say what the agent is doing instead of "working".

A's answers: arrows go straight from sender to receiver, tagged "via DB" / "via git"; draw all four kinds (orchestrator ↔ agents, agent conversations, code and plans, results); record pull_teammate with send_note; arrows only for live data (no replay).

- [x] Task lines: "doing: <task>", "waits for review: <task>", "waiting, D offline: <task>", "done: <task>"
- [x] `src/transfers.ts`: one Transfer per row that means "X sent Y something", with a stable key
- [x] People node (the people at the dashboard), so reviews, escalations and decisions have a sender / receiver
- [x] `useFlights.ts`: the first full picture is the baseline; afterwards a key that wasn't in the previous update gets an arrow for 4 s, 1.2 s apart, only the newest labeled
- [x] pull_teammate leaves a record: `pulledNote()` / `pullerOf()` in `shared/src/schema.ts`; the MCP server sends it with the existing `send_note` reducer (no module change or redeploy); a failed note doesn't fail the pull
- [x] Demo: B's pull appears in "B is fixing"
- [x] Tests: `tests/transfers.test.ts` (7, every story step), UI 37 / 37; `npm run test:a` passes with a new check "a hears that b pulled its change"
- [x] Browser: the whole story plays as arrows in order; arrows between two agents dip below the row, away from the task labels; live mode loads without a burst. A real live transfer wasn't triggered (that would write to the team database); it uses the same path as the demo's scene changes.

## Round 3: the hive (A, 2026-10-24)

A: "Shouldn't we draw the DB? It's the hive of the agent mind." Agents never talk directly: each writes to SpacetimeDB and the others get it through their subscription. Drawing A → B directly hid that.

A's answers: radial hive (SpacetimeDB in the middle, orchestrator, people and agents in a ring); GitHub as a smaller second hub for code; the DB hub shows the table just written, shared memory, rows per table and how many agents are connected.

- [x] `transfers.ts`: each transfer names the table (or git branch) it writes
- [x] `team.ts`: `hiveStats()` for the hubs (connected agents, rows per table, latest fact, wip branches, full stack)
- [x] `Graph.tsx`: ring layout around the two hubs; faint spokes from every node to the DB; task / review / conflict arcs curve inside the ring, around the hubs
- [x] Arrows in two hops: sender → hub (write), the hub pulses and shows "+ <table>", hub → each receiver (subscription push)
- [x] Tests, typecheck, build; browser check of the whole story, narrow window, big screen, live mode

Fixed along the way:
- The pull arrow now runs A → GitHub → B: the code moves from A's wip branch to B. The note itself goes to A.
- Curves aim their middle between the hubs and the ring, so a node sitting at the halfway angle doesn't pull them into it.
- Labels (on edges and on arrows) try several spots along their curve and take the one that covers the least.
- Hops to and from GitHub go around the database hub when it is in the way (orchestrator ↔ GitHub).
- Big screen with the Needs you bar used to clip the bottom of the ring: the graph row now has a minimum height and the page scrolls; node and hub sizes scale with the font; the two hubs share the space between the top and bottom nodes.

Known limit: in big-screen mode with the Needs you bar, one task label may find no free spot and sit partly behind its agent's node. The node shows the same text.

Checked: UI tests 38 / 38, typecheck, build. In the browser: the whole story plays 14 transfers through the right hubs (review, message, conflict, memory and task into SpacetimeDB; wip/a, wip/b and cowork/full-stack into GitHub). Also checked an 800 px window, big screen, and live mode against the team database (read only, no burst on load).

