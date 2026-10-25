# Work D: dashboard handoff

Use this to run, verify, and integrate D's dashboard without waiting on the rest of the team.

## Run locally

From the repository root:

```sh
npm ci
npm run ui -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/?demo`. The preview hot-reloads when UI files change.
The simulator runs entirely in the browser and performs no database writes.
Use the scene selector or **Play story** to inspect working → conflict → fixing →
resolved. Escalation and test-review scenes are available separately.

One screen in warm charcoal, after Claude's dark mode with Apple-like restraint: soft surfaces and shadows instead of outlines, no colored edges, Claude's clay only for the brand, primary buttons, selection and the database hub. Color appears only in small dots and text: parchment for work in progress, green passing, red conflict, amber waiting on a person. On the left is the team graph, drawn as a hive. SpacetimeDB sits in
the middle, because no agent talks to another directly: each writes to the shared database and the
others get it through their subscription. The hub shows how many agents are connected, the rows per
table and the latest verified fact. GitHub is the smaller hub below it, where the code itself
moves (`wip/<agent>` branches, the full stack). Around them in a ring: the orchestrator, the
agents, and a People node for the people at the dashboard. Faint spokes connect each of them
to the database.

Lasting relationships curve inside the ring. Tasks run from the orchestrator to an agent, labeled
with what it is doing ("doing: Store User.lastLogin in milliseconds"). Reviews are dashed amber
arcs from the reviewer to the requester. Conflict threads are red while the two agents talk and
green once both agree and the check passes. Labels take the first spot along their curve that
doesn't cover a node, a hub or another label.

Every piece of data that moves flashes for 4 seconds in two hops. First the sender writes to its
hub, which pulses and shows what was written ("+ message", "+ wip/b"). Then the hub pushes it to
each receiver. This covers requests, tasks, reviews and their answers, thread messages, plans,
snapshot pushes, pulls of a teammate's code, clashes, facts and the full stack. Several at once
play 1.2 s apart, and only the newest keeps its label. Opening the page shows no arrows; only data
that arrives afterwards does.

On the right, Now gives one row per agent: check state, what it is doing, files, last activity.
A **Needs you** bar appears at the top only when a person has to approve a review, decide an
escalated conflict, or accept a test change. Click any node, hub, label, row or event to open its
details in the drawer on the right. The graph stays live beside it, and Esc closes it and puts
focus back. Sources: `src/team.ts` and `src/transfers.ts` (tests: `tests/team.test.ts`,
`tests/transfers.test.ts`), `src/components/Graph.tsx` and `src/components/useFlights.ts`.

- `/?demo&scene=conflict`: failure indicator; inspect it to reveal the fixer, diffs, and diagnosis.
- `/?demo&scene=fixing`: explanation and completed diagnosis, fix still pending.
- `/?demo&scene=resolved`: passing check and verified fact.
- `/?demo&scene=escalated`: human attention required.
- `/?demo&scene=needs_human`: existing-test edit requires review.

The repository requires Node 24+ for the complete tool. D's dashboard was also
built and typechecked on the available Node 22.21 runtime; that does not verify
the hooks or the orchestrator on Node 22.

If a sandboxed server is unreachable from the desktop browser, run the same
local server outside that sandbox using the environment's normal approval flow.
The current development server is bound only to `127.0.0.1`.

## Live integration with C

The integrated branch includes C's 2.13.0 module and generated bindings. The
user selected one SpacetimeDB CLI login per laptop for the hackathon rehearsal.
No external browser auth provider is needed for this local presentation setup.

On **each** laptop that runs the dashboard:

1. Install Node 24+, the locked dependencies (`npm ci`), and the official
   SpacetimeDB CLI 2.13.0.
2. Run `spacetime login`, then `spacetime login show`. Send C only your public
   identity. C grants reader access to see the dashboard, or editor access to
   also use the review buttons (or if this laptop runs an agent). Signing in
   alone does not grant access.
3. In the root `.env`, set only public dashboard settings:

   ```dotenv
   VITE_STDB_HOST=https://maincloud.spacetimedb.com
   VITE_STDB_DB=agent-cowork
   ```

   `VITE_PROJECT_LABEL` optionally names the monitored project. Never add tokens
   to `.env`, a `VITE_*` variable, source, URLs or shared setup documents.
