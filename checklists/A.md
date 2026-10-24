# A checklist: hooks + MCP

> This is the working checklist for role A (hooks + MCP server), kept on branch `feat/a-hooks-mcp`. Each item ends with how we know it's done. Anything that depends on C's real SpacetimeDB module runs against a mock for now and is listed under "Waiting on C".

Status on Oct 24, about 4:40 AM: everything A can do without C is done. `npm run test:a` passes all 47 checks.

## Done

- [x] **rewake spike**: an idle Claude Code session woke up by itself from an `asyncRewake` hook (Oct 24, 3:42 AM, VS Code extension).
- [x] **Branch** `feat/a-hooks-mcp` created from `main`.
- [x] **Mock SpacetimeDB** (`scripts/mock-stdb.ts`, `npm run mock-db`): the same `/call/<reducer>` and `/sql` endpoints, in-memory tables from `shared/src/schema.ts`, reducer behavior from `module/src/index.ts`. `npm run seed` runs against it: 4 agents, conflict a+b with fixer b, explanation, 3 Droid steps.
- [x] **Snapshot** (`hooks/src/lib/snapshot.ts`, plus `shared/src/git.ts`). An edit in a test clone pushed `wip/a`, and the clone's `git status` and `git log` stayed the same. No temp index or lock left in `.git`.
- [x] **Main hook** (`hooks/src/snapshot-and-wait.ts`). Snapshot row **530-570 ms** after the edit (target 2 s). The idle agent woke with exit code 2 **667-681 ms** after `report_conflict` (target 3 s). An older listener exits once a newer one starts.
- [x] **inject-context** (`hooks/src/inject-context.ts`). A teammate's intent comes back as `additionalContext`, is marked delivered, and is never shown twice. Uses the right event name for UserPromptSubmit, and delivers a conflict itself when no listener is alive.
- [x] **stop** (`hooks/src/stop.ts`). An open conflict blocks the Stop once; `stop_hook_active` lets it through; an agent with no conflict stops normally.
- [x] **session-start** (`hooks/src/session-start.ts`). A new session gets the team status with every verified fact.
- [x] **install** (`hooks/src/install.ts`). One command sets `COWORK_NAME`, merges the hooks into `.claude/settings.local.json` (keeping other settings, replacing only its own old entries), writes `.mcp.json`, and git-excludes both files. Running it twice changes nothing; `--dry-run` writes nothing.
- [x] **MCP server** (`mcp/src/server.ts`). An MCP client lists the 3 tools. `post_intent` stores the intent and sends heads-ups; `team_status` returns the team picture; `pull_teammate` brings a teammate's wip change into a clone, is safe to call twice, and explains when there's no snapshot.
- [x] **End-to-end test** (`hooks/test/e2e.ts`, `npm run test:a`): a temporary bare remote, three clones and the mock database, running the real hooks and the real MCP server. Leaves no files behind (checked).
- [x] **Type check**: `npm run typecheck:a` (hooks and mcp) passes with TypeScript 7.0.2.
- [x] **Docs**: structure.md, external/mcp.txt, external/claude-code-hooks.txt and .env.example match what was built.
- [x] **Commit** on the branch and push it: `f18ccd5`, pushed to `origin/feat/a-hooks-mcp`, no pull request (as the user asked).

## Waiting on C (updated during the integration, branch `integration`; see checklists/integration.md)

- [ ] Run the hooks against the real database once this laptop is signed in and approved (`npm run doctor`).
- [x] MCP presence over WebSocket with C's bindings: done on `integration`. `register_agent` needs a live connection in C's module.
- [x] SQL column names: C's module keeps camelCase (`CaseConversionPolicy.None`), and the hooks only filter on one-word columns anyway.
- [x] Tokens: C's rule is "no token in .env". The tools now read this laptop's `spacetime login` session (`shared/src/session-token.ts`).

## Found along the way

- Node 24 treats `--env-file` as its own flag even after the script name, so install's option is called `--env-path`.
- The MCP SDK (1.32.2) accepts zod 3 schemas, so it shares zod@3 with the Droid SDK.
- Two hooks can snapshot at the same moment when an agent edits quickly. A per-clone lock keeps an older tree from being pushed after a newer one.
- `pull_teammate` runs `git apply --check` first. If the patch doesn't fit, it changes nothing and says why.

## Questions for the user

Asked Oct 24, ~3:50 AM:

| Question | Answer |
|---|---|
| Install packages on the branch (changes package.json and package-lock.json)? | Yes |
| How should install.ts register the MCP server, since the user has no `claude` CLI? | Write a gitignored `.mcp.json` in the demo clone and enable it in `settings.local.json` (`enabledMcpjsonServers`) |
| Where does the mock database live? | In the repo, `scripts/mock-stdb.ts`, so B and D can use it too |
| Push when done? | Push the branch, no pull request |
