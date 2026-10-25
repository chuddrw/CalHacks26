/**
 * mcp/src/server.ts
 *
 * WHAT IT'S FOR
 *   The MCP server each agent talks to. Claude Code starts one per session over stdio (registered
 *   in the demo clone's .mcp.json by hooks/src/install.ts). Its tools:
 *     ask_orchestrator  your human's request goes to the orchestrator, which assigns the work
 *     post_intent       tell teammates' agents what you're about to change, before you change it
 *     team_status       the team's live state, your tasks and your conflict threads
 *     pull_teammate     bring a teammate's uncommitted change into your working tree
 *     check_with_team   tsc + tests on your work alone, then together with each teammate's work in
 *                       progress; a red pair opens a conflict thread with that teammate
 *     message_teammate  talk to the other agent of a conflict thread (wakes them)
 *     agree             "my side is done and I agree": both agreeing on a green check resolves it
 *     escalate          hand the conflict to both humans (they decide on the dashboard)
 *     complete_task     finish an orchestrator task, on a green check
 *
 * OWNER: A. Since branch feat/orchestrator there's no watcher and no single fixer: the agents check
 *        their own work against their teammates' and settle conflicts with each other directly.
 * DONE WHEN: an MCP client lists the tools; ask_orchestrator stores a request; post_intent reaches
 *            the other agents' inboxes; pull_teammate brings a teammate's wip change into a clone;
 *            check_with_team opens a pair conflict on a red pair; a message wakes the other agent;
 *            two agreements on a green check resolve the conflict (hooks/test/e2e.ts).
 *
 * WHY pull_teammate EXISTS
 *   Your laptop doesn't have a teammate's uncommitted change, so without it you'd adapt blind and
 *   your own tests would go red. Found by simulating the demo with real git on Oct 24.
 *   How it works: git fetch <remote> wip/<agent>; diff from merge-base(<remote>/<main>, FETCH_HEAD);
 *   `git apply --check` first, so a patch that doesn't fit changes nothing. Applied changes are left
 *   unstaged. When the teammate later commits that change to main, `git stash -u && git pull &&
 *   git stash pop` folds the identical lines back in cleanly (tested).
 *
 * WHY check_with_team RUNS HERE
 *   It's the watcher's combined check (checks/), run by the agent that needs the answer, in its own
 *   clone's temporary worktrees. It snapshots first, so it always checks what's on disk right now.
 *   Every combination becomes a check_run row; the module only lets agree and complete_task
 *   through on a current green check, so "tests decide" holds without a central process.
 *
 * PRESENCE
 *   A WebSocket connection with Part C's generated bindings, authenticated as this laptop's user
 *   (shared/src/session-token.ts), calls register_agent on connect and again after every automatic
 *   reconnect. Part C's module then marks the agent online, and its client_disconnected marks it
 *   offline when this server exits. If the WebSocket can't connect (the mock database has none), it
 *   falls back to register_agent over HTTP: the mock accepts that; the real module rejects it,
 *   because it needs a live connection.
 *
 * NOTES
 *   - stdout belongs to the MCP protocol. Log ONLY to stderr (console.error).
 *   - process.cwd() is the folder Claude Code started us in: the demo-app clone.
 *   - Tool descriptions are prompts. Keep them short and concrete: when to call it, what to pass.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config, missingSettings } from "../../shared/src/config.ts";
import { git } from "../../shared/src/git.ts";
import { pairKey, wipBranch, type ConflictRow, type SnapshotRow } from "../../shared/src/schema.ts";
import { callReducer, selectRows, sqlString } from "../../shared/src/stdb-http.ts";
import { sessionToken } from "../../shared/src/session-token.ts";
import { DbConnection } from "../../shared/module_bindings/index.ts";
import { teamStatus } from "../../hooks/src/lib/format.ts";
import { takeSnapshot } from "../../hooks/src/lib/snapshot.ts";
import * as checksGit from "../../checks/src/git.ts";
import { guardFix } from "../../checks/src/guard.ts";
import { checkWithTeam, cleanup, cleanupStale, failuresOf, verdict, type TeamCheckResult } from "../../checks/src/team-check.ts";

const NOT_CONFIGURED = "cowork isn't configured on this laptop: COWORK_NAME or STDB_DB is missing in repo 1's .env (see external/mcp.txt).";
const configured = missingSettings(["agent", "stdbDb"]).length === 0;
const me = config.agent;

function reply(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // The HTTP client reports "call failed: 400 <reason>"; the reason is what the agent needs.
  return text.replace(/^[a-z_]+ failed: \d{3}\s*/i, "");
}