4. Run `npm run ui -- --host 127.0.0.1 --port 5173 --strictPort` and open
   `http://127.0.0.1:5173/` without `?demo`. If the CLI is not on PATH, set
   `SPACETIME_CLI` in the server process to its executable path.
5. The status becomes Live only after all seven views synchronize. If sign-in
   is missing, open Connection, follow its setup instructions, and Retry after
   signing in. For permission errors, ask C to approve the matching identity.
6. Agent laptops also run `npm run doctor -- --demo <demo-clone>`.

Sign-in: the Vite dev server (`ui/dev-session.ts`) answers
`GET /__cowork/session` with **this laptop's own** `spacetime login` token, only
to a page on the same laptop (loopback address, localhost Host and Origin, and a
custom header other sites' pages can't send). It reads the session once per dev
server, so restart `npm run ui` after switching CLI accounts. The token stays in
memory: not in `.env`, a `VITE_` variable, the bundle, or dashboard state. Demo
mode never requests a session. A production build has no such endpoint. Do not
expose this server to a LAN or use it to share one person's login.

The dashboard calls one reducer: `review_test_change`, from the Accept / Send back
buttons on a conflict that needs a person (the fix changed existing tests). That
needs editor access. In `?demo` the buttons change only the simulated rows.
`npm run review` does the same from a terminal.

The adapter validates all expected fields and safe integer conversions from SDK
bigints. Missing tables or incompatible shapes remain disconnected. On an
interruption cached data is labeled stale, retries back off from one to thirty
seconds, and the UI waits for fresh sync. Table events batch into one immutable
store update per microtask. A late credential response after teardown cannot
create a connection.

### Isolated real-server verification

Install module dependencies with `npm ci --prefix module`. Set `SPACETIME_CLI`
and `SPACETIMEDB_STANDALONE` to official 2.13 binaries, then run:

```sh
npm run test:live -w ui
```

This starts a temporary real database, publishes C's module, creates throwaway
identities, and exercises D's actual adapter/generated bindings. It never reads
user login credentials or touches Maincloud. Seed writes cover open conflicts,
resolution/verified memory, and human review. Checks also cover four agent
connections, presence loss, three synchronized subscribers, reconnect, deletion,
revocation and unauthorized access. Rows are simulated; the database transport
and reducer execution are real.

For rendered browser checks, add `-- --browser` in an interactive terminal. Open
`http://127.0.0.1:5174/`. Its label identifies the isolated seeded verification.
Press Enter in the terminal to advance from conflict to resolution to human
review, then finish and clean up. The test bridge supplies only a throwaway Reader
session in memory. It does not use any user's CLI login. Three SDK clients on one
machine do **not** prove three physical screens on the venue network.

## Working with A and B

- Agent presence comes from A's MCP connection, not the seed script or UI.
- The agents' checks own check results and error locations; the module owns conflict status; the orchestrator owns plans. The dashboard shows them, and its buttons only record a person's review or decision.
- The UI cannot prove an agent woke up: show the actual agent terminal during that demo beat.
- Diff excerpts use the latest snapshot. They are explicitly labeled because merged line
  numbers can shift and the stored diff can be truncated.
- The module's timer owns escalation. The seed script does not simulate that timer
  in a real database; the local UI scene is available to develop its presentation.
- The UI displays `needs_human` and the associated inbox note. It has no approval
  reducer or working contract-lock button because those are optional A/C stretch work.

## Verification

```sh
npm run typecheck -w ui
npm test -w ui
npm run build -w ui
npm run seed -- --dry-run
```

Unit tests cover status truthfulness, timestamp conversion, every simulated row,
conflict excerpts, resolution events, subscription readiness, batched changes,
reconnection, malformed data, and cleanup. `tests/team.test.ts` covers the graph's
edges, each agent's "now" line and the human actions in every scene. Checked in a browser
(Oct 24): every scene, Approve / Send back, the escalation decision, Accept test change,
a 760 px window, Esc and focus return, and live mode against the team database.
Screenshots in `artifacts/work-d/` use simulated data and are labeled accordingly.

## Presentation dependencies

Use `pitch/demo-runbook.md` for rehearsal/recording and `pitch/submission-checklist.md`
for final assets. Real interviews, measured runs, final team details, and an actual
backup video remain team inputs. The copy must match the verified capabilities at submission.
