/**
 * bench/planner-golden/run-rules.ts
 *
 * WHAT IT'S FOR: scores the code half of the planner, the contract rule in
 * orchestrator/src/rules.ts, against cases.json with no model and no network. For each case it
 * takes the naive draft (tasks by file ownership, nothing marked major), applies the rule with the
 * real import graph of demo-app/, and scores "major" and "reviewers" only. Owners and conflicts
 * come from the model, not the rule, so they are NOT scored here (use score-plans.ts).
 *
 * USAGE: node bench/planner-golden/run-rules.ts [--json]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOwners } from "../../shared/src/owners.ts";
import { importIndex } from "../../orchestrator/src/imports.ts";
import { applyContractRule } from "../../orchestrator/src/rules.ts";
import { formatScore, scorePlans, type GoldenCase, type PlanLike } from "./score.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

export function loadCases(): GoldenCase[] {
  return JSON.parse(readFileSync(path.join(here, "cases.json"), "utf8")) as GoldenCase[];
}

export function loadOwners() {
  return parseOwners(readFileSync(path.join(root, "bench/fixtures/cowork.owners.json"), "utf8"));
}

export function rulePlans(cases = loadCases()): Record<string, PlanLike> {
  const owners = loadOwners();
  const importers = importIndex(path.join(root, "demo-app"), []);
  const plans: Record<string, PlanLike> = {};
  for (const c of cases) {
    const draft = { summary: "", tasks: c.draft.map((t) => ({ ...t, title: c.id, details: "" })), reviews: [], conflicts: [] };
    plans[c.id] = applyContractRule({ plan: draft, owners, requester: c.requester, importers }).plan;
  }
  return plans;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = loadCases();
  const score = scorePlans(cases, rulePlans(cases), ["major", "reviewers"]);
  console.log(process.argv.includes("--json") ? JSON.stringify(score, null, 2) : formatScore("contract rule (no LLM)", score));
  process.exitCode = score.major!.wrong.length ? 1 : 0;
}
