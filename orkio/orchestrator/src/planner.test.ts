/**
 * WHAT IT'S FOR: the Droid planner with an injected fake SDK session (npm run test:orchestrator):
 * the plan tools record and validate, the permission handler allows only reads and our own tools,
 * write tools are disabled before the first turn, and the session always closes. No model, no key.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolConfirmationOutcome, ToolConfirmationType, type createSession, type SdkMcpServer } from "@factory/droid-sdk/node";
import { parseOwners } from "../../shared/src/owners.ts";
import type { RequestRow } from "../../shared/src/schema.ts";
import { createDroidPlanner, type PlannerInput } from "./planner.ts";

const owners = parseOwners(JSON.stringify({
  shared: ["src/contracts/"],
  owners: [{ agent: "a", paths: ["src/users/"] }, { agent: "b", paths: ["src/sessions/"] }],
}));
const request: RequestRow = { id: 7, agent: "a", body: "The frontend needs lastLogin in milliseconds", status: "planning", summary: "", plan: "", createdAt: 1, updatedAt: 1 };
const input: PlannerInput = { request, requesterHuman: "A", owners, worktree: ".", teamStatus: async () => "## Who owns what\n- a\n- b" };

type Options = Parameters<typeof createSession>[0] & {};
interface Fake {
  options?: Options;
  disabled: string[];
  closed: boolean;
  verdicts: string[];
}

function fakeSession(fake: Fake, script: (call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<void>) {
  return (async (options: Options) => {
    fake.options = options;
    const server = options.mcpServers![0] as SdkMcpServer;
    const call = (name: string, args: Record<string, unknown>) => Promise.resolve(server.tools.find((t) => t.name === name)!.handler(args));
    const ask = (toolUse: { name: string }, details: Record<string, unknown>) =>
      String(options.permissionHandler!({ toolUses: [{ toolUse, details }], options: [{ value: ToolConfirmationOutcome.ProceedOnce, label: "yes" }, { value: ToolConfirmationOutcome.Cancel, label: "no" }] } as never));
    return {
      listTools: async () => [{ id: "Read" }, { id: "Grep" }, { id: "Execute" }, { id: "WebSearch" }],
      updateSettings: async (settings: { disabledToolIds: string[] }) => {
        fake.disabled = settings.disabledToolIds;
      },
      async *stream() {
        fake.verdicts.push(
          ask({ name: "Read" }, { type: ToolConfirmationType.Execute }),
          ask({ name: "Edit" }, { type: ToolConfirmationType.Edit }),
          ask({ name: "Execute" }, { type: ToolConfirmationType.Execute, command: "rm -rf /", fullCommand: "rm -rf /" }),
          ask({ name: "mcp" }, { type: ToolConfirmationType.McpTool, serverName: "cowork-plan", toolName: "assign_task" }),
          ask({ name: "mcp" }, { type: ToolConfirmationType.McpTool, serverName: "someone-else", toolName: "delete_repo" }),
        );
        yield { type: "assistant", text: "Reading the team's state" };
        yield { type: "tool_call", name: "team_status", input: {} };
        await script(call);
        yield { type: "result", success: true, text: "done" };
      },
      close: async () => {
        fake.closed = true;
      },
    };
  }) as unknown as typeof createSession;
}

test("Droid's tool calls become a validated plan, with read-only permissions and a closed session", async () => {
  const fake: Fake = { disabled: [], closed: false, verdicts: [] };
  const replies: unknown[] = [];
  const planner = createDroidPlanner({
    apiKey: "test-key",
    create: fakeSession(fake, async (call) => {
      replies.push(await call("team_status", {}));
      replies.push(await call("assign_task", { agent: "zed", title: "x", details: "", files: [], major: false }));
      replies.push(await call("assign_task", { agent: "a", title: "lastLogin in ms", details: "contract + users", files: ["src/contracts/user.ts"], major: true }));
      replies.push(await call("assign_task", { agent: "b", title: "sessions read ms", details: "", files: ["src/sessions/session.ts"], major: false }));
      replies.push(await call("request_review", { reviewer: "a", summary: "own request" }));
      replies.push(await call("request_review", { reviewer: "b", summary: "sessions read lastLogin" }));
      replies.push(await call("flag_conflict", { agentA: "a", agentB: "b", topic: "lastLogin unit", details: "idle.ts assumes seconds", suggested: "b" }));
      replies.push(await call("finish_plan", { summary: "a changes the unit; b adapts." }));
    }),
  });
  const steps: string[] = [];
  const plan = await planner(input, (kind, detail) => steps.push(`${kind}: ${detail}`));
  assert.equal(plan.summary, "a changes the unit; b adapts.");
  assert.deepEqual(plan.tasks.map((task) => [task.agent, task.major]), [["a", true], ["b", false]]);
  assert.deepEqual(plan.reviews, [{ reviewer: "b", summary: "sessions read lastLogin" }]);
  assert.deepEqual(plan.conflicts, [{ agentA: "a", agentB: "b", topic: "lastLogin unit", details: "idle.ts assumes seconds", suggested: "b" }]);
  assert.match(String(replies[1]), /isn't in cowork\.owners\.json/);
  assert.match(String(replies[4]), /don't review/);
  assert.deepEqual(fake.verdicts, ["proceed_once", "cancel", "cancel", "proceed_once", "cancel"].map((v) => fakeOutcome(v)));
  assert.ok(fake.disabled.includes("Execute") && fake.disabled.includes("WebSearch") && fake.disabled.includes("Edit"));
  assert.ok(!fake.disabled.includes("Read"));
  assert.equal(fake.options?.cwd, ".");
  assert.ok(fake.closed);
  assert.ok(steps.some((step) => step.startsWith("tool_call: team_status")));
});

test("no key, or a session that ends without a plan, fails with a reason and still closes", async () => {
  await assert.rejects(createDroidPlanner({ apiKey: "" })(input, () => {}), /FACTORY_API_KEY/);
  const fake: Fake = { disabled: [], closed: false, verdicts: [] };
  const planner = createDroidPlanner({ apiKey: "k", create: fakeSession(fake, async () => {}) });
  await assert.rejects(planner(input, () => {}), /without a plan/);
  assert.ok(fake.closed);
});

/** The SDK's outcome values, so the assertion above reads as words. */
function fakeOutcome(name: string): string {
  return name === "proceed_once" ? String(ToolConfirmationOutcome.ProceedOnce) : String(ToolConfirmationOutcome.Cancel);
}
