/**
 * orchestrator/src/planner.ts
 *
 * WHAT IT'S FOR
 *   Droid (Factory's SDK) turns one human's request into a plan. This is where Droid works inside
 *   the product (the Factory prize): our own trigger (a request in the database), our own tools, its
 *   own permission handler, and every step it takes streamed to the dashboard.
 *
 * OWNER: A (branch feat/orchestrator), built on C's Droid adapter (diagnose/droid.ts) and its
 *        read-only command rules (diagnose/permissions.ts).
 * DONE WHEN: on "The frontend needs User.lastLogin in milliseconds", with b's idle feature in
 *            flight, Droid assigns the contract and users change to a, the sessions change to b, and
 *            flags a x b (b's idle.ts assumes seconds).
 *
 * THE SESSION
 *   cwd: a disposable worktree of main. Autonomy off, so every tool use goes through our
 *   permissionHandler, which allows only Read, Grep, Glob and LS plus our own tools (server
 *   "cowork-plan"). Edit, Create, ApplyPatch, Execute, Task and Skill are disabled up front, and every
 *   other built-in tool the session lists is disabled before the first turn. 150-second deadline;
 *   the session is always closed.
 *
 * OUR TOOLS (SDK MCP tools, in this process)
 *   team_status      the team's live state (team.ts), read on demand
 *   assign_task      one task for one owner's agent
 *   request_review   a human whose feature a major task affects
 *   flag_conflict    two agents whose work will probably clash
 *   finish_plan      the summary for the humans; the plan is done
 *   They only record into this request's plan in memory. Nothing reaches the database until
 *   index.ts publishes the whole plan in one transaction, after the contract rule.
 */
import {
  AutonomyLevel,
  createSdkMcpServer,
  createSession,
  ProcessTransport,
  tool,
  ToolConfirmationOutcome,
  ToolConfirmationType,
} from "@factory/droid-sdk/node";
import { z } from "zod";
import { config } from "../../shared/src/config.ts";
import type { Owners } from "../../shared/src/owners.ts";
import type { DiagnosisStepKind, RequestRow } from "../../shared/src/schema.ts";
import { READ_TOOLS } from "./diagnose/permissions.ts";
import { truncateUtf8 } from "./diagnose/text.ts";
import { buildPrompt, SERVER_NAME } from "./prompt.ts";
import type { DraftPlan } from "./rules.ts";

export type OnStep = (kind: DiagnosisStepKind, detail: string) => void;

export interface PlannerInput {
  request: RequestRow;
  requesterHuman: string;
  owners: Owners;
  /** The disposable worktree of main Droid reads. */
  worktree: string;
  /** team.ts describeTeam(), fresh on every call. */
  teamStatus: () => Promise<string>;
}

export type Planner = (input: PlannerInput, onStep: OnStep) => Promise<DraftPlan>;

const TOOL_NAMES = ["team_status", "assign_task", "request_review", "flag_conflict", "finish_plan"];
const DISABLED_UP_FRONT = ["Edit", "Create", "ApplyPatch", "Execute", "Task", "Skill"];

