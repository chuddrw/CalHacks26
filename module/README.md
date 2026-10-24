<!-- WHAT IT'S FOR: Part C module setup, compatibility decisions, and repeatable verification. -->
# Part C database

Targets SpacetimeDB **2.13.0**, verified against the official release and npm package on October 24, 2026. The module follows the official `spacetime init --lang typescript --server-only` template and its required TypeScript options.

The seven public tables, their column order, and the twelve public reducer argument orders come from `../shared/src/schema.ts`. Public IDs use `u32`, and millisecond timestamps use validated nonnegative safe integers stored as `f64`; both remain JavaScript numbers. Strings representing statuses and kinds are validated by the reducers. Private connection and schedule tables do not appear in public bindings.

`report_conflict` creates the conflict, marks participants red, assigns notifications, and schedules five-minute escalation in one transaction. Active pairs are deduplicated across `open`, `escalated`, and `needs_human`. Reassigning a fixer retires pending old wakeups and notifies the new fixer. Human-review conflicts remain red and cannot be automatically resolved by a green check. Presence is counted per connection, so closing one of two connections does not mark the agent offline.

## Check locally

```sh
npm ci --prefix module
npm run typecheck --prefix module
npm test --prefix module
node --test scripts/demo-reset.test.ts
```

The module tests use SpacetimeDB's official in-memory datastore, including transaction rollback. No hosted database or API key is required.

`npm run test:http --prefix module` exercises the unchanged shared HTTP client, all seven tables, numeric fields, camelCase SQL filters, explanation delivery, resolution, and reset. It requires a separately started **local-only** server at `127.0.0.1:4301` with this module published as `cowork-part-c-check`. It clears that test database before and after the run.

## Generate and publish

Install the matching official SpacetimeDB CLI. `npm run module:generate` produces public TypeScript bindings. Its generation helper restores the case-policy section omitted by the 2.13 extractor, then verifies output from the official CLI; it never hand-edits generated files. If your install exposes a manager shim, set `SPACETIME_CLI` to the actual versioned CLI binary and `SPACETIMEDB_SCHEMA_EXTRACTOR` to its standalone sibling. Generated row types are numbers for public IDs and timestamps. Keep the public bindings in repo 1.

Set `STDB_DB` in the root `.env` to the team's approved database name, and log in with the CLI before `npm run publish:cloud --prefix module`. The script refuses to publish with an absent or invalid database name. The verified module is published as **agent-cowork** on Maincloud: https://spacetimedb.com/agent-cowork. Credentials remain in the CLI’s own sign-in store; no project secrets were created.

A full edit → wake → fix integration rehearsal additionally needs Parts A/B/D, a configured demo remote, and each laptop's hooks. Those parts are outside this implementation.
