# Integration: A + B + C

> This file records how the three branches were combined on branch `integration`, which side won each conflict, what had to change so the parts fit together, the test results, and what each of us still has to do. Nothing was merged into `main`, and nobody's own branch was changed.

Done Oct 24, about 5:30 AM, by A (with Claude Code).

## What's on `integration`

`main` (the skeleton), then in this order:

1. `catherine_part_c` (C, PR #1): the SpacetimeDB module with access control, the diagnosis runner, tests. Merged cleanly.
2. `feat/a-hooks-mcp` (A): hooks, MCP server, mock database, end-to-end test. One conflict, in `package.json` (both scripts lists kept).
3. `watcher` (B): the watcher, plus Christina's own module (`2c267b6`). 22 conflicts, decided below.
4. One commit of changes that make the three fit together, then this file and the docs.
5. `codex/work-d-dashboard-pitch` (D, Oct 24 ~7 AM): dashboard UI and pitch files. Three conflicts: `ui/package.json` and `scripts/seed-fake.ts` took D's version, and `package-lock.json` was regenerated. Two fixes in D's seed so it works with C's module: it no longer asks for `STDB_TOKEN`, and it creates agent rows with `send_note` because `register_agent` needs a live WebSocket. Checked: every type check passes, D's UI tests 16/16, A's e2e passes, and the seed scenes conflict, resolved and needs_human all run against the mock database.

## Conflict decisions (B's merge)

| Files | Kept | Why |
|---|---|---|
| `module/`, `shared/module_bindings/`, `shared/src/schema.ts`, `external/spacetimedb-maincloud.txt` | C | C owns the module, and PR #1 has the access control and the tests. Christina's module (`2c267b6`) is replaced; her watcher code is all kept. |
| `watcher/src/diagnose/index.ts` | C | C's real runner. B's agreed `diagnose(request)` signature moved to a bridge file (below). |
| `package.json`, `mcp/package.json` | both | Scripts from both sides; B's `spacetimedb` dependency for the MCP server. |
| `package-lock.json` | regenerated | `npm install` over the merged package files. |
| `structure.md` | both | Combined by hand. |

## Changes that make A, B and C fit

| Change | Why | Files |
|---|---|---|
| Watcher waits for its check reports before reporting a conflict | C's `report_conflict` only accepts a conflict whose red check is already stored and current. B fired those reports without waiting. | `watcher/src/index.ts` |
| Full check reported with matching runKey and agents | C treats a check as current only when its runKey is exactly the listed agents' latest shas. B listed unchanged agents without their shas. | `watcher/src/index.ts` |
| Resolve through `resolve_conflict_if_current` | C's guarded reducer: this exact conflict version plus a named green check. | `watcher/src/index.ts`, `watcher/src/stdb.ts` |
| Bridge from B's `diagnose(request)` to C's `createDiagnosisRunner` | C's runner imports nothing from B and asks for its dependencies; the bridge supplies a dedicated worktree, guarded writes and the current-conflict check. | `watcher/src/diagnosis.ts` (new) |
| Row types `ConflictData`, `IntentData`, `SnapshotData` | C's bindings expose views; their rows have the `*Data` fields. | `watcher/src/stdb.ts` |
| Every tool signs in as its own user | C's rule: no token in `.env`; each client uses its own `spacetime login` session. | `shared/src/session-token.ts` (new), `shared/src/stdb-http.ts`, `watcher/src/stdb.ts`, `mcp/src/server.ts`, `.env.example` |
| MCP presence over a WebSocket | C's `register_agent` needs a live connection; HTTP can't keep one. | `mcp/src/server.ts` |
| Mock database follows C's rules | So A's test, and B or D working without a server, behave like the real module. | `scripts/mock-stdb.ts`, `hooks/test/e2e.ts`, `scripts/seed-fake.ts` |
| `npm run doctor` | The hooks fail open, so an unapproved laptop would silently do nothing. | `scripts/doctor.ts` (new) |
| C's test runners pass `file://` URLs to `--import` | A plain `c:\...` path fails on Windows. | `module/tests/run-part-c.mjs`, `module/tests/admin-cli.unit.test.mjs` |
| C's network test links `node_modules` as a junction | A plain symlink needs admin rights on Windows; the type is ignored on Mac and Linux. | `module/tests/access-network.mjs` |
| `npm run test:live` | The whole system on a real SpacetimeDB server, so the hand-offs between A, B and C are tested, not just each part. | `scripts/live-e2e.ts` (new) |

## Added after the merge (Oct 24, daytime)

| Change | Why | Files |
|---|---|---|
| Wake message includes the teammate's plan | The fixer saw what broke but not why the teammate changed it, and could undo their change. Now it reads "a's plan: ..." (a's latest `post_intent`). | `hooks/src/lib/fixer-message.ts` (new), `hooks/src/lib/format.ts` |
| **A person reviews a fix that changed tests** | `needs_human` had no way out: nobody could approve or reject, so the conflict stayed stuck until a reset. New reducer `review_test_change(conflictId, approve, comment)` in C's module. Approve resolves it, but only on a current green check. Send back reopens it and wakes the fixer with the reviewer's note. Until the fixer posts a newer snapshot, no check can resolve it (private table `test_review`); without that, the watcher's next green run would have resolved the rejected fix. | `module/src/index.ts`, `module/tests/test-review.component.test.ts` (new), shared contract, bindings, mock |
| Review from the dashboard or a terminal | Accept / Send back buttons on the conflict, with an optional note; `npm run review` does the same. | `ui/src/components/ConflictPanel.tsx`, `scripts/review.ts` (new) |
| Dashboard live mode signs in | The dev server hands this laptop's `spacetime login` token to a page on the same laptop only. No token in `.env` or in the bundle. | `ui/dev-session.ts`, `ui/src/session.ts` (new), `ui/src/stdb.ts`, `ui/src/live.ts` |
| Hooks no longer call `process.exit()` after a database call | On Windows that can crash Node ("Assertion failed ... src\win\async.c", exit 0xC0000409) instead of exiting with 2, and then the fixer never wakes. Found while testing the review: it happened every time in one test step. Now the hooks set the exit code and let Node exit by itself. | `shared/src/stdb-http.ts` (`finishProcess`), `hooks/src/lib/hook-io.ts` |
| `npm run local-db [-- --scene review]` | A throwaway local SpacetimeDB with C's module and editor accounts for a, b, c, d, the watcher and the dashboard, for rehearsals and manual tests. | `scripts/local-db.ts` (new) |

Checked in a real browser against a real local server: the dashboard goes live and shows the conflict. Send back reopens it, and b's inbox gets the wake note with the comment. Accept is refused while the check is red, with the reason shown, and resolves the conflict once it's green (the dashboard turns "In sync").

## Test results (Oct 24, Windows, Node 24.15)

| What | Result |
|---|---|
| Type checks: hooks, mcp, watcher, ui, module, module tests | All clean |
| A's end-to-end test (`npm run test:a`, mock database) | All pass, 3 runs in a row (adds: a's plan in the wake message; review: list, send back, the old green can't resolve, the fixer wakes with the reason, accept refused while red, accept when green) |
| C's vitest suite (`npm run test:part-c`, part 1) | 94 / 94 (87 + 6 review tests + readers can't review) |
| Dashboard tests (`npm test --prefix ui`) | 19 / 19 (D's 16 + who gets the sign-in token, demo review, live review) |
| C's Node test suite (part 2) | 74 / 90. **Exactly the same 16 fail on C's own branch on this laptop**, so the merge added none. They assume Mac or Linux (fake CLI shell scripts, symlinks). |
| C's network test (`npm run test:part-c:integration`, real 2.13 server) | Passes: Reader/Editor/Owner guards, revocation, current-run guards |
| **Live run, all parts together** (`npm run test:live`, temporary local 2.13 server) | **19 / 19, twice in a row; 20 / 20 after the plan line was added.** b is woken **3.5 s** after a's edit, and the wake message includes a's plan (its latest `post_intent`); C's module records `src/users/user.ts:14 x src/sessions/idle.ts:4`, fixer b; the diagnosis bridge runs C's runner; the MCP server shows b online over a WebSocket and offline after; `pull_teammate` brings a's change over; the conflict resolves **2.1 s** after b's fix. No processes or temp files left behind. |

The live run uses the real code of every part: A's hooks and MCP server, B's watcher and fixture repos, C's module published with its access rules. It never touches the team database or anyone's login: identities and keys are throwaway, and the server lives in memory.

## Still to do

**Everyone**
- Install the SpacetimeDB CLI 2.13.0, run `spacetime login`, and send your **public identity** (`spacetime login show`, never `--token`) to Catherine.
- `npm run doctor -- --demo <your demo clone>` until it says "ready".

**Catherine (C)**
- Grant editor roles: A, B, D, and the watcher's identity (module/ACCESS.md).
- Deploy the module from `integration` (not PR #1): maincloud is missing `resolve_conflict_if_current`, `set_explanation_if_current` and the new `review_test_change`. The new private table `test_review` is an added table, so existing data stays.
- Optional: the 16 tests that only pass on Mac or Linux.

**Christina (B)**
- Review the watcher changes above (`git diff origin/watcher..integration -- watcher/`).
- Run the fixture against a real server (local or the team database once approved).

**D**
- Done by A on `integration`: live mode signs in (`ui/dev-session.ts`), and the review buttons are in your conflict panel. Please look over `ui/src/components/ConflictPanel.tsx` and `ui/README.md`. The dashboard laptop's account needs editor access for the buttons.
- `pitch/submission-checklist.md`: the "Test edits trigger human review" evidence row can be recorded now.

**A**
- Done on a local server (`npm run test:live`). Next: sign in (`spacetime login`), get approved, and run the demo once against the team database.

## How to review

- Everything: `git diff main..integration`
- Only the fitting changes: the commit "Integrate A + B + C: wire the watcher and hooks to Part C's module"
- One part against its own branch: `git diff origin/watcher..integration -- watcher/`
