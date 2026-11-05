/**
 * bench/live/run-live.ts
 *
 * WHAT IT'S FOR: LIVE-AGENT runs of the plain-git condition. Two real headless Claude Code sessions (agent A
 * and agent B) each get their own half of a task in their own clone of demo-app, work in parallel (as two
 * laptops would), and a "human" then merges their branches. Ground truth is a hidden test the agents never
 * see (from bench/seeded-bugs/scenarios.ts). Each run is saved to bench/recorded/plain-git/<task>/<trial>.json
 * so bench/run-matrix.ts and bench/report.ts pick it up.
 *
 * NOT COVERED: the `orchestrated` condition. It needs SpacetimeDB, the hooks, the orchestrator (a Factory key)
 * and two woken sessions; see bench/LIVE-RUNS.md for what that takes.
 *
 * USAGE
 *   node bench/live/run-live.ts --dry-run                      harness check, no model calls (applies the seeded edits)
 *   node bench/live/run-live.ts --tasks units-change --trials 1 --budget 2
 *   env CLAUDE_BIN overrides the claude binary (default: the VS Code extension's bundled binary).
 *
 * HONEST LIMITS: 1 pair of sessions per trial, one model, tiny app. humanPrompts is 2 by construction (one
 * prompt per agent). A merge conflict counts as a failed run: no human repair step is simulated.
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "../../checks/src/check.ts";
import { useRepo } from "../../checks/src/git.ts";
import { applyEdits } from "../seeded-bugs/run.ts";
import { scenarios } from "../seeded-bugs/scenarios.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const demo = path.join(root, "demo-app");
useRepo(demo);

export interface LiveTask {
  id: string;
  /** Scenario whose hidden test is the ground truth, and whose edits drive --dry-run. */
  scenario: string;
  /** What a developer would type to each agent. Neither prompt mentions the other agent's work. */
  promptA: string;
  promptB: string;
}

const RULES = "Keep the change small. Run `npm run typecheck` and `npm test` before you finish. Do not touch git; just edit files.";

export const TASKS: LiveTask[] = [
  {
    id: "units-change",
    scenario: "units-ms",
    promptA: `You own the users module. Change User.lastLogin from epoch seconds to epoch milliseconds everywhere in this repo, and update the code and tests that use it. ${RULES}`,
    promptB: `You own the sessions module. Add src/sessions/idle.ts exporting idleSeconds(user: User, now: Date): number, the whole seconds since the user's lastLogin, with a vitest test next to it. ${RULES}`,
  },
  {
    id: "rename-field",
    scenario: "rename-field",
    promptA: `You own the users module. Rename User.lastLogin to lastLoginAt everywhere in this repo and update the code and tests that use it. ${RULES}`,
    promptB: `You own the sessions module. Add src/sessions/last-seen.ts exporting lastSeen(user: User): number that returns the user's login time as stored on the User. Add a vitest test next to it. ${RULES}`,
  },
  {
    id: "independent-feature",
    scenario: "benign",
    promptA: `You own the users module. Add and export isNewUser(user: User): boolean in src/users/user.ts that is true when lastLogin is 0, with a test. ${RULES}`,
    promptB: `You own the sessions module. Add src/sessions/limits.ts exporting the constant MAX_SESSIONS_PER_USER = 5, with a test. ${RULES}`,
  },
];

const DEFAULT_BIN = path.join(os.homedir(), ".vscode/extensions", "anthropic.claude-code-2.1.318-darwin-arm64/resources/native-binary/claude");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function baseline(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bench-live-"));
  const repo = path.join(dir, "origin");
  mkdirSync(repo);
  for (const entry of ["src", "package.json", "tsconfig.json", "vitest.config.ts"]) cpSync(path.join(demo, entry), path.join(repo, entry), { recursive: true });
  writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "baseline");
  return dir;
}

function workspace(dir: string, name: string): string {
  const ws = path.join(dir, name);
  git(dir, "clone", "-q", path.join(dir, "origin"), ws);
  symlinkSync(path.join(demo, "node_modules"), path.join(ws, "node_modules"), "dir");
  return ws;
}

interface AgentRun { wallMs: number; tokens: number; costUsd: number; turns: number; ok: boolean; note: string }

function runAgent(bin: string, cwd: string, prompt: string, budget: number): Promise<AgentRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const args = [
      "-p", prompt, "--output-format", "json", "--model", "sonnet", "--max-turns", "30", "--max-budget-usd", String(budget),
      "--permission-mode", "acceptEdits", "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Bash(npm run typecheck)", "Bash(npm test)", "Bash(npx vitest run*)", "Bash(npx tsc*)",
      "--setting-sources", "project", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    ];
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", () => {
      const wallMs = Date.now() - started;
      try {
        const j = JSON.parse(out) as { total_cost_usd?: number; num_turns?: number; is_error?: boolean; usage?: Record<string, number> };
        const u = j.usage ?? {};
        const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        resolve({ wallMs, tokens, costUsd: j.total_cost_usd ?? 0, turns: j.num_turns ?? 0, ok: !j.is_error, note: j.is_error ? out.slice(0, 200) : "" });
      } catch {
        resolve({ wallMs, tokens: 0, costUsd: 0, turns: 0, ok: false, note: (err || out).slice(0, 300) });
      }
    });
  });
}

