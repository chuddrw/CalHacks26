<!-- WHAT IT'S FOR: scope, evidence and remaining integration obligations from the local Part C review. -->
# Local Part C review — October 24, 2026

The review added unit, subcomponent, component and integration regressions without implementing A/B/D. All changes below are local; the hosted database still requires a separately authorized deployment.

## Fixed findings

- Stale checks could mark newer snapshots green, and delayed explanation/resolution writes could affect a newer conflict. Latest-snapshot validation and additive atomic version-checked reducers now reject those races. Historical checks remain recorded.
- Failed diagnosis attempts stayed cached indefinitely. Failed or unavailable attempts now become retryable after cleanup, while successful results remain deduplicated. An old failure cannot evict its replacement.
- Retired fixer wakeups could cause duplicate explanation notifications. Only the newest fixer wakeup controls delivery behavior.
- Reset validation missed aliases and additional push URLs for the tool repository. It now checks all tool-repository remote push URLs and propagates lookup failures.
- Malformed or unreadable configuration could crash imports. Loading now fails open with a fixed error code that exposes no configuration values. CLI entry points also work through symlinks.
- `send_note` accepted actionable conflict messages without a conflict ID. Its shared input type and runtime validation now exclude that kind.

## Architecture and interfaces

The diagnosis runner uses injected providers, database operations, freshness checks and a worktree lease with owned cleanup. It does not import B's orchestration. Database transactions enforce permissions and conflict revisions; a local freshness check alone cannot protect an asynchronous write.

The shared schema remains authoritative. Generation verifies private tables, authenticated views, keys, nested row types and reducer argument order against that source through the official CLI. Existing reducer signatures remain; guarded reducers are additive, and the note-kind narrowing was explicitly approved.

B must inject `setExplanationIfCurrent` and use `resolve_conflict_if_current` after storing a current green check. See the [diagnosis contract](../orchestrator/src/diagnose/README.md). Legacy explanation calls remain available for compatibility and do not protect against concurrent revision changes. B's implementation was not edited.

## Validation and limits

The coverage run passed 202 tests: 87 Vitest and 115 Node tests. Across the 13 C production files, lines reached 91.80%, statements 89.12%, functions 95.88% and branches 83.66%. The database module and diagnosis sources reached 100% line coverage. Strict test type-checking passed. A separate isolated HTTP/WebSocket run passed Reader/Editor/Owner, revocation and current-run guards using generated bindings.

See the [test guide](tests/README.md) for reproducible commands, denominator and collector details. Remaining coverage gaps are chiefly CLI orchestration and reset mutation paths. Provider sessions are injected/mocked; live model quality and an end-to-end A/B/D workflow are outside these results.

Two workflow limits remain explicit: `needs_human` has no targeted adjudication/exit API in C, and Droid's 90-second abort threshold can be followed by SDK teardown before Claude fallback. Neither was expanded into new functionality during this review.
