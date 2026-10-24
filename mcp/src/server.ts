/**
 * mcp/src/server.ts
 *
 * WHAT IT'S FOR
 *   The MCP server each agent talks to. Claude Code starts one per session over stdio (registered
 *   in the demo clone's .mcp.json by hooks/src/install.ts). It gives the agent three tools:
 *     post_intent    tell teammates' agents what you're about to change, before you change it
 *     team_status    the team's live state, for when the agent wants more than the hooks injected
 *     pull_teammate  bring a teammate's uncommitted change into your working tree, to fix a conflict
 *
 * OWNER: A.
 * DONE WHEN: an MCP client lists the 3 tools, post_intent reaches the other agents' inboxes, and
 *            pull_teammate brings a teammate's wip change into a clone (hooks/test/e2e.ts checks all three).
 *
 * WHY pull_teammate EXISTS
 *   The fixer's laptop doesn't have the teammate's uncommitted change, so without it the fixer would
 *   "fix" blind and its own tests would go red. Found by simulating the demo with real git on Oct 24.
 *   How it works: git fetch <remote> wip/<agent>; diff from merge-base(<remote>/<main>, FETCH_HEAD);
 *   `git apply --check` first, so a patch that doesn't fit changes nothing. Applied changes are left
 *   unstaged. When the teammate later commits that change to main, `git stash -u && git pull &&
 *   git stash pop` folds the identical lines back in cleanly (tested).
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
import { wipBranch } from "../../shared/src/schema.ts";
import { callReducer, selectRows, sqlString } from "../../shared/src/stdb-http.ts";
import { sessionToken } from "../../shared/src/session-token.ts";
import { DbConnection } from "../../shared/module_bindings/index.ts";
import { teamStatus } from "../../hooks/src/lib/format.ts";

const NOT_CONFIGURED = "cowork isn't configured on this laptop: COWORK_NAME or STDB_DB is missing in repo 1's .env (see external/mcp.txt).";
const configured = missingSettings(["agent", "stdbDb"]).length === 0;

function reply(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

/** Brings `agent`'s latest snapshot into the working tree at `cwd`. Returns a sentence for the agent. */
async function pullTeammate(cwd: string, agent: string): Promise<string> {
  if (agent === config.agent) return "That's your own name. Pass the teammate named in the [cowork] conflict message.";
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
      return `${agent}'s change is already in your working tree (${files.join(", ")}). Adapt your own files and run npm test.`;
    } catch {
      return `Couldn't apply ${agent}'s change cleanly: you both edited the same lines in ${files.join(", ")}. Nothing was changed. Ask your human to coordinate with ${agent}'s human.`;
    }
  }
  await git(cwd, ["apply"], { input: patch });
  return `Pulled ${agent}'s in-progress change into your working tree (${files.length} file${files.length > 1 ? "s" : ""}: ${files.join(", ")}). Keep their changes exactly as pulled, adapt your own files, and run npm test.`;
}

const server = new McpServer({ name: "cowork", version: "0.1.0" });

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
    await callReducer("post_intent", [config.agent, summary, files, symbols]);
    return reply("Sent to your teammates. Go ahead with the change.");
  },
);

server.registerTool(
  "team_status",
  {
    description:
      "Get the team's live state: who is working on what, verified facts, recent plans, and any conflict you must fix. Call it when a [cowork] note tells you to, or before a change that crosses into another module.",
  },
  async () => {
    if (!configured) return reply(NOT_CONFIGURED, true);
    const [agents, intents, mine] = await Promise.all([
      selectRows("agent"),
      selectRows("intent"),
      selectRows("conflict", `fixer = ${sqlString(config.agent)} AND status = 'open'`),
    ]);
    intents.sort((a, b) => a.createdAt - b.createdAt);
    return reply(teamStatus(agents, intents, mine));
  },
);

server.registerTool(
  "pull_teammate",
  {
    description:
      "Bring a teammate's in-progress (uncommitted) change into your working tree, so you can run the tests on both changes together. Use it when a [cowork] conflict names you as the fixer, with the teammate's name from that message.",
    inputSchema: { agent: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) },
  },
  async ({ agent }) => {
    try {
      return reply(await pullTeammate(process.cwd(), agent));
    } catch (error) {
      return reply(`pull_teammate failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  },
);

/** Keeps a WebSocket open as this agent so the module shows it online, and offline once we exit. */
async function startPresence(): Promise<void> {
  const token = await sessionToken();
  if (!token) console.error("[cowork] No SpacetimeDB session token: run `spacetime login` (see module/ACCESS.md).");
  const register = (connection: DbConnection) => {
    connection.reducers.registerAgent({ agent: config.agent }).catch((error: unknown) => {
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
      callReducer("register_agent", [config.agent]).catch(() => undefined);
    })
    .build();
}

if (configured) {
  startPresence().catch((error: unknown) => console.error(`[cowork] presence failed: ${String(error)}`));
} else {
  console.error(`[cowork] ${NOT_CONFIGURED}`);
}

process.stdin.on("end", () => process.exit(0));
await server.connect(new StdioServerTransport());