/** Brings `agent`'s latest snapshot into the working tree at `cwd`. Returns a sentence for the agent. */
async function pullTeammate(cwd: string, agent: string): Promise<string> {
  if (agent === me) return "That's your own name. Pass the teammate named in the [cowork] message.";
  const remote = config.gitRemote;
  try {
    await git(cwd, ["fetch", "--quiet", remote, `refs/heads/${wipBranch(agent)}`]);
  } catch {
    return `${agent} has no snapshot yet (no ${wipBranch(agent)} on ${remote}), so there's nothing to pull.`;
  }
  const base = await git(cwd, ["merge-base", `${remote}/${config.mainBranch}`, "FETCH_HEAD"]);
  const files = (await git(cwd, ["diff", "--name-only", base, "FETCH_HEAD"])).split("\n").filter(Boolean);
  if (files.length === 0) return `${agent}'s snapshot has no changes compared with main. Nothing to pull.`;
  const patch = await git(cwd, ["diff", "--binary", base, "FETCH_HEAD"], { raw: true });

  try {
    await git(cwd, ["apply", "--check"], { input: patch });
  } catch {
    try {
      await git(cwd, ["apply", "--check", "--reverse"], { input: patch });
      return `${agent}'s change is already in your working tree (${files.join(", ")}). Adapt your own files and run check_with_team.`;
    } catch {
      return `Couldn't apply ${agent}'s change cleanly: you both edited the same lines in ${files.join(", ")}. Nothing was changed. Agree with ${agent} in your conflict thread who changes what.`;
    }
  }
  await git(cwd, ["apply"], { input: patch });
  return `Pulled ${agent}'s in-progress change into your working tree (${files.length} file${files.length > 1 ? "s" : ""}: ${files.join(", ")}). Keep their changes exactly as pulled, adapt your own files, and run check_with_team.`;
}

// ---- check_with_team ----------------------------------------------------------------------------

function latestByAgent(rows: SnapshotRow[]): Map<string, SnapshotRow> {
  const latest = new Map<string, SnapshotRow>();
  for (const row of rows) {
    const previous = latest.get(row.agent);
    if (!previous || row.id > previous.id) latest.set(row.agent, row);
  }
  return latest;
}

let repoReady: Promise<string> | null = null;
/** The clone's root, set as the checks' repo once; stale worktrees from a killed server are removed. */
function clone(cwd: string): Promise<string> {
  repoReady ??= (async () => {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    checksGit.useRepo(root);
    await cleanupStale().catch(() => undefined);
    return root;
  })();
  return repoReady;
}

let running: Promise<unknown> = Promise.resolve();
/** One check at a time per agent; a second call waits for the first. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = running.then(work, work);
  running = next.catch(() => undefined);
  return next;
}

function indentLines(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n");
}

interface TeamCheck {
  result: TeamCheckResult;
  /** true when my change or any pair with it is red. */
  red: boolean;
  text: string;
}