/** The plan tools, recording into `plan`. Exported for tests. */
export function planTools(input: PlannerInput, plan: DraftPlan, state: { finished: boolean }) {
  const agents = new Set(input.owners.owners.map((owner) => owner.agent));
  const known = (agent: string) => (agents.has(agent) ? "" : `${agent} isn't in cowork.owners.json. Owners: ${[...agents].join(", ")}.`);
  const readOnly = { annotations: { readOnlyHint: true } };
  return [
    tool("team_status", "The team's live state: who owns which paths, each agent's status, tasks in flight, every agent's uncommitted work as a diff, open conflicts, verified facts. Call it first.", {}, async () => input.teamStatus(), readOnly),
    tool(
      "assign_task",
      "Give one agent one task. Only files that agent owns, plus a shared contract when the change starts there. Set major for a change to a shared contract or to another owner's feature.",
      {
        agent: z.string().describe("The owner's agent name, e.g. a"),
        title: z.string().describe("One line, e.g. 'Store User.lastLogin in milliseconds'"),
        details: z.string().describe("What to change, why, and which tests must pass"),
        files: z.array(z.string()).describe("Paths the task will change, relative to the repo root"),
        major: z.boolean().describe("true when it changes a shared contract or another owner's feature"),
      },
      async ({ agent, title, details, files, major }) => {
        const problem = known(agent);
        if (problem) return problem;
        if (!title.trim()) return "Give the task a title.";
        plan.tasks.push({ agent, title: title.trim(), details: details.trim(), files, major });
        return `Recorded task ${plan.tasks.length} for ${agent}.`;
      },
      readOnly,
    ),
    tool(
      "request_review",
      "A human whose feature a major task affects must approve before any task starts. Not the requester.",
      { reviewer: z.string().describe("The affected owner's agent name"), summary: z.string().describe("What changes and how it affects their feature") },
      async ({ reviewer, summary }) => {
        const problem = known(reviewer);
        if (problem) return problem;
        if (reviewer === input.request.agent) return "The requester asked for this change, so they don't review it.";
        if (!plan.reviews.some((review) => review.reviewer === reviewer)) plan.reviews.push({ reviewer, summary: summary.trim() });
        return `Recorded: ${reviewer}'s human reviews this plan before it starts.`;
      },
      readOnly,
    ),
    tool(
      "flag_conflict",
      "Two agents' work will probably clash (for example a new task changes a field another agent's in-progress code relies on). They settle it with each other.",
      {
        agentA: z.string(),
        agentB: z.string(),
        topic: z.string().describe("A few words, e.g. 'lastLogin unit'"),
        details: z.string().describe("What exactly will clash, and where"),
        suggested: z.string().describe("The agent that probably adapts"),
      },
      async ({ agentA, agentB, topic, details, suggested }) => {
        const problem = known(agentA) || known(agentB);
        if (problem) return problem;
        if (agentA === agentB) return "A conflict needs two different agents.";
        plan.conflicts.push({ agentA, agentB, topic: topic.trim(), details: details.trim(), suggested: suggested === agentA ? agentA : agentB });
        return `Recorded a potential conflict between ${agentA} and ${agentB}.`;
      },
      readOnly,
    ),
    tool(
      "finish_plan",
      "The plan is complete. A summary of 2 to 4 sentences for the humans. Stop after this.",
      { summary: z.string() },
      async ({ summary }) => {
        plan.summary = summary.trim();
        state.finished = true;
        return "Plan recorded. You're done: stop now.";
      },
      readOnly,
    ),
  ];
}

/** Read-only built-in tools and our own tools; everything else is refused. */
function allowed(toolUses: Array<{ toolUse: { name: string }; details: { type: string; serverName?: string; toolName?: string } }>): boolean {
  return toolUses.length > 0 && toolUses.every(({ toolUse, details }) => {
    if (details.type === ToolConfirmationType.McpTool) {
      const name = details.toolName ?? toolUse.name;
      return details.serverName === SERVER_NAME || TOOL_NAMES.some((ours) => name === ours || name.endsWith(`__${ours}`));
    }
    return READ_TOOLS.has(toolUse.name) && details.type !== ToolConfirmationType.SandboxViolation;
  });
}

/**
 * The droid CLI, started so its sessions call tools directly. The CLI's default tool surface is
 * "script_only": the model writes a script that calls the tools, which needs the Script tool, and
 * we disable that (it runs code). createSession has no option for the mode, so the session's
 * initialize request gets toolExecutionMode "direct_only" here; every tool call then goes through
 * our permissionHandler one by one. Found on the first real run (Oct 24): with Script disabled,
 * Droid reported that no tools were available.
 */
async function directToolTransport(cwd: string, apiKey: string): Promise<ProcessTransport> {
  const transport = new ProcessTransport({ cwd, env: { FACTORY_API_KEY: apiKey, FACTORY_UPSTREAM_CLIENT_TYPE: "sdk" } });
  await transport.connect();
  const send = transport.send.bind(transport);
  transport.send = (message) => {
    const request = message as { method?: string; params?: Record<string, unknown> };
    if (request.method === "droid.initialize_session" && request.params) {
      return send({ ...message, params: { ...request.params, toolExecutionMode: "direct_only" } } as typeof message);
    }
    return send(message);
  };
  return transport;
}

