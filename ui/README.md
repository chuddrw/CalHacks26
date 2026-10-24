# Work D: dashboard handoff

WHAT IT'S FOR: run, verify, and integrate D's dashboard without waiting on the rest of the team.

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

The landing view is intentionally symbolic: agent nodes feed a single team-health
indicator. Click an agent, the health indicator, or a Checks/Memory/Activity symbol
to open its inspector. Conflict inspectors begin with a summary; **Changes &
diagnosis** reveals the source excerpts, failure output, and investigation feed.
On wider screens the map stays interactive beside the nonmodal inspector. Select
another agent to update the same panel. Tab moves freely between the map and panel;
Escape or the close button dismisses it and restores focus to the opening symbol.

- `/?demo&scene=conflict`: failure indicator; inspect it to reveal the fixer, diffs, and diagnosis.
- `/?demo&scene=fixing`: explanation and completed diagnosis, fix still pending.
- `/?demo&scene=resolved`: passing check and verified fact.
- `/?demo&scene=escalated`: human attention required.
- `/?demo&scene=needs_human`: existing-test edit requires review.
- Add `&big` for larger presentation text, or use **Big-screen view**.

The repository requires Node 24+ for the complete tool. D's dashboard was also
built and typechecked on the available Node 22.21 runtime; that does not verify
the hooks or watcher on Node 22.

If a sandboxed server is unreachable from the desktop browser, run the same
local server outside that sandbox using the environment's normal approval flow.
The current development server is bound only to `127.0.0.1`.

## Live integration with C

The user confirmed that browser authentication is not configured yet. Keep using
the labeled local simulator until the team supplies its public auth configuration
and approves the user's reader identity.

1. Agree on the SpacetimeDB SDK/module version with C. The UI currently locks SDK
   2.13.0 in package-lock.json. Do not assume bindings generated for a different
   major version will work.
2. C implements and publishes `module/src/index.ts`, preserving the contract in
   `shared/src/schema.ts`, then generates and commits `shared/module_bindings/index.ts`.
3. Set `VITE_STDB_HOST` and `VITE_STDB_DB` in the root `.env`. Optional:
   `VITE_PROJECT_LABEL` is the monitored project's display label.
4. Restart Vite after generation or environment changes. For production, rebuild;
   Vite discovers generated bindings at build time.
5. Open `/` without `?demo`. The status progresses through connecting and syncing
   to live only after the subscription is applied.
6. On a development database, run `npm run seed -- --dry-run` first. Inspect it,
   then `npm run seed -- --scene conflict` to exercise the real HTTP/reducer path.
7. Verify inserts, updates, deletes, socket interruptions, and reconnects against
   the real module. Then use C's agreed reset procedure before a real rehearsal.

The browser does not read `STDB_TOKEN` or other server keys. It establishes its
own SDK connection and calls no reducers. C's separate `catherine_part_c` branch
uses authenticated views with owner-approved reader access. The current adapter
startup does not yet supply a signed-in user's token, so it is not ready for that protected
module. The transport accepts an optional session `getToken` callback, re-reads it
on reconnect, and refuses anonymous fallback when that session is absent or fails.
Tokens are not written to dashboard state. Wiring this callback to the team's
approved sign-in provider remains open. Dashboard cookies alone do not authenticate an SDK connection. Coordinate
the user's sign-in flow and reader approval with C; never put an owner token or
server credential in a Vite environment variable.

The adapter validates all expected fields and safe integer conversions from SDK
bigints. Missing tables or incompatible shapes stay visibly disconnected rather
than producing a false green. On interruption, cached data is labeled stale;
retries back off from one to thirty seconds, and the UI waits for fresh sync.
Table changes are batched into one immutable store update per microtask.

## Working with A and B

- Agent presence comes from A's MCP connection, not the seed script or UI.
- The watcher owns check results, error locations, conflict status, and fixer assignment.
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
reconnection, malformed data, and cleanup. Browser checks cover desktop and mobile
layouts, the scene selector, big-screen toggle, human-review states, and filtering.
They also cover map-to-summary-to-evidence navigation, nonmodal map interaction,
Escape dismissal, and focus restoration.
Screenshots in `artifacts/work-d/` use simulated data and are labeled accordingly.
No live integration or end-to-end agent run has been verified yet.

## Presentation dependencies

Use `pitch/demo-runbook.md` for rehearsal/recording and `pitch/submission-checklist.md`
for final assets. Real interviews, measured runs, final team details, and an actual
backup video remain team inputs. The copy must match the verified capabilities at submission.
