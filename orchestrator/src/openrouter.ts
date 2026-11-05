/**
 * orchestrator/src/openrouter.ts
 *
 * WHAT IT'S FOR
 *   A second planner backend: the same job as Droid's planner (read the request, the team's state and the code,
 *   then record tasks, reviews and flagged conflicts), but the model comes from OpenRouter's OpenAI-compatible
 *   chat API. It reuses planTools() from planner.ts unchanged, so every check on what the model may record
 *   (known agents, no self-review, no one-agent conflicts) is the same, and rules.ts still applies the contract
 *   rule afterwards. No model decides red or green here either.
 *
 * SAFETY
 *   - The model gets only our plan tools plus three read-only file tools confined to the disposable worktree
 *     (read_file, list_dir, grep). No shell, no writes. Paths that leave the worktree are refused.
 *   - Results of tools, the repo and the request text are data; the prompt (prompt.ts) says so.
 *   - 150 s deadline and at most MAX_TURNS model calls per plan.
 *
 * USE: set OPENROUTER_API_KEY (and optionally OPENROUTER_MODEL) in .env. This is the default backend.
 *
 * Also covers the kickoff step (createOpenRouterKickoff). Droid (planner.ts) stays as an opt-in: PLANNER=droid.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { config } from "../../shared/src/config.ts";
import { truncateUtf8 } from "./diagnose/text.ts";
import { type OnStep, type Planner, kickoffTools, planTools } from "./planner.ts";
import { buildKickoffPrompt, buildPrompt } from "./prompt.ts";
import { type DraftProposal, type KickoffInput, type KickoffResult, parseProposal } from "./kickoff.ts";
import type { DraftPlan } from "./rules.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
const MAX_TURNS = 24;
const MAX_FILE_BYTES = 8_000;
const SKIP = new Set([".git", "node_modules", ".orchestrator"]);

type Content = string | null | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
type Message =
  | { role: "user" | "assistant"; content: Content; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface Usage { calls: number; promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: number }
interface ChatResponse { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } }; choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>; error?: { message?: string } }

/** Resolve `rel` inside `root`; null when it leaves the folder (including through a symlink). */
export function inside(root: string, rel: string): string | null {
  const base = realpathSync(root);
  const target = path.resolve(base, rel || ".");
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  try {
    const real = realpathSync(target);
    return real === base || real.startsWith(base + path.sep) ? real : null;
  } catch {
    return target; // does not exist: the caller reports that
  }
}

export interface FileTool { name: string; description: string; shape: z.ZodRawShape; run: (args: any) => string }

