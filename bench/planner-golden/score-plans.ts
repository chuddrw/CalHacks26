/**
 * bench/planner-golden/score-plans.ts
 *
 * WHAT IT'S FOR: scores plans a real planner produced (for example Droid, run on each request in
 * cases.json) on all four metrics. The planner run itself is not automated here; it needs a model.
 *
 * USAGE: node bench/planner-golden/score-plans.ts <plans.json> [--json]
 *   plans.json: { "<case id>": { "tasks": [{agent, files, major}], "reviews": [{reviewer}], "conflicts": [{agentA, agentB}] } }
 *   (the plan the orchestrator publishes, keyed by case id)
 */
import { readFileSync } from "node:fs";
import { loadCases } from "./run-rules.ts";
import { formatScore, scorePlans, type PlanLike } from "./score.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node bench/planner-golden/score-plans.ts <plans.json> [--json]");
  process.exit(2);
}
const plans = JSON.parse(readFileSync(file, "utf8")) as Record<string, PlanLike>;
const score = scorePlans(loadCases(), plans);
console.log(process.argv.includes("--json") ? JSON.stringify(score, null, 2) : formatScore(file, score));
