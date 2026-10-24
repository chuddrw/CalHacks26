/** Part C's bounded Claude fallback: structured diagnosis from supplied evidence, no file tools.
 * SDK 1.3.0 supports structured parsing together with the server-side refusal fallback beta.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { config } from "../../../shared/src/config.ts";
import { buildPrompt, type Diagnosis, type DiagnosisContext } from "./prompt.ts";

const DiagnosisSchema = z.object({
  summary: z.string(), cause: z.string(), suggestion: z.string(), fact: z.string(),
});
let client: Anthropic | null = null;

/** Missing credentials, refusals, transport/API errors and malformed output return null. */
export async function diagnoseWithClaude(ctx: DiagnosisContext): Promise<Diagnosis | null> {
  if (!config.anthropicApiKey) return null;
  try {
    client ??= new Anthropic({ apiKey: config.anthropicApiKey, timeout: 20_000, maxRetries: 0 });
    const response = await client.beta.messages.parse({
      model: config.claudeModel,
      max_tokens: 2048,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: zodOutputFormat(DiagnosisSchema) },
      messages: [{ role: "user", content: buildPrompt(ctx) }],
    });
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
    return response.parsed_output ?? null;
  } catch (error) {
    if (error instanceof Anthropic.APIError || error instanceof SyntaxError) return null;
    throw error;
  }
}