/** Injectable SDK seam for tests; production uses the installed SDK and FACTORY_API_KEY. */
export function createDroidPlanner(options: { create?: typeof createSession; apiKey?: string; timeoutMs?: number } = {}): Planner {
  return async (input, onStep) => {
    const apiKey = options.apiKey ?? config.factoryApiKey;
    if (!apiKey) throw new Error("FACTORY_API_KEY is not set on the orchestrator's laptop, so Droid can't plan.");
    const step: OnStep = (kind, detail) => onStep(kind, truncateUtf8(detail, 2048));
    const plan: DraftPlan = { summary: "", tasks: [], reviews: [], conflicts: [] };
    const state = { finished: false };
    const server = createSdkMcpServer({ name: SERVER_NAME, tools: planTools(input, plan, state) });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Droid planning timed out")), options.timeoutMs ?? 150_000);
    let session: Awaited<ReturnType<typeof createSession>> | undefined;
    let lastText = "";
    try {
      // Tests inject `create` (a fake session); the real one gets the direct-tools transport.
      const transport = options.create ? undefined : await directToolTransport(input.worktree, apiKey);
      session = await (options.create ?? createSession)({
        ...(transport ? { transport } : {}),
        cwd: input.worktree,
        apiKey,
        ...(config.droidModelId ? { modelId: config.droidModelId } : {}),
        abortSignal: controller.signal,
        autonomyLevel: AutonomyLevel.Off,
        disableBuiltinSkills: true,
        disabledToolIds: DISABLED_UP_FRONT,
        mcpServers: [server],
        permissionHandler({ toolUses, options: offered }) {
          const yes = allowed(toolUses as Parameters<typeof allowed>[0]);
          if (!yes) step("error", `Refused: ${toolUses.map(({ toolUse }) => toolUse.name).join(", ")}`);
          return yes && offered.some((option) => option.value === ToolConfirmationOutcome.ProceedOnce)
            ? ToolConfirmationOutcome.ProceedOnce
            : ToolConfirmationOutcome.Cancel;
        },
      });
      // Disable every built-in tool that isn't a read tool, before the first turn.
      const tools = await session.listTools();
      const disabled = tools.filter((t) => !READ_TOOLS.has(t.id) && !TOOL_NAMES.some((ours) => t.id.endsWith(ours))).map((t) => t.id);
      if (disabled.length) await session.updateSettings({ disabledToolIds: [...new Set([...DISABLED_UP_FRONT, ...disabled])] });
      step("status", "Droid is reading the request and the team's state");
      for await (const message of session.stream(buildPrompt(input.request, input.requesterHuman), { abortSignal: controller.signal })) {
        switch (message.type) {
          case "assistant":
            lastText = message.text;
            step("thought", message.text);
            break;
          case "tool_call":
            step("tool_call", `${message.name} ${JSON.stringify(message.input)}`);
            break;
          case "tool_result":
            step("tool_result", JSON.stringify(message.content).slice(0, 300));
            break;
          case "error":
            step("error", message.message);
            break;
          case "result":
            if (!message.success && !state.finished) throw new Error(`Droid stopped: ${message.error?.message ?? message.subtype}`);
            if (!lastText && message.text) lastText = message.text;
            break;
        }
        if (state.finished) break;
      }
    } catch (error) {
      if (!state.finished) {
        throw new Error(controller.signal.aborted ? "Droid planning timed out" : `Droid planning failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      clearTimeout(timer);
      await session?.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
    if (!state.finished && plan.tasks.length === 0) throw new Error("Droid ended without a plan.");
    if (!plan.summary) plan.summary = lastText.slice(0, 1000) || `${plan.tasks.length} task(s) for ${[...new Set(plan.tasks.map((task) => task.agent))].join(", ")}.`;
    return plan;
  };
}
