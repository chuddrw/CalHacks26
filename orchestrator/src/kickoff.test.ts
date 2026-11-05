/**
 * WHAT IT'S FOR: the kickoff mode (npm run test:orchestrator): proposal validation, the pure
 * cowork.owners.json output, feature-only owners, and the Droid kickoff with an injected fake
 * SDK session (read-only permissions, one round of questions, session always closes). No model, no key.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolConfirmationOutcome, ToolConfirmationType, type createSession, type SdkMcpServer } from "@factory/droid-sdk/node";
import { parseOwners, toOwnersJson, writeOwnersProposal } from "../../shared/src/owners.ts";
import { parseProposal, proposalToOwnersFile, type KickoffInput } from "./kickoff.ts";
import { createDroidKickoff } from "./planner.ts";
import { buildKickoffPrompt } from "./prompt.ts";

const input: KickoffInput = {
  goal: "A web app where friends rate hackathon snacks",
  constraints: "React + Node, demo Sunday 9am",
  members: [{ agent: "a", human: "Ana", strengths: "frontend" }, { agent: "b", human: "Ben", strengths: "backend" }],
  worktree: ".",
};

type Options = Parameters<typeof createSession>[0] & {};
function fakeSession(state: { options?: Options; closed: boolean; verdicts: string[]; disabled: string[] }, script: (call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<void>) {
  return (async (options: Options) => {
    state.options = options;
    const server = options.mcpServers![0] as SdkMcpServer;
    const call = (name: string, args: Record<string, unknown>) => Promise.resolve(server.tools.find((t) => t.name === name)!.handler(args));
    const ask = (toolUse: { name: string }, details: Record<string, unknown>) =>
      String(options.permissionHandler!({ toolUses: [{ toolUse, details }], options: [{ value: ToolConfirmationOutcome.ProceedOnce, label: "yes" }, { value: ToolConfirmationOutcome.Cancel, label: "no" }] } as never));
    return {
      listTools: async () => [{ id: "Read" }, { id: "Execute" }],
      updateSettings: async (s: { disabledToolIds: string[] }) => { state.disabled = s.disabledToolIds; },
      async *stream() {
        state.verdicts.push(
          ask({ name: "Read" }, { type: ToolConfirmationType.Execute }),
          ask({ name: "Edit" }, { type: ToolConfirmationType.Edit }),
          ask({ name: "mcp" }, { type: ToolConfirmationType.McpTool, serverName: "cowork-plan", toolName: "propose_owner" }),
          ask({ name: "mcp" }, { type: ToolConfirmationType.McpTool, serverName: "other", toolName: "delete_repo" }),
        );
        await script(call);
        yield { type: "result", success: true, text: "done" };
      },
      close: async () => { state.closed = true; },
    };
  }) as unknown as typeof createSession;
}
const fresh = () => ({ options: undefined as Options | undefined, closed: false, verdicts: [] as string[], disabled: [] as string[] });

test("kickoff tools build a validated proposal, read-only, and the session closes", async () => {
  const state = fresh();
  const replies: string[] = [];
  const kickoff = createDroidKickoff({
    apiKey: "k",
    create: fakeSession(state, async (call) => {
      replies.push(String(await call("propose_owner", { agent: "zed", feature: "x", paths: [] })));
      replies.push(String(await call("propose_owner", { agent: "a", feature: "UI and ratings page", paths: ["./src/ui/"] })));
      replies.push(String(await call("propose_owner", { agent: "b", feature: "API and storage", paths: ["src/api/"] })));
      replies.push(String(await call("propose_owner", { agent: "b", feature: "API", paths: ["src/ui/"] })));
      await call("propose_contract", { path: "src/contracts/rating.ts", description: "Rating type and API shape" });
      await call("propose_first_task", { agent: "a", title: "Rating form", details: "stars + comment", files: ["src/ui/form.tsx", "src/contracts/rating.ts"] });
      await call("propose_first_task", { agent: "b", title: "POST /ratings", details: "", files: ["src/api/ratings.ts"] });
      await call("finish_kickoff", { architecture: "React UI calls a Node API.", summary: "Two owners, one contract." });
    }),
  });
  const steps: string[] = [];
  const result = await kickoff(input, (kind, detail) => steps.push(`${kind}: ${detail}`));
  assert.equal(result.kind, "proposal");
  if (result.kind !== "proposal") return;
  assert.match(replies[0]!, /isn't on the team/);
  assert.match(replies[3]!, /disjoint/);
  assert.deepEqual(result.proposal.owners.map((o) => [o.agent, o.human, o.paths]), [["a", "Ana", ["src/ui/"]], ["b", "Ben", ["src/api/"]]]);
  assert.equal(result.proposal.contracts[0]!.path, "src/contracts/rating.ts");
  assert.equal(result.proposal.firstTasks.length, 2);
  assert.equal(result.proposal.summary, "Two owners, one contract.");
  assert.deepEqual(state.verdicts, [ToolConfirmationOutcome.ProceedOnce, ToolConfirmationOutcome.Cancel, ToolConfirmationOutcome.ProceedOnce, ToolConfirmationOutcome.Cancel].map(String));
  assert.ok(state.disabled.includes("Execute"));
  assert.ok(state.closed);
  assert.ok(steps.some((s) => s.startsWith("status:")));
});

test("ask_clarification ends the session with questions, once; with answers it is refused", async () => {
  const state = fresh();
  let second = "";
  const result = await createDroidKickoff({
    apiKey: "k",
    create: fakeSession(state, async (call) => {
      await call("ask_clarification", { questions: ["Mobile or web?", "Auth needed?"] });
      second = String(await call("ask_clarification", { questions: ["More?"] }));
    }),
  })(input, () => {});
  assert.deepEqual(result, { kind: "questions", questions: ["Mobile or web?", "Auth needed?"] });
  assert.match(second, /Only one round/);
  assert.ok(state.closed);

  let refused = "";
  const answered = fresh();
  await assert.rejects(createDroidKickoff({
    apiKey: "k",
    create: fakeSession(answered, async (call) => { refused = String(await call("ask_clarification", { questions: ["Again?"] })); }),
  })({ ...input, answers: "Web, no auth" }, () => {}), /without proposing any owner/);
  assert.match(refused, /already asked once/);
  assert.match(buildKickoffPrompt({ ...input, answers: "Web, no auth" }), /Don't ask again/);
  assert.match(buildKickoffPrompt(input), /one round/);
  assert.ok(answered.closed);
});

test("no key or no members fails with a reason", async () => {
  await assert.rejects(createDroidKickoff({ apiKey: "" })(input, () => {}), /FACTORY_API_KEY/);
  await assert.rejects(createDroidKickoff({ apiKey: "k" })({ ...input, members: [] }, () => {}), /at least one team member/);
});

test("parseProposal rejects duplicates, unknown agents and tasks outside ownership", () => {
  const ok = { architecture: "x", owners: [{ agent: "a", human: "Ana", feature: "UI", paths: ["src/ui/"] }], contracts: [{ path: "src/contracts/" }], firstTasks: [{ agent: "a", title: "t", files: ["src/ui/a.ts"] }] };
  assert.equal(parseProposal(ok).owners.length, 1);
  assert.throws(() => parseProposal({ ...ok, owners: [...ok.owners, ...ok.owners] }), /appears twice/);
  assert.throws(() => parseProposal(ok, ["b"]), /isn't on the team/);
  assert.throws(() => parseProposal({ ...ok, firstTasks: [{ agent: "a", title: "t", files: ["src/api/x.ts"] }] }), /don't own/);
  assert.throws(() => parseProposal({ ...ok, firstTasks: [{ agent: "q", title: "t" }] }), /owns nothing/);
  assert.throws(() => parseProposal({ owners: [] }), /Invalid kickoff proposal/);
});

test("toOwnersJson round-trips through parseOwners, including feature-only owners with no paths", () => {
  const text = toOwnersJson({ shared: ["src/contracts/"], owners: [{ agent: "a", human: "Ana", feature: "UI", paths: [] }, { agent: "b", human: "Ben", feature: "API", paths: ["src/api/"] }] }, "notes");
  const back = parseOwners(text);
  assert.deepEqual(back.owners.map((o) => [o.agent, o.paths]), [["a", []], ["b", ["src/api/"]]]);
  assert.deepEqual(back.shared, ["src/contracts/"]);
  assert.equal(JSON.parse(text).about, "notes");
});

test("writeOwnersProposal and proposalToOwnersFile return text and a diff and never write", () => {
  const proposal = parseProposal({ architecture: "arch", owners: [{ agent: "a", human: "Ana", feature: "UI", paths: ["src/ui/"] }], contracts: [{ path: "src/contracts/" }] });
  const fresh1 = proposalToOwnersFile(proposal);
  assert.ok(fresh1.changed);
  assert.ok(fresh1.diff.split("\n").every((line) => line.startsWith("+ ")));
  const same = writeOwnersProposal({ owners: proposal.owners, shared: ["src/contracts/"], about: "arch" }, fresh1.text);
  assert.equal(same.changed, false);
  assert.equal(same.diff, "");
  const edited = writeOwnersProposal({ owners: [{ ...proposal.owners[0]!, feature: "Everything UI" }], shared: ["src/contracts/"], about: "arch" }, fresh1.text);
  assert.match(edited.diff, /- .*"UI"/);
  assert.match(edited.diff, /\+ .*Everything UI/);
});
