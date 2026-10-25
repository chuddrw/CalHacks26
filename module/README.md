<!-- WHAT IT'S FOR: Part C module setup, compatibility decisions, and repeatable verification. -->
# Part C database

Targets SpacetimeDB **2.13.0**, verified against the official release and npm package on October 24, 2026. The module follows the official `spacetime init --lang typescript --server-only` template and its required TypeScript options.

The seven authenticated views over private backing tables, their column order, and the twelve original public reducer argument orders come from `../shared/src/schema.ts`. Two additive version-checked reducers protect concurrent explanation and resolution writes. Public IDs use `u32`, and millisecond timestamps use validated nonnegative safe integers stored as `f64`; both remain JavaScript numbers. Strings representing statuses and kinds are validated by the reducers. Private connection and schedule tables do not appear in public bindings.

`report_conflict` creates the conflict, marks participants red, assigns notifications, and schedules five-minute escalation in one transaction. Active pairs are deduplicated across `open`, `escalated`, and `needs_human`. Reassigning a fixer retires pending old wakeups and notifies the new fixer. Human-review conflicts remain red and cannot be automatically resolved by a green check. Presence is counted per connection, so closing one of two connections does not mark the agent offline.

## Check locally

[Layered Part C test guide](tests/README.md) covers units, subcomponents, components and integration without A/B/D.

```sh
npm ci --prefix module
npm run typecheck --prefix module
npm run test:part-c
npm run typecheck:tests --prefix module
```

See [ACCESS.md](ACCESS.md) for owner-approved Reader/Editor access and the client sign-in contract. Signing in or opening the dashboard link grants no access by itself.

The module tests use SpacetimeDB's official in-memory datastore, including transaction rollback. No hosted database or API key is required.

See [local review findings](REVIEW.md) for concurrency guards, interface adoption and measured C coverage. The review fixes and guarded reducers have not been deployed to Maincloud.

`npm run test:http --prefix module` (also `test:access-network`) proves real HTTP/WebSocket permissions against an isolated server at `127.0.0.1:4301`. It creates development identities in memory and publishes only `cowork-access-check` locally. It tests denied anonymous/nonmember access, Reader queries, Editor writes, Owner approvals, private backing data, role changes, and revocation of an open subscription. It uses no user credentials or hosted data.

## Generate and publish

Install the matching official SpacetimeDB CLI. `npm run module:generate` produces public TypeScript bindings. Its generation helper restores the case-policy section omitted by the 2.13 extractor, then verifies output from the official CLI; it never hand-edits generated files. If your install exposes a manager shim, set `SPACETIME_CLI` to the actual versioned CLI binary and `SPACETIMEDB_SCHEMA_EXTRACTOR` to its standalone sibling. Generated row types are numbers for public IDs and timestamps. Keep the public bindings in repo 1.

Set the public `STDB_DB=agent-cowork-orch` setting in your process environment, and log in with the CLI before `npm run publish:cloud --prefix module`. The script refuses to publish with an absent or invalid database name. First deployment requires `ACCESS_OWNER_IDENTITY` in the publishing process environment; this is the owner’s public identity. Existing server configuration is preserved on later publishes. The team database is **agent-cowork-orch** on Maincloud: https://spacetimedb.com/agent-cowork-orch. Credentials remain in the CLI’s own sign-in store; no project secrets were created.

A full edit → wake → fix integration rehearsal additionally needs Parts A/B/D, a configured demo remote, and each laptop's hooks. Those parts are outside this implementation.
