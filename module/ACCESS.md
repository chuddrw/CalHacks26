<!-- WHAT IT'S FOR: owner-approved agent access, sign-in contract, and verification without shared secrets. -->
# Agent Cowork access

Database: https://spacetimedb.com/agent-cowork

Opening the link or signing in does **not** grant agent access. The database starts owner-only. There is no self-enrollment, and no shared owner token is provided to teammates.

Every client must authenticate as its own signed-in identity. The owner explicitly grants that public identity `reader` or `editor` access. Readers can query and subscribe to the seven authenticated team views. Editors can additionally invoke the existing application reducers. Only the owner can grant/revoke access or invoke `reset_all`. Demo reset preserves membership.

## Approve a collaborator

Each person signs in on their own laptop:

```sh
spacetime login
spacetime login show
```

They send the owner only the displayed public identity. Never send the output of `login show --token`, passwords, or API keys.

After reviewing the identity and requested role, the owner runs one of these commands using the owner's existing CLI sign-in:

```sh
npm run access --prefix module -- grant agent-cowork <public-identity> reader
npm run access --prefix module -- grant agent-cowork <public-identity> editor
npm run access --prefix module -- revoke agent-cowork <public-identity>
```

The commands pass public identities and role names only. `SPACETIME_CLI` can select the real CLI binary if it is not on PATH. A reader/editor cannot approve themselves or anyone else. Repeating a grant changes the role. Revocation denies future requests, removes that identity's presence, and removes team rows from its existing view subscriptions. Data already read or copied by a previously authorized user cannot be recalled.

## Client contract for A, B, and D

The query names remain `agent`, `snapshot`, `intent`, `check_run`, `conflict`, `inbox`, and `diagnosis_step`. They now refer to authenticated views over private `*_data` tables. Existing column order, primary keys, number types, and the twelve business reducer argument signatures are unchanged. Regenerated public bindings retain the same table-like client accessors.

HTTP clients must send the user's own valid session token in the Authorization header. WebSocket clients must supply that user's session token through `withToken`; browser sign-in cookies alone do not authenticate an independent agent connection. Clients must obtain/refresh credentials through their own sign-in integration and retain them in their credential/session store or process memory. No token belongs in source, shared setup instructions, or the project `.env`.

A/B/D implementations are not changed here. They must wire their existing token inputs to each user's signed-in session and handle permission failures. Read-only clients should not call `register_agent`, which changes presence and therefore requires Editor access. The watcher needs an explicitly approved Editor identity; reset tooling needs the Owner identity.

Maincloud dashboard collaborators govern platform administration, such as publishing and privileged SQL. They are separate from this application access list and are not automatically synchronized. Ordinary agent users do not need native database-administrator rights. Native administrators capable of publishing code or executing privileged SQL remain trusted administrators and can change the module's policy.

## Enforcement and verification

All backing tables and membership records are private. Every team view performs an indexed, caller-specific membership lookup, so revocation updates active subscriptions. The connection lifecycle rejects missing/unapproved signed identities for HTTP and WebSocket entry points in SpacetimeDB 2.13. Every mutation repeats its role check, including on already-open connections. Scheduled escalation accepts internal database calls only.

`ACCESS_OWNER_IDENTITY` is required server configuration containing the owner's **public identity**, not a secret. It is set during deployment. Only platform administrators capable of publishing should change it. The configured owner cannot be downgraded or revoked through membership reducers.

```sh
npm test --prefix module
npm run typecheck --prefix module
```

The module tests exercise real datastore transactions, all write guards, authorized view parity, role changes, revocation, presence cleanup, owner-only actions, and reset membership. Generation checks reject public backing tables or anonymous team views.

`npm run test:access-network --prefix module` requires an isolated local server on `127.0.0.1:4301`. It creates its own development identities in memory, publishes only `cowork-access-check` locally, and checks HTTP plus generated WebSocket clients, including live subscription revocation. It never uses user credentials or Maincloud.
