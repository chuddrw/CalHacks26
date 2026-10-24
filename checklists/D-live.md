# D: remaining core dashboard integration

WHAT IT'S FOR: evidence and handoff for D's integrated dashboard; interviews,
pitch, website and optional approval/stretch UI are outside this pass.

Branch: `codex/work-d-live-integration`, based on integration `8092c4e`.

## Implemented and exercised

- [x] Actual C-generated SDK bindings, all seven authenticated views.
- [x] Local CLI-session bridge wired into dashboard startup and every reconnect.
- [x] Loopback/exact-origin POST gate, custom header, no CORS grant, no token caching/logging.
- [x] Missing-login guidance and Retry in the existing Connection inspector.
- [x] Async credential teardown prevents late connections after navigation/retry.
- [x] Unit tests: 19/19, including HTTP bridge security and lifecycle regressions.
- [x] Real local server: 11/11 checks using C's module and disposable identities.
- [x] Four separate Editor identities register agents; all four become online.
- [x] Disconnecting D updates presence while A/B/C remain connected.
- [x] Three SDK subscribers receive the same conflict/memory changes.
- [x] Conflict seed, streamed diagnosis rows, intent insertion, reconnect, reset/deletes.
- [x] Resolved seed produces a current green check and verified memory.
- [x] Human-review seed remains prominent; unapproved/revoked identities cannot show healthy live state.
- [x] Browser inspection of actual subscribed conflict/diffs/output, verified memory and human review.

The seed content is simulated. Transport, permissions and reducer execution are
real. Screenshots `artifacts/work-d/live-local-*.jpg` identify isolated seeded
verification. These tests do not run Claude/Droid models or prove autonomous fixes.

## Team database and device rehearsal: still required

- [ ] C confirms the latest integrated module is published on shared Maincloud.
- [ ] Each laptop installs Node 24+, CLI 2.13.0 and locked project dependencies.
- [ ] Each person runs `spacetime login`; sends C only `spacetime login show`'s public identity.
- [ ] C approves Editor for agent users, Reader for dashboard-only users.
- [ ] Agent laptops pass `npm run doctor -- --demo <demo-clone>`.
- [ ] Each dashboard uses its own local Vite server and CLI session; see ui/README.md.
- [ ] Observe the real shared-database agent → conflict → diagnosis → fix → memory loop.
- [ ] Verify physical presentation screens on venue networking, including interruption/reconnect.

D cannot grant membership or publish as the owner from a Reader account. No
credentials are requested in chat or committed to the project. This laptop was
checked with the official CLI: it is currently signed out.

## Reproduce

```sh
npm ci
npm ci --prefix module
npm run typecheck -w ui
npm test -w ui
npm run build -w ui
```

With official binary paths in process variables `SPACETIME_CLI` and
`SPACETIMEDB_STANDALONE`:

```sh
npm run test:live -w ui
npm run test:live -w ui -- --browser
```

The optional browser harness uses port 5174 with a throwaway Reader session.
Enter advances through conflict, resolution and human review, then cleans up.
It never uses a user's CLI session or the team database. The normal dashboard
runs on 5173; its local bridge uses the actual signed-in user.
