/** Part C Factory diagnosis: disposable worktree, edit tools disabled, explicit read/check permissions,
 * streamed UI steps, 90-second session deadline and guaranteed session close. API verified against
 * @factory/droid-sdk's installed declarations and https://docs.factory.com/sdk/typescript.
 */
import { AutonomyLevel, createSession, ToolConfirmationOutcome, ToolConfirmationType } from "@factory/droid-sdk/node";
import type { DiagnosisStepKind } from "../../../shared/src/schema.ts";
import { config } from "../../../shared/src/config.ts";
import { buildPrompt, type Diagnosis, type DiagnosisContext } from "./prompt.ts";
import { truncateUtf8 } from "./text.ts";
import { isReadOnlyCommand, READ_TOOLS } from "./permissions.ts";

export type OnStep = (kind: DiagnosisStepKind, detail: string) => void;

export function parseDiagnosis(text: string): Diagnosis | null {
  if (!text.trim()) return null;
  const clean = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try {
    const value: unknown = JSON.parse(clean);
    if (typeof value === "object" && value !== null && ["summary", "cause", "suggestion", "fact"].every(key => typeof (value as Record<string, unknown>)[key] === "string")) {
      return value as Diagnosis;
    }
  } catch { /* The documented fallback retains a useful plain-text explanation. */ }
  return { summary: text.slice(0, 8000), cause: "", suggestion: "", fact: "" };
}

/** Injectable SDK seam for timeout/permission regression checks; production uses the installed SDK. */
export function createDroidDiagnoser(options: { create?: typeof createSession; apiKey?: string; timeoutMs?: number } = {}) {
return async function diagnose(ctx: DiagnosisContext, onStep: OnStep): Promise<Diagnosis | null> {
  const apiKey = options.apiKey ?? config.factoryApiKey;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Droid diagnosis timed out")), options.timeoutMs ?? 90_000);
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  const step: OnStep = (kind, detail) => onStep(kind, truncateUtf8(detail, 2048));
  try {
    session = await (options.create ?? createSession)({
      cwd: ctx.worktree,
      apiKey,
      ...(config.droidModelId ? { modelId: config.droidModelId } : {}),
      abortSignal: controller.signal,
      autonomyLevel: AutonomyLevel.Off,
      disableBuiltinSkills: true,
      disabledToolIds: ["Edit", "Create", "ApplyPatch", "Task", "Skill"],
      permissionHandler({ toolUses, options }) {
        const allowed = toolUses.length > 0 && toolUses.every(({ toolUse, details }) => {
          if (READ_TOOLS.has(toolUse.name)) return details.type !== ToolConfirmationType.SandboxViolation;
          if (toolUse.name !== "Execute" || details.type !== ToolConfirmationType.Execute) return false;
          return isReadOnlyCommand(details.command) && isReadOnlyCommand(details.fullCommand);
        });
        return allowed && options.some(option => option.value === ToolConfirmationOutcome.ProceedOnce)
          ? ToolConfirmationOutcome.ProceedOnce : ToolConfirmationOutcome.Cancel;
      },
    });
    // Disable every undiscovered write/connector tool as well as the known editing tools, before a turn starts.
    const tools = await session.listTools();
    await session.updateSettings({ disabledToolIds: tools.filter(tool => !READ_TOOLS.has(tool.id) && tool.id !== "Execute").map(tool => tool.id) });
    const prompt = `${buildPrompt(ctx)}\nRead only. For checks use ./node_modules/.bin/tsc --noEmit --incremental false or ./node_modules/.bin/vitest run. For git reads append --no-ext-diff --no-textconv immediately after diff/show/log. Never change files or run shell compound commands. End with ONLY a JSON object containing summary, cause, suggestion, fact.`;
    for await (const message of session.stream(prompt, { abortSignal: controller.signal })) {
      switch (message.type) {
        case "assistant": step("thought", message.text); break;
        case "tool_call": step("tool_call", `${message.name} ${JSON.stringify(message.input)}`); break;
        case "tool_result": step("tool_result", JSON.stringify(message.content).slice(0, 300)); break;
        case "error": step("error", message.message); break;
        case "result":
          if (!message.success) return null;
          step("final", message.text);
          return parseDiagnosis(message.text);
      }
    }
    return null;
  } catch {
    step("error", controller.signal.aborted ? "Droid diagnosis timed out" : "Droid diagnosis unavailable");
    return null;
  } finally {
    clearTimeout(timer);
    await session?.close();
  }
}

}

const defaultDiagnoser = createDroidDiagnoser();
/** Returns null on timeout, SDK error or missing API key. Always closes its own session. */
export async function diagnoseWithDroid(ctx: DiagnosisContext, onStep: OnStep): Promise<Diagnosis | null> {
  return defaultDiagnoser(ctx, onStep);
}
