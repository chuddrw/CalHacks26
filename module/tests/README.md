<!-- WHAT IT'S FOR: repeatable layered tests for Part C alone, including local-only integration. -->
# Part C tests

Use Node 24+ and git. Install the standalone C test dependencies; no workspace setup is required:

```sh
npm ci --prefix module
npm run test:part-c
npm run typecheck:tests --prefix module
```

`test:part-c` runs both test engines and reports failures from either one. It includes all existing C regressions as well as the new layers below. No hook, MCP server, watcher orchestration, dashboard, separately cloned demo app, account login or API key is required.

## Unit tests

`shared/src/schema.test.ts` checks shared key invariants and caller-input preservation. `shared/src/config.test.ts` executes copies of the real configuration source inside isolated fixture projects, proving root-relative loading, missing settings and environment precedence without reading the developer's `.env`.

`watcher/src/diagnose/units.test.ts` covers UTF-8 boundaries, evidence/prompt limits, selected-fixer wording, malformed model output and command-injection boundaries. `module/tests/admin-cli.unit.test.mjs` exercises approval command validation and argument quoting with a local recording executable. Generation-policy tests reject contradictory descriptors and exposure of backing tables or anonymous views.

## Subcomponent tests

`watcher/src/diagnose/droid-adapter.test.ts` injects SDK sessions to test tool discovery, restrictive permission decisions, streamed events, failed startup/discovery/transport and cleanup. `module/tests/claude.subcomponent.test.ts` mocks the Claude SDK and settings to test structured responses, refusals, token-limit truncation, API/malformed-output errors, unexpected errors and bounded request configuration.

## Component tests

`module/tests/coordination.component.test.ts` exercises state transitions through real SpacetimeDB datastore transactions: intent fanout, inbox delivery, explanation updates, retry/fixer changes, UTF-8 storage limits, check upserts, escalation/reset interactions and revocation across multiple connections. The newest-wakeup regression prevents retired notifications from producing duplicate diagnosis notes.

`watcher/src/diagnose/runner-component.test.ts` exercises complete runner instances with injected providers and leases, including stale results, independent concurrent conflicts, copied inputs, acquisition/publication/cleanup failures and bounded event queues. Existing `diagnose.test.ts`, `module.test.ts`, and `access.test.ts` remain part of the suite.

`scripts/demo-reset.safety.test.ts` and the existing reset tests create local throwaway git repositories and inject every mutation. They cover dirty/staged/deleted work, repository/remote validation, dry-run preservation and partial failure ordering. No remote push or actual database reset occurs.

## Datastore integration

`module/tests/diagnosis.integration.test.ts` joins the actual C diagnosis runner to the actual database reducers, ACL and inbox logic through injected callbacks. It uses real disposable directories and fixture providers. The tests prove that an explanation is persisted, a proposed fact stays unverified until resolution, revocation rejects publication while cleaning the worktree, and a human-review transition suppresses stale output.

SpacetimeDB's official in-memory datastore enforces constraints and transaction rollback. Provider calls are mocks/injected sessions, so these tests do not assess live model quality or paid API availability.

## HTTP/WebSocket integration

Install matching official SpacetimeDB 2.13.0 CLI and standalone binaries, then run:

```sh
SPACETIME_CLI=/path/to/spacetimedb-cli \
SPACETIMEDB_SCHEMA_EXTRACTOR=/path/to/spacetimedb-standalone \
npm run test:part-c:integration
```

The wrapper allocates a temporary loopback port, generates its own keys, starts an in-memory server, and uses an isolated CLI configuration. It publishes only a generated `cowork-access-*` local database. It verifies real HTTP permissions and generated WebSocket bindings, Reader/Editor/Owner separation, private backing-table denial, promotion/downgrade, revocation clearing an active subscription, and membership surviving reset. Server, keys, configuration and fixtures are cleaned on exit. Maincloud and the user's credential store are not used.

## Isolation

`register-dependencies.mjs` resolves diagnosis SDKs from the C package's devDependencies, so Part B's `node_modules` and package configuration are unnecessary. It replaces the real settings module with inert fixtures during Node tests. Vitest uses equivalent aliases. Configuration loading itself is tested separately from copied source. The test runner removes inherited credential variables before launching suites.

The ordinary module test command remains available as `npm test --prefix module`. The comprehensive command is `npm run test:part-c`; the network integration command is separate because it requires official host binaries and permission to bind localhost.

## Coverage and edge cases

Run `npm run test:part-c:coverage` from the repository root. Open `module/coverage/index.html`; JSON summaries and collector metadata are beside it. The measured review run passed 202 tests and covered 91.80% of lines, 89.12% of statements, 95.88% of functions and 83.66% of branches.

The denominator is the 13 C production files explicitly listed in `coverage-scope.mjs`, including files with no hits. Tests, generated bindings, dependencies, A/B/D and the separate demo app are excluded. Vitest V8 coverage owns the datastore module and Claude adapter; native Node V8 profiles converted through executable-source ASTs own the other files. Each file has one authoritative collector to avoid counting transformed copies twice. Isolated copied-source tests contribute only after byte-identical verification. Type declarations and comments are not executable lines. This measures exercised code, not correctness or live model quality.

Regression cases include stale checks/explanations/resolutions, duplicate or reordered wakeups, same-error retries after failure, replacement-attempt cache races, revocation during diagnosis, multiple presence connections, malformed model output, UTF-8 truncation, provider cleanup failures, remote aliases/multiple push URLs, malformed configuration, symlink entry points and generator contract drift. `state-revisions.test.ts` tests database atomic guards; `manage-cli.unit.test.mjs` tests CLI dispatch with isolated fake executables. HTTP/WebSocket integration independently verifies the guarded calls and stale checks against an actual temporary server.

Remaining coverage gaps are mainly reset mutation and generator orchestration/error paths. Mutating commands are injected or replaced with local recording executables; coverage does not imply a real remote push, hosted reset or paid model call was exercised.

## SDK dependency caveat

The isolated test package pins the supported Anthropic 1.3.0 / Factory 0.10.0 SDK APIs. Factory 0.10.0 is currently the vendor's latest release and still requires Zod 3 and uuid 9. npm audit reports upstream advisories for those dependency ranges (Zod constrained-collection exhaustion and uuid buffer bounds). The tests use fixture inputs and mocked/injected model sessions; they do not call a live provider. No incompatible major-version overrides were applied, and no production workspace dependency was changed. Reassess these pins when the vendor publishes compatible patched dependencies.
