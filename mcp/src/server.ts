/**
 * mcp/src/server.ts
 *
 * WHAT IT'S FOR
 *   The MCP server each agent talks to. Claude Code starts one per session over stdio. It gives
 *   the agent three tools, and it keeps a live SpacetimeDB connection open so the UI knows the
 *   agent is online (the module's client_disconnected reducer marks it offline when we exit).
 *
 * OWNER: A. WHEN: Sat 20:00-24:00.
 * DONE WHEN: in a Claude session in demo-app, /mcp shows "cowork" connected, the agent's card
 *            turns online in the UI, and calling post_intent makes a heads-up reach the others.
 *
 * TOOLS (the descriptions are prompts, so keep them short and concrete)
 *   post_intent
 *     description: "Tell your teammates' agents what you are about to change and why, BEFORE you
 *       change anything other files import: exported functions, types, or the meaning or unit of
 *       a field. summary: one sentence, e.g. 'Changing User.lastLogin from seconds to milliseconds
 *       because the frontend needs ms.' files: paths you will touch. symbols: exported names affected."
 *     input: { summary: string, files: string[], symbols: string[] }
 *     does:  post_intent(COWORK_NAME, summary, files, symbols); returns "Sent to <n> teammates."
 *   team_status
 *     description: "Get the team's live state: who is working on what, verified facts, recent
 *       plans, and any conflict you must fix. Call it when a [cowork] note tells you to, or before
 *       a change that crosses into another module."
 *     input: {}
 *     does:  returns teamStatus(...) text (reuse hooks/src/lib/format.ts) built from the local cache.
 *   pull_teammate
 *     description: "Bring a teammate's in-progress (uncommitted) change into your working tree, so
 *       you can run the tests on both changes together. Use it when a [cowork] conflict names you as
 *       the fixer, with the teammate's name from that message."
 *     input: { agent: string }
 *     does:  in the session's folder (process.cwd(), the demo-app clone; confirm that Claude Code
 *            starts stdio servers there):
 *              git fetch <remote> wip/<agent>
 *              base = git merge-base <remote>/<main> FETCH_HEAD
 *              git diff <base> FETCH_HEAD | git apply --3way
 *            Returns the files it changed. If it can't apply cleanly, it undoes the partial apply
 *            and answers "you both edited the same lines in <files>; ask your human to coordinate".
 *     why:   the fixer's laptop doesn't have the teammate's uncommitted change, so without this the
 *            fixer would "fix" blind and its own tests would go red. Found by simulating the demo.
 *     tested (Oct 24, real git): applied a's 4 files cleanly into b's clone (they show as staged),
 *            b's local tests then showed the same failure, b fixed only its own file, and the watcher
 *            merged wip/a + wip/b with no conflict and 6/6 tests green.
 *     later: when the teammate commits that change to main, `git stash -u && git pull && git stash pop`
 *            folds the identical pulled lines back in cleanly (also tested).
 *
 * STEPS
 *   1. Read COWORK_NAME and STDB_* through shared/src/config.ts. If any is missing, still start,
 *      but make both tools answer "cowork is not configured on this laptop (see external/mcp.txt)".
 *   2. Connect to SpacetimeDB with the generated bindings in shared/module_bindings. On connect,
 *      call register_agent(COWORK_NAME). Subscribe to agent, intent and conflict, so team_status
 *      answers from the local cache without a round trip.
 *   3. Register the three tools with @modelcontextprotocol/sdk (McpServer + StdioServerTransport) and
 *      zod input schemas. Check the SDK README for the current registerTool signature before writing it.
 *      pull_teammate runs git with execFile (no shell), piping git diff into git apply.
 *   4. Connect the stdio transport.
 *
 * NOTES
 *   - stdout belongs to the MCP protocol. Log ONLY to stderr (console.error). Anything else on
 *     stdout corrupts the protocol and Claude Code drops the server.
 *   - When Claude Code ends the session it closes our stdin. Exit then, so the WebSocket closes
 *     and the agent shows as offline.
 */

// TODO (A): steps 1-4 above.
export {};