async function teamCheck(cwd: string): Promise<TeamCheck> {
  return serial(async () => {
    const root = await clone(cwd);
    const snapshot = await takeSnapshot(root, me);
    if (snapshot) await callReducer("post_snapshot", [me, snapshot.sha, snapshot.baseSha, snapshot.files, snapshot.diff]);
    const latest = latestByAgent(await selectRows("snapshot"));
    const result = await checkWithTeam(me, latest, {
      reportCheck: (...args) => callReducer("report_check", args),
      reportConflict: (...args) => callReducer("report_conflict", args),
    });
    const lines = [`check_with_team on main ${result.main.slice(0, 8)}:`];
    const { verdict: outcome, with: partners } = verdict(result);
    const conflicts = await selectRows("conflict");
    if (!result.mine) {
      lines.push("You have no uncommitted changes compared with main, so nothing of yours can clash. Nothing to check.");
    } else {
      lines.push(result.mine.red
        ? `- your change alone: RED.\n${indentLines(failuresOf(result.mine.outcome) || `merge conflict in ${result.mine.mergeFiles.join(", ")}`)}`
        : `- your change alone: green (${result.mine.seconds.toFixed(1)} s)`);
      for (const pair of result.pairs) {
        if (!pair.run.red) {
          lines.push(`- with ${pair.teammate}: green`);
        } else if (pair.theirsFailsAlone) {
          lines.push(`- with ${pair.teammate}: red, but ${pair.teammate}'s change fails on its own too, so that's theirs to fix first.`);
        } else if (pair.clash) {
          const open = conflicts.find((c) => c.pair === pairKey(me, pair.teammate) && c.status !== "resolved");
          lines.push(`- with ${pair.teammate}: RED. ${pair.clash.error.split("\n")[0]}${pair.clash.locA ? ` (${pair.clash.locA}${pair.clash.locB ? ` vs ${pair.clash.locB}` : ""})` : ""}`);
          if (open) lines.push(`  Conflict #${open.id} with ${pair.teammate} is ${open.status}. Settle it with message_teammate(${open.id}, ...), then agree(${open.id}, "<fact>").`);
        } else {
          lines.push(`- with ${pair.teammate}: red`);
        }
      }
      if (result.pairs.length === 0) lines.push("No teammate has uncommitted changes right now.");
      lines.push({
        nothing: "",
        green: "Everything you checked is green.",
        together: `Your change fails on its own but passes together with ${partners.join(", ")}: the changes depend on each other, so they land together. That counts as green.`,
        mine_broken: "Your own change fails, alone and with everyone's work. Fix it in your own files, then run check_with_team again.",
        clash: `Your change clashes with ${partners.join(", ")}'s work in progress. Talk to them in the conflict thread.`,
      }[outcome]);
    }
    if (result.missing.length) lines.push(`Couldn't fetch the snapshot of: ${result.missing.join(", ")}.`);
    const red = outcome === "mine_broken" || outcome === "clash";
    return { result, red, text: lines.filter(Boolean).join("\n") };
  });
}

/** The fixer-side test guard (B's guard.ts): a fix that edits an existing test goes to a person. */
async function guardMyChanges(conflict: ConflictRow): Promise<string> {
  const rows = (await selectRows("snapshot")).sort((a, b) => a.id - b.id);
  const mine = rows.filter((row) => row.agent === me);
  const before = mine.filter((row) => row.createdAt <= conflict.createdAt).at(-1);
  const after = mine.at(-1);
  if (!before || !after || before.sha === after.sha) return "";
  if (!(await checksGit.hasCommit(before.sha)) || !(await checksGit.hasCommit(after.sha))) return "";
  const main = await checksGit.mainSha();
  const teammates = [...latestByAgent(rows).values()].filter((row) => row.agent !== me).map((row) => ({ agent: row.agent, sha: row.sha }));
  const edits = await guardFix({ conflict, before: before.sha, after: after.sha, main, teammates }, (id, reason) => callReducer("flag_needs_human", [id, reason]));
  return edits.length ? edits.map((edit) => edit.path).join(", ") : "";
}

async function conflictById(id: number): Promise<ConflictRow | undefined> {
  return (await selectRows("conflict", `id = ${Number(id)}`))[0];
}

// ---- Tools ---------------------------------------------------------------------------------------

const server = new McpServer({ name: "cowork", version: "0.2.0" });

server.registerTool(
  "ask_orchestrator",
  {
    description:
      "Send your human's request to the team's orchestrator, which plans it and assigns each part to the agent that owns that feature (you may get some of it back as a task). Use it when your human asks for something that isn't only your own feature, or says to ask the orchestrator. request: the human's words, plus anything they told you that matters.",
    inputSchema: { request: z.string().min(1) },
  },
  async ({ request }) => {
    if (!configured) return reply(NOT_CONFIGURED, true);
    try {
      await callReducer("submit_request", [me, request]);
      const mineNow = (await selectRows("request", `agent = ${sqlString(me)}`)).sort((a, b) => b.id - a.id)[0];
      return reply(
        `Sent to the orchestrator as request #${mineNow?.id ?? "?"}. It plans it and assigns tasks to the agents that own each feature; the dashboard shows the plan as it forms. A major change waits until the humans whose features it touches approve it there. Tasks for you arrive as [cowork] messages.`,
      );
    } catch (error) {
      return reply(`ask_orchestrator failed: ${errorMessage(error)}`, true);
    }
  },
);

