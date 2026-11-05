/**
 * bench/planner-golden/run-planner.ts
 *
 * WHAT IT'S FOR: runs the REAL OpenRouter planner on every request in cases.json and saves the plans for
 * score-plans.ts, plus the tokens and dollars each setup spent. This is how to check that a cheaper model setup
 * stays as accurate as the strong one.
 *
 * USAGE (needs OPENROUTER_API_KEY in .env; costs real money, about $0.02-0.07 per case with the strong model)
 *   node bench/planner-golden/run-planner.ts --config strong --out bench/results/plans-strong.json
 *   node bench/planner-golden/run-planner.ts --config tiered --out bench/results/plans-tiered.json
 *   node bench/planner-golden/score-plans.ts bench/results/plans-tiered.json
 *   --config strong    OPENROUTER_MODEL only
 *   --config tiered    OPENROUTER_MODEL_FAST first, OPENROUTER_MODEL when the plan is hard (override with --fast <id>)
 *   --limit N          first N cases; --concurrency N (default 4)
 *
 * HONEST LIMITS: the planner sees a static "nothing in flight" team state, so the labeled conflicts (which depend on
 * other agents' work) are mostly out of its reach; compare configs against each other rather than reading the
 * absolute conflict score. The plans scored are the model's raw plans, before rules.ts adds the contract rule.
 * One run per case: model output varies, so small differences are noise.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOwners } from "../../shared/src/owners.ts";
import { createOpenRouterPlanner, createTieredPlanner } from "../../orchestrator/src/openrouter.ts";
import { loadCases } from "./run-rules.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback);
const configName = arg("--config", "strong");
const out = path.resolve(arg("--out", path.join(here, `../results/plans-${configName}.json`)));
const concurrency = Math.max(1, Number(arg("--concurrency", "4")));
const fast = arg("--fast", "anthropic/claude-haiku-5.5");

const owners = parseOwners(readFileSync(path.join(root, "bench/fixtures/cowork.owners.json"), "utf8"));
const planner = configName === "tiered" ? createTieredPlanner({ fastModel: fast }) : createTieredPlanner({ fastModel: "" });
const teamStatus = async () =>
  "## Who owns what\n" + owners.owners.map((o) => `- ${o.agent}: ${o.paths.join(", ")}`).join("\n") + `\n- shared contracts: ${owners.shared.join(", ")}\n\nNo tasks in flight. No snapshots.`;

const cases = loadCases().slice(0, Number(arg("--limit", "1000")));
const plans: Record<string, unknown> = {};
const spend = { tokens: 0, usd: 0, escalated: 0, failed: 0 };
let next = 0;

async function worker(): Promise<void> {
  while (next < cases.length) {
    const c = cases[next++]!;
    try {
      const plan = await planner(
        { request: { id: 1, agent: c.requester, body: c.request, status: "planning", summary: "", plan: "", createdAt: 1, updatedAt: 1 } as never, requesterHuman: c.requester.toUpperCase(), owners, worktree: path.join(root, "demo-app"), teamStatus },
        (kind, detail) => {
          if (kind !== "status") return;
          const m = /used (\d+) tokens.*?(?:\$([0-9.]+))?$/.exec(detail);
          if (m) { spend.tokens += Number(m[1]); spend.usd += Number(m[2] ?? 0); }
          if (/planning again/.test(detail)) spend.escalated++;
        },
      );
      plans[c.id] = { tasks: plan.tasks.map((t) => ({ agent: t.agent, files: t.files, major: t.major })), reviews: plan.reviews.map((r) => ({ reviewer: r.reviewer })), conflicts: plan.conflicts.map((x) => ({ agentA: x.agentA, agentB: x.agentB })) };
      console.error(`ok   ${c.id}`);
    } catch (error) {
      spend.failed++;
      console.error(`FAIL ${c.id}: ${error instanceof Error ? error.message.slice(0, 120) : error}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(plans, null, 2));
console.log(`${configName}: ${Object.keys(plans).length}/${cases.length} plans -> ${out}`);
console.log(`spend: ${spend.tokens} tokens, $${spend.usd.toFixed(4)}, escalated ${spend.escalated}, failed ${spend.failed}`);