export function fileTools(root: string): FileTool[] {
  const refuse = (rel: string) => `Refused: ${rel} is outside the repository.`;
  const walk = (dir: string, out: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (out.length < 2000) out.push(full);
    }
  };
  return [
    {
      name: "read_file", description: "Read one text file in the repository (first 8 KB).",
      shape: { path: z.string().describe("Path relative to the repo root") },
      run: ({ path: rel }: { path: string }) => {
        const file = inside(root, rel);
        if (!file) return refuse(rel);
        try {
          if (!lstatSync(file).isFile()) return `${rel} is not a file.`;
          return truncateUtf8(readFileSync(file, "utf8"), MAX_FILE_BYTES);
        } catch {
          return `${rel} does not exist.`;
        }
      },
    },
    {
      name: "list_dir", description: "List a folder in the repository.",
      shape: { path: z.string().describe("Folder relative to the repo root; '.' for the root") },
      run: ({ path: rel }: { path: string }) => {
        const dir = inside(root, rel);
        if (!dir) return refuse(rel);
        try {
          return readdirSync(dir, { withFileTypes: true }).filter((e) => !SKIP.has(e.name)).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
        } catch {
          return `${rel} is not a folder.`;
        }
      },
    },
    {
      name: "grep", description: "Search the repository for a regular expression; returns up to 30 'path:line: text' matches.",
      shape: { pattern: z.string(), path: z.string().optional().describe("Folder to search, default the whole repo") },
      run: ({ pattern, path: rel }: { pattern: string; path?: string }) => {
        const dir = inside(root, rel ?? ".");
        if (!dir) return refuse(rel ?? ".");
        let re: RegExp;
        try { re = new RegExp(pattern); } catch { return "That is not a valid regular expression."; }
        const files: string[] = [];
        try { walk(dir, files); } catch { return `${rel} is not a folder.`; }
        const hits: string[] = [];
        for (const file of files) {
          let text: string;
          try { text = readFileSync(file, "utf8"); } catch { continue; }
          text.split("\n").forEach((line, i) => {
            if (hits.length < 30 && re.test(line)) hits.push(`${path.relative(realpathSync(root), file)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
          if (hits.length >= 30) break;
        }
        return hits.join("\n") || "No matches.";
      },
    },
  ];
}

export interface OpenRouterOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Prompt caching for Claude models (default on): the prompt and tool list are re-sent every turn, so cached reads are much cheaper. */
  cache?: boolean;
  /** Test seam. */
  fetch?: typeof fetch;
}

/** The shape of planTools() / kickoffTools() entries (the SDK's DroidTool): a name, a zod shape and a handler. */
interface PlanTool { name: string; description?: string; inputSchema?: unknown; handler: (input: Record<string, unknown>) => unknown }

/**
 * One model conversation: offer `tools` plus the read-only file tools, run what the model calls, stop when
 * `done()` says the plan is recorded, the model stops calling tools, MAX_TURNS pass, or the deadline hits.
 * Returns the last thing the model said.
 */
async function runToolLoop(options: OpenRouterOptions & {
  tools: PlanTool[]; worktree: string; prompt: string; label: string; firstStatus: string; onStep: OnStep; done: () => boolean;
}): Promise<{ text: string; usage: Usage }> {
  const apiKey = options.apiKey ?? config.openrouterApiKey;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set on the orchestrator's laptop, so it can't plan.");
  const model = options.model ?? (config.openrouterModel || DEFAULT_MODEL);
  const doFetch = options.fetch ?? fetch;

  const handlers = new Map<string, { shape: z.ZodRawShape; run: (args: unknown) => unknown }>();
  const defs: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> = [];
  for (const t of options.tools) {
    const shape = (t.inputSchema ?? {}) as z.ZodRawShape;
    handlers.set(t.name, { shape, run: t.handler as (args: unknown) => unknown });
    defs.push({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: zodToJsonSchema(z.object(shape), { target: "openApi3" }) } });
  }
  for (const t of fileTools(options.worktree)) {
    handlers.set(t.name, { shape: t.shape, run: t.run as (args: unknown) => unknown });
    defs.push({ type: "function", function: { name: t.name, description: t.description, parameters: zodToJsonSchema(z.object(t.shape), { target: "openApi3" }) } });
  }

  const cacheable = options.cache !== false && model.startsWith("anthropic/");
  const messages: Message[] = [{ role: "user", content: cacheable ? [{ type: "text", text: options.prompt, cache_control: { type: "ephemeral" } }] : options.prompt }];
  const usage: Usage = { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 150_000);
  const step = (kind: Parameters<OnStep>[0], detail: string) => options.onStep(kind, truncateUtf8(detail, 2048));
  let lastText = "";
  try {
    step("status", `${options.firstStatus} (${model} via OpenRouter)`);
    for (let turn = 0; turn < MAX_TURNS && !options.done(); turn++) {
      const response = await doFetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Orkio orchestrator" },
        body: JSON.stringify({ model, messages, tools: defs, tool_choice: "auto", usage: { include: true } }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as ChatResponse;
      if (!response.ok || body.error) throw new Error(`OpenRouter ${response.status}: ${body.error?.message ?? "request failed"}`);
      usage.calls++;
      usage.promptTokens += body.usage?.prompt_tokens ?? 0;
      usage.completionTokens += body.usage?.completion_tokens ?? 0;
      usage.cachedTokens += body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      usage.costUsd += body.usage?.cost ?? 0;
      const message = body.choices?.[0]?.message;
      if (!message) throw new Error("OpenRouter returned no message.");
      if (message.content) { lastText = message.content; step("thought", message.content); }
      const calls = message.tool_calls ?? [];
      messages.push({ role: "assistant", content: message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (calls.length === 0) break; // the model stopped talking without finishing
      for (const call of calls) {
        step("tool_call", `${call.function.name} ${call.function.arguments}`);
        let result: string;
        const handler = handlers.get(call.function.name);
        if (!handler) result = `Unknown tool ${call.function.name}.`;
        else {
          try {
            const args = Object.keys(handler.shape).length > 0 ? z.object(handler.shape).parse(JSON.parse(call.function.arguments || "{}")) : {};
            const out = await handler.run(args);
            result = typeof out === "string" ? out : JSON.stringify(out);
          } catch (error) {
            result = `Bad arguments: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`;
          }
        }
        step("tool_result", result.slice(0, 300));
        messages.push({ role: "tool", tool_call_id: call.id, content: truncateUtf8(result, 12_000) });
        if (options.done()) break;
      }
    }
  } catch (error) {
    if (!options.done()) throw new Error(controller.signal.aborted ? `OpenRouter ${options.label} timed out` : `OpenRouter ${options.label} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (usage.calls > 0) {
    const total = usage.promptTokens + usage.completionTokens;
    step("status", `${options.label} used ${total} tokens over ${usage.calls} model call(s) (${usage.cachedTokens} cached)${usage.costUsd ? `, $${usage.costUsd.toFixed(4)}` : ""}`);
  }
  return { text: lastText, usage };
}

export function createOpenRouterPlanner(options: OpenRouterOptions = {}): Planner {
  return async (input, onStep) => {
    const plan: DraftPlan = { summary: "", tasks: [], reviews: [], conflicts: [] };
    const state = { finished: false };
    const { text: lastText } = await runToolLoop({
      ...options, tools: planTools(input, plan, state) as PlanTool[], worktree: input.worktree, prompt: buildPrompt(input.request, input.requesterHuman),
      label: "planning", firstStatus: "Reading the request and the team's state", onStep, done: () => state.finished,
    });
    if (!state.finished && plan.tasks.length === 0) throw new Error("The model ended without a plan.");
    if (!plan.summary) plan.summary = lastText.slice(0, 1000) || `${plan.tasks.length} task(s) for ${[...new Set(plan.tasks.map((task) => task.agent))].join(", ")}.`;
    return plan;
  };
}

/**
 * Why a cheap first-pass plan must be redone by the strong model, or null to keep it. The signals are things we
 * can observe in the plan itself, not a guess about the request:
 *   - a major task (a shared contract or another owner's feature is changing),
 *   - a predicted conflict between agents,
 *   - work for two or more agents (a cross-owner request).
 * Note the contract rule in rules.ts runs after the planner either way; this only decides which model plans.
 */
export function needsStrongModel(plan: DraftPlan): string | null {
  if (plan.tasks.some((task) => task.major)) return "a major change";
  if (plan.conflicts.length > 0) return "a predicted conflict";
  if (new Set(plan.tasks.map((task) => task.agent)).size >= 2) return "work for several agents";
  return null;
}

/**
 * Cheap model first, strong model when the case turns out hard. With no OPENROUTER_MODEL_FAST (or the same id)
 * this is just the strong model. If the cheap attempt fails or returns no plan, the strong model takes over.
 */
export function createTieredPlanner(options: OpenRouterOptions & { fastModel?: string } = {}): Planner {
  const strongModel = options.model ?? (config.openrouterModel || DEFAULT_MODEL);
  const fastModel = options.fastModel ?? config.openrouterModelFast;
  const strong = createOpenRouterPlanner({ ...options, model: strongModel });
  if (!fastModel || fastModel === strongModel) return strong;
  const fast = createOpenRouterPlanner({ ...options, model: fastModel });
  return async (input, onStep) => {
    let plan: DraftPlan;
    try {
      plan = await fast(input, onStep);
    } catch (error) {
      onStep("status", `${fastModel} could not plan (${error instanceof Error ? error.message.slice(0, 120) : String(error)}); using ${strongModel}`);
      return strong(input, onStep);
    }
    const why = needsStrongModel(plan);
    if (why) {
      onStep("status", `${fastModel} saw ${why}; planning again with ${strongModel}`);
      return strong(input, onStep);
    }
    onStep("status", `kept the plan from ${fastModel} (a small, single-owner request)`);
    return plan;
  };
}

/** Kickoff for the goal-only case, on OpenRouter: owners, shared contracts and first tasks (or, once, questions). Writes nothing. */
export function createOpenRouterKickoff(options: OpenRouterOptions = {}) {
  return async (input: KickoffInput, onStep: OnStep): Promise<KickoffResult> => {
    if (input.members.length === 0) throw new Error("A kickoff needs at least one team member.");
    const draft: DraftProposal = { summary: "", architecture: "", owners: [], contracts: [], firstTasks: [], questions: [] };
    const state = { finished: false, asked: false };
    await runToolLoop({
      ...options, tools: kickoffTools(input, draft, state) as PlanTool[], worktree: input.worktree, prompt: buildKickoffPrompt(input),
      label: "kickoff", firstStatus: "Reading the repository and the goal", onStep, done: () => state.finished,
    });
    if (draft.questions.length > 0) return { kind: "questions", questions: draft.questions };
    if (draft.owners.length === 0) throw new Error("The model ended the kickoff without proposing any owner.");
    const proposal = parseProposal(
      { architecture: draft.architecture, owners: draft.owners, contracts: draft.contracts, firstTasks: draft.firstTasks },
      input.members.map((m) => m.agent),
    );
    return { kind: "proposal", proposal: { ...proposal, summary: draft.summary } };
  };
}