server.registerTool(
  "post_intent",
  {
    description:
      "Tell your teammates' agents what you are about to change and why, BEFORE you change anything other files import: an exported function, a type, or the meaning or unit of a field. summary: one sentence, e.g. 'Changing User.lastLogin from seconds to milliseconds because the frontend needs ms.' files: paths you will touch. symbols: exported names affected.",
    inputSchema: {
      summary: z.string().min(1),
      files: z.array(z.string()).default([]),
      symbols: z.array(z.string()).default([]),
    },
  },
  async ({ summary, files, symbols }) => {
    if (!configured) return reply(NOT_CONFIGURED, true);
    await callReducer("post_intent", [me, summary, files, symbols]);
    return reply("Sent to your teammates. Go ahead with the change.");
  },
);

server.registerTool(
  "team_status",
  {
    description:
      "Get the team's live state: who is working on what, verified facts, recent plans, your open tasks and your conflict threads. Call it when a [cowork] note tells you to, or before a change that crosses into another module.",
  },
  async () => {
    if (!configured) return reply(NOT_CONFIGURED, true);
    const [agents, intents, conflicts, tasks] = await Promise.all([
      selectRows("agent"),
      selectRows("intent"),
      selectRows("conflict"),
      selectRows("task", `agent = ${sqlString(me)}`),
    ]);
    intents.sort((a, b) => a.createdAt - b.createdAt);
    const mine = conflicts.filter((c) => (c.status === "open" || c.status === "escalated") && (c.agentA === me || c.agentB === me));
    const open = tasks.filter((t) => t.status === "assigned" || t.status === "waiting_review").sort((a, b) => a.id - b.id);
    return reply(teamStatus(agents, intents, mine, open, me));
  },
);

server.registerTool(
  "pull_teammate",
  {
    description:
      "Bring a teammate's in-progress (uncommitted) change into your working tree, so you can run the tests on both changes together. Use it in a conflict thread, with the teammate's name from the [cowork] message.",
    inputSchema: { agent: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) },
  },
  async ({ agent }) => {
    try {
      return reply(await pullTeammate(process.cwd(), agent));
    } catch (error) {
      return reply(`pull_teammate failed: ${errorMessage(error)}`, true);
    }
  },
);

server.registerTool(
  "check_with_team",
  {
    description:
      "Run the type check and the tests on your work right now: alone, then together with each teammate's work in progress. Use it before agree or complete_task, and whenever you want to know if your change breaks someone. A red pair opens a conflict thread with that teammate.",
  },
  async () => {
    if (!configured) return reply(NOT_CONFIGURED, true);
    try {
      return reply((await teamCheck(process.cwd())).text);
    } catch (error) {
      return reply(`check_with_team failed: ${errorMessage(error)}`, true);
    }
  },
);

server.registerTool(
  "message_teammate",
  {
    description:
      "Say something to the other agent of a conflict thread: what you're changing, what you need from them, or a proposal for who changes what. It wakes them. conflictId: the number from the [cowork] CONFLICT message.",
    inputSchema: { conflictId: z.number().int().positive(), message: z.string().min(1) },
  },
  async ({ conflictId, message }) => {
    if (!configured) return reply(NOT_CONFIGURED, true);
    try {
      await callReducer("post_message", [conflictId, me, "message", message]);
      const conflict = await conflictById(conflictId);
      const other = conflict ? (conflict.agentA === me ? conflict.agentB : conflict.agentA) : "your teammate";
      if (conflict?.status === "escalated") return reply(`Sent, and that was the thread's last allowed message: conflict #${conflictId} went to both humans. Wait for their decision; it will wake you.`);
      return reply(`Sent to ${other}; it wakes them. Their answer will wake you. Meanwhile keep working in your own files.`);
    } catch (error) {
      return reply(`message_teammate failed: ${errorMessage(error)}`, true);
    }
  },
);