export interface LiveResult {
  task: string; trial: number; condition: "plain-git";
  wallMs: number; humanPrompts: number; tokens: number; costUsd: number; hiddenTestPass: boolean;
  details: { mergeClean: boolean; visibleGreen: boolean | null; agentA: AgentRun; agentB: AgentRun; dryRun: boolean };
}

export async function runTrial(task: LiveTask, trial: number, opts: { dryRun: boolean; bin: string; budget: number }): Promise<LiveResult> {
  const scenario = scenarios.find((s) => s.id === task.scenario)!;
  const dir = baseline();
  try {
    const a = workspace(dir, "a");
    const b = workspace(dir, "b");
    let runA: AgentRun;
    let runB: AgentRun;
    if (opts.dryRun) {
      applyEdits(a, scenario.agentA);
      applyEdits(b, scenario.agentB);
      runA = runB = { wallMs: 0, tokens: 0, costUsd: 0, turns: 0, ok: true, note: "dry run" };
    } else {
      [runA, runB] = await Promise.all([runAgent(opts.bin, a, task.promptA, opts.budget), runAgent(opts.bin, b, task.promptB, opts.budget)]);
    }
    for (const [ws, who] of [[a, "agent a"], [b, "agent b"]] as const) {
      git(ws, "add", "-A");
      git(ws, "commit", "-q", "--allow-empty", "-m", who);
    }
    // The "human" merges B into A, exactly as a teammate would with plain git.
    git(a, "remote", "add", "peer", b);
    git(a, "fetch", "-q", "peer");
    let mergeClean = true;
    try {
      git(a, "merge", "-q", "--no-edit", "peer/main");
    } catch {
      mergeClean = false;
      try { git(a, "merge", "--abort"); } catch { /* nothing to abort */ }
    }
    let visibleGreen: boolean | null = null;
    let hiddenPass = false;
    if (mergeClean) {
      visibleGreen = (await runChecks(a)).ok;
      writeFileSync(path.join(a, scenario.hidden.file), scenario.hidden.content);
      const oracle = await runChecks(a);
      hiddenPass = oracle.testFails.filter((f) => f.file === scenario.hidden.file).length === 0 && oracle.tscErrors.length === 0 && visibleGreen;
    }
    return {
      task: task.id, trial, condition: "plain-git",
      wallMs: Math.max(runA.wallMs, runB.wallMs), humanPrompts: 2, tokens: runA.tokens + runB.tokens, costUsd: runA.costUsd + runB.costUsd, hiddenTestPass: hiddenPass,
      details: { mergeClean, visibleGreen, agentA: runA, agentB: runB, dryRun: opts.dryRun },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback);
  const dryRun = process.argv.includes("--dry-run");
  const bin = process.env.CLAUDE_BIN ?? DEFAULT_BIN;
  if (!dryRun && !existsSync(bin)) throw new Error(`claude binary not found at ${bin}; set CLAUDE_BIN`);
  const wanted = arg("--tasks", TASKS.map((t) => t.id).join(",")).split(",");
  const trials = Math.max(1, Number(arg("--trials", "1")));
  const first = Math.max(1, Number(arg("--first-trial", "1")));
  const budget = Number(arg("--budget", "2"));
  const outDir = dryRun ? path.join(os.tmpdir(), "bench-live-dry") : path.join(root, "bench/recorded");
  const rawDir = path.join(root, "bench/recorded-raw");
  for (const task of TASKS.filter((t) => wanted.includes(t.id))) {
    for (let trial = first; trial < first + trials; trial++) {
      const r = await runTrial(task, trial, { dryRun, bin, budget });
      const dest = path.join(outDir, "plain-git", task.id);
      mkdirSync(dest, { recursive: true });
      const { details, ...record } = r;
      writeFileSync(path.join(dest, `${trial}.json`), JSON.stringify({ wallMs: record.wallMs, humanPrompts: record.humanPrompts, tokens: record.tokens, costUsd: Number(record.costUsd.toFixed(4)), hiddenTestPass: record.hiddenTestPass }, null, 2));
      if (!dryRun) {
        mkdirSync(rawDir, { recursive: true });
        writeFileSync(path.join(rawDir, `plain-git-${task.id}-${trial}.json`), JSON.stringify(r, null, 2));
      }
      console.log(`${task.id} #${trial}: merge=${details.mergeClean ? "clean" : "CONFLICT"} visible=${details.visibleGreen} hidden=${r.hiddenTestPass ? "PASS" : "FAIL"} wall=${(r.wallMs / 1000).toFixed(0)}s tokens=${r.tokens} cost=$${r.costUsd.toFixed(2)}${dryRun ? " (dry run)" : ""}`);
    }
  }
}
