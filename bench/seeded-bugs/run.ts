/**
 * bench/seeded-bugs/run.ts
 *
 * WHAT IT'S FOR: applies two agents' edits to throwaway copies of demo-app/ and reports what each
 * verification layer notices. For each scenario:
 *   1. baseline commit; branch a (agent A's edits) and branch b (agent B's edits) from it
 *   2. each branch alone is checked (tsc + vitest, checks/src/check.ts); a scenario is only valid
 *      when both are green alone
 *   3. git merge b into a; mergeClean = no textual conflict
 *   4. if clean: tsc + vitest on the merged tree (what check_with_team runs)
 *   5. oracle: add the hidden test and run vitest again. bug = merge conflict OR hidden test fails
 * Layers (a proxy for what each setup would have caught, not a measurement of any agent):
 *   plain-git         notices only a textual merge conflict
 *   shared-context    merge conflict, or tsc errors on the combined tree (no test run)
 *   orchestrated      merge conflict, or tsc errors, or failing visible tests on the combined tree
 *
 * USAGE: node bench/seeded-bugs/run.ts [--json] [--only id,id]
 *   needs demo-app/node_modules (typescript, vitest). Takes a few seconds per scenario.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks, type CheckOutcome } from "../../checks/src/check.ts";
import { useRepo } from "../../checks/src/git.ts";
import { scenarios, type Edit, type Scenario } from "./scenarios.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const demo = path.join(root, "demo-app");
export const LAYERS = ["plain-git", "shared-context", "orchestrated"] as const;
export type Layer = (typeof LAYERS)[number];

export interface ScenarioResult {
  id: string;
  kind: string;
  validAlone: boolean;
  mergeClean: boolean;
  tscErrors: number;
  testFails: number;
  hiddenFails: number;
  bug: boolean;
  detected: Record<Layer, boolean>;
  wallMs: number;
  problem?: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function applyEdits(dir: string, edits: Edit[]): void {
  for (const edit of edits) {
    const file = path.join(dir, edit.file);
    if ("create" in edit) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, edit.create);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const count = text.split(edit.from).length - 1;
    if (count !== 1) throw new Error(`${edit.file}: expected exactly one match for ${JSON.stringify(edit.from.slice(0, 60))}, found ${count}`);
    writeFileSync(file, text.replace(edit.from, () => edit.to));
  }
}

function freshBaseline(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bench-seeded-"));
  for (const entry of ["src", "package.json", "tsconfig.json", "vitest.config.ts"]) cpSync(path.join(demo, entry), path.join(dir, entry), { recursive: true });
  writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
  symlinkSync(path.join(demo, "node_modules"), path.join(dir, "node_modules"), "dir");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "baseline");
  return dir;
}

function commitAll(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const started = Date.now();
  const dir = freshBaseline();
  const result: ScenarioResult = {
    id: scenario.id, kind: scenario.kind, validAlone: false, mergeClean: false, tscErrors: 0, testFails: 0, hiddenFails: 0, bug: false,
    detected: { "plain-git": false, "shared-context": false, orchestrated: false }, wallMs: 0,
  };
  try {
    git(dir, "checkout", "-q", "-b", "b");
    applyEdits(dir, scenario.agentB);
    commitAll(dir, "agent b");
    git(dir, "checkout", "-q", "-b", "a", "main");
    applyEdits(dir, scenario.agentA);
    commitAll(dir, "agent a");
    const alone = await runChecks(dir);
    git(dir, "checkout", "-q", "b");
    const aloneB = await runChecks(dir);
    git(dir, "checkout", "-q", "a");
    result.validAlone = alone.ok && aloneB.ok;
    if (!result.validAlone) result.problem = `not green alone: ${alone.ok ? "b" : "a"}: ${(alone.ok ? aloneB : alone).log.slice(0, 300)}`;
    try {
      git(dir, "merge", "-q", "--no-edit", "b");
      result.mergeClean = true;
    } catch {
      git(dir, "merge", "--abort");
    }
    let combined: CheckOutcome | null = null;
    if (result.mergeClean) {
      combined = await runChecks(dir);
      result.tscErrors = combined.tscErrors.length;
      result.testFails = combined.testFails.length;
      mkdirSync(path.dirname(path.join(dir, scenario.hidden.file)), { recursive: true });
      writeFileSync(path.join(dir, scenario.hidden.file), scenario.hidden.content);
      const oracle = await runChecks(dir);
      result.hiddenFails = oracle.testFails.filter((f) => f.file === scenario.hidden.file).length;
    }
    result.bug = !result.mergeClean || result.hiddenFails > 0;
    result.detected = {
      "plain-git": !result.mergeClean,
      "shared-context": !result.mergeClean || result.tscErrors > 0,
      orchestrated: !result.mergeClean || result.tscErrors > 0 || result.testFails > 0,
    };
  } catch (error) {
    result.problem = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    result.wallMs = Date.now() - started;
  }
  return result;
}

export interface Summary { layer: Layer; bugs: number; detected: number; falsePositives: number; clean: number; }

/** Detection rate over scenarios that contain a bug; false positives over scenarios that don't. */
export function summarize(results: ScenarioResult[]): Summary[] {
  return LAYERS.map((layer) => {
    const bugs = results.filter((r) => r.bug);
    const clean = results.filter((r) => !r.bug);
    return {
      layer, bugs: bugs.length, detected: bugs.filter((r) => r.detected[layer]).length,
      clean: clean.length, falsePositives: clean.filter((r) => r.detected[layer]).length,
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(path.join(demo, "node_modules", "typescript"))) {
    console.error("demo-app/node_modules is missing typescript/vitest: run npm install in demo-app/");
    process.exit(2);
  }
  useRepo(demo);
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]!.split(",") : null;
  const results: ScenarioResult[] = [];
  for (const s of scenarios.filter((x) => !only || only.includes(x.id))) results.push(await runScenario(s));
  if (process.argv.includes("--json")) console.log(JSON.stringify({ results, summary: summarize(results) }, null, 2));
  else {
    for (const r of results) console.log(`${r.id.padEnd(18)} valid=${r.validAlone} merge=${r.mergeClean ? "clean" : "CONFLICT"} tsc=${r.tscErrors} tests=${r.testFails} hidden=${r.hiddenFails} bug=${r.bug} ${r.problem ?? ""}`);
    for (const s of summarize(results)) console.log(`${s.layer.padEnd(15)} detected ${s.detected}/${s.bugs} bugs, ${s.falsePositives}/${s.clean} false positives`);
  }
  process.exit(results.some((r) => r.problem) ? 1 : 0);
}
