/**
 * module/src/index.ts
 *
 * WHAT IT'S FOR
 *   The SpacetimeDB module: the code that runs inside our hosted database. It defines every
 *   table and reducer in shared/src/schema.ts, and it is the only place team state changes.
 *   Hooks, the watcher, the MCP server and the UI are all clients of this module. There is no
 *   other backend server.
 *
 * OWNER: C.
 * WHEN: tonight, publish every table with stub reducers so the others can code against it.
 *       Sat 9:20-13:00, the real reducers.
 * DONE WHEN: `npm run module:generate` produces bindings that match shared/src/schema.ts, and
 *            scripts/seed-fake.ts can fill every table.
 *
 * VERSION
 *   Pick SpacetimeDB 1.12 or 2.0 at hour 0 and write it in external/spacetimedb-maincloud.txt.
 *   The reducer syntax differs between them:
 *     1.12:  spacetimedb.reducer("post_snapshot", { agent: t.string(), ... }, (ctx, args) => { ... })
 *     2.0:   spacetimedb.reducer({ agent: t.string(), ... }, (ctx, args) => { ... })
 *   Start from the code `spacetime init --lang typescript` generates and copy its import style.
 *
 * TABLES (public unless marked private; column order MUST match shared/src/schema.ts)
 *   agent            pk name
 *   snapshot         pk id (auto-increment)
 *   intent           pk id (auto-increment)
 *   check_run        pk runKey
 *   conflict         pk id (auto-increment). Index on pair, for the "open conflict for this pair" lookup.
 *   inbox            pk id (auto-increment). Index on agent.
 *   diagnosis_step   pk id (auto-increment). Index on conflictId.
 *   agent_connection PRIVATE. pk identity (the connection's ctx.sender), plus agent name.
 *                    Written by register_agent, read by client_disconnected.
 *   escalation_timer PRIVATE schedule table. Columns: scheduled id, scheduled time, conflictId.
 *                    Calls `escalate` at its scheduled time.
 *
 * CONSTANTS
 *   ESCALATE_MINUTES = 5. The module can't read .env, so change it here.
 *   Times: store milliseconds since the epoch as u64, computed from ctx.timestamp.
 *
 * REDUCERS (arguments in the order of ReducerArgs in shared/src/schema.ts)
 *   register_agent(agent)
 *     Upsert the agent row with online = true (status "green" if new). Upsert agent_connection
 *     with ctx.sender -> agent.
 *   post_snapshot(agent, sha, baseSha, files, diff)
 *     Insert a snapshot row. Upsert the agent: status "working", files, lastSnapshotAt = now.
 *   post_intent(agent, summary, files, symbols)
 *     Insert an intent with verified = false. Set agent.intent = summary. For every OTHER agent,
 *     insert an inbox row: kind "heads_up", message "<agent> plans: <summary> (files: ...)".
 *   report_check(runKey, agents, result, log)
 *     Upsert the check_run row. If green: set each listed agent to "green", unless it still has
 *     an open or escalated conflict.
 *   report_conflict(kind, agentA, agentB, locA, locB, error, fixer, runKey)
 *     ONE TRANSACTION, the reason SpacetimeDB is the right place for this:
 *       - find the conflict with this pair (pairKey) and status open/escalated
 *       - none: insert it (status "open", explanation "", resolvedAt 0), insert a "conflict" inbox
 *         row for the fixer and an "info" row for the other agent (none for kind "self"), and
 *         insert an escalation_timer row for now + ESCALATE_MINUTES
 *       - exists: update locA, locB, error, fixer, runKey. If the error text changed, insert a new
 *         "conflict" inbox row for the fixer starting "Still red after your last change."
 *       - set agentA and agentB to status "red"
 *   add_diagnosis_step(conflictId, source, kind, detail)
 *     Insert a diagnosis_step row.
 *   set_explanation(conflictId, explanation)
 *     Set conflict.explanation. The hooks build the fixer's message from the conflict row when
 *     they deliver it, so nothing else is needed while that "conflict" inbox row is undelivered.
 *     If it was already delivered, insert an "info" row for the fixer:
 *     "Diagnosis for conflict #<id>: <explanation>".
 *
 *   Inbox message text: keep it short ("Conflict #12: you are the fixer", "<agent> plans: ...").
 *   hooks/src/lib/format.ts turns rows into the full wording agents see.
 *   resolve_conflict(conflictId, verifiedFact)
 *     Status "resolved", resolvedAt = now. Set both agents "green" unless they have another open
 *     conflict. If verifiedFact isn't empty: insert an intent (agent WATCHER_NAME, verified = true)
 *     and a "fact" inbox row for every agent.
 *   flag_needs_human(conflictId, reason)
 *     Status "needs_human". "info" inbox row to both agents: a person will look at it, and tests
 *     must not be edited to make a check pass.
 *   send_note(agent, kind, message)
 *     Insert one inbox row for that agent. Used by the watcher's dependency heads-up.
 *   mark_delivered(inboxIds)
 *     Set delivered = true on each row.
 *   reset_all()
 *     Delete every row in every table. Demo only (scripts/demo-reset.ts).
 *   escalate(timer row)            scheduled; reject calls whose sender isn't the module itself
 *     If the conflict is still "open", set it to "escalated". The UI shows it to the humans.
 *
 * LIFECYCLE
 *   client_disconnected: look up agent_connection by ctx.sender. If found, set that agent's
 *   online = false and delete the agent_connection row.
 *
 * SECURITY (say this in Q&A)
 *   Any client that knows the database name can call these reducers. That's fine for a
 *   hackathon demo. A real version would check ctx.sender against registered identities.
 */

// TODO (C): replace this line with the tables and reducers above, in the syntax of the chosen version.
export {};