server.registerTool(
  "agree",
  {
    description:
      "Say you agree and your side of a conflict is done. It runs check_with_team first and only sends your agreement on a green check. When both agents have agreed on a green check, the conflict is resolved and `fact` (one sentence you both now treat as true, e.g. 'User.lastLogin is milliseconds since the Unix epoch') goes into the team's shared memory.",
    inputSchema: { conflictId: z.number().int().positive(), fact: z.string().min(1) },
  },
  async ({ conflictId, fact }) => {
    if (!configured) return reply(NOT_CONFIGURED, true);
    try {
      const conflict = await conflictById(conflictId);
      if (!conflict) return reply(`There's no conflict #${conflictId}.`, true);
      if (conflict.status !== "open") return reply(`Conflict #${conflictId} is ${conflict.status}; there's nothing to agree on right now.`, true);
      const other = conflict.agentA === me ? conflict.agentB : conflict.agentA;
      const check = await teamCheck(process.cwd());
      const tests = await guardMyChanges(conflict);
      if (tests) {
        return reply(`Not sent: since this conflict opened you changed existing tests (${tests}). A person now reviews that on the dashboard; the conflict waits for them. Tests are the team's shared contract.`, true);
      }
      // What matters is the two of you together (or my change alone, when the other has none).
      const pair = check.result.pairs.find((p) => p.teammate === other);
      const together = pair ? !pair.run.red : !check.result.mine?.red;
      if (check.result.mine && !together) {
        return reply(`${check.text}\nNot sent: agree only works when your work and ${other}'s pass together. Fix your side, or tell ${other} what you need with message_teammate(${conflictId}, ...).`, true);
      }
      await callReducer("post_message", [conflictId, me, "agree", fact]);
      const after = await conflictById(conflictId);
      if (after?.status === "resolved") return reply(`${check.text}\nResolved: you and ${other} both agreed on a green check. Verified fact for the team: ${fact}`);
      return reply(`${check.text}\nSent your agreement to ${other}. The conflict resolves when they agree too, on a check that's still green.`);
    } catch (error) {
      return reply(`agree failed: ${errorMessage(error)}`, true);
    }
  },
);

server.registerTool(
  "escalate",
  {
    description:
      "Hand a conflict to both humans when you and the other agent can't agree, for example when the fix would change how your human's feature behaves. They decide on the dashboard and the decision wakes you both. reason: one or two sentences with both positions.",
    inputSchema: { conflictId: z.number().int().positive(), reason: z.string().min(1) },
  },
  async ({ conflictId, reason }) => {
    if (!configured) return reply(NOT_CONFIGURED, true);
    try {
      await callReducer("post_message", [conflictId, me, "escalate", reason]);
      return reply(`Conflict #${conflictId} went to both humans. Stop changing code for it and tell your human; their decision on the dashboard will wake you.`);
    } catch (error) {
      return reply(`escalate failed: ${errorMessage(error)}`, true);
    }
  },
);

server.registerTool(
  "complete_task",
  {
    description:
      "Mark a task from the orchestrator as done. It runs check_with_team first and only completes on a green check. taskId: the number from the [cowork] TASK message. summary: one line on what you changed.",
    inputSchema: { taskId: z.number().int().positive(), summary: z.string().min(1) },
  },
  async ({ taskId, summary }) => {
    if (!configured) return reply(NOT_CONFIGURED, true);
    try {
      const check = await teamCheck(process.cwd());
      if (check.red) return reply(`${check.text}\nNot complete: the check is red. Fix your own change, or settle the conflict thread with your teammate first.`, true);
      await callReducer("complete_task", [taskId, me, summary]);
      return reply(`${check.text}\nTask #${taskId} is done. The human who asked gets your summary.`);
    } catch (error) {
      return reply(`complete_task failed: ${errorMessage(error)}`, true);
    }
  },
);

/** Keeps a WebSocket open as this agent so the module shows it online, and offline once we exit. */
async function startPresence(): Promise<void> {
  const token = await sessionToken();
  if (!token) console.error("[cowork] No SpacetimeDB session token: run `spacetime login` (see module/ACCESS.md).");
  const register = (connection: DbConnection) => {
    connection.reducers.registerAgent({ agent: me }).catch((error: unknown) => {
      console.error(`[cowork] register_agent failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  DbConnection.builder()
    .withUri(config.stdbHost)
    .withDatabaseName(config.stdbDb)
    .withToken(token || undefined)
    .withAutomaticReconnect()
    .onConnect((connection) => register(connection))
    .onAutomaticReconnect((connection) => register(connection))
    .onConnectError((_ctx, error) => {
      console.error(`[cowork] presence WebSocket failed (${error.message}); trying register_agent over HTTP instead.`);
      callReducer("register_agent", [me]).catch(() => undefined);
    })
    .build();
}

if (configured) {
  startPresence().catch((error: unknown) => console.error(`[cowork] presence failed: ${String(error)}`));
} else {
  console.error(`[cowork] ${NOT_CONFIGURED}`);
}

// Remove this session's check worktrees before exiting (they live under the OS temp folder).
process.stdin.on("end", () => {
  const done = repoReady ? cleanup().catch(() => undefined) : Promise.resolve();
  void done.then(() => process.exit(0));
});
await server.connect(new StdioServerTransport());
