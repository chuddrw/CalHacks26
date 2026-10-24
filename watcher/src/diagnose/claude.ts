/**
 * watcher/src/diagnose/claude.ts
 *
 * WHAT IT'S FOR
 *   The fallback diagnosis: one Claude API call that turns the failing output, both diffs and both
 *   intents into a Diagnosis (prompt.ts). diagnose/index.ts uses it when Droid is off, slow or failing.
 *   It reads no files and runs no tools, so it's fast and predictable.
 *
 * OWNER: C. WHEN: Sat 14:00-19:00.
 * DONE WHEN: with DIAGNOSE_WITH=claude, the demo conflict gets an explanation in the UI within
 *            about 10 s.
 *
 * HOW IT CALLS CLAUDE (shape from Anthropic's TypeScript SDK docs)
 *   - Package @anthropic-ai/sdk; new Anthropic() reads ANTHROPIC_API_KEY, which shared/src/config.ts
 *     loads from .env.
 *   - client.messages.parse() with output_config.format = zodOutputFormat(schema) returns
 *     parsed_output, which is null if the reply didn't match the schema.
 *   - Model: CLAUDE_MODEL in .env, default claude-opus-5-5. Effort "low", because the explanation is
 *     short and the demo needs it fast. Switching to a smaller model for speed is the team's call.
 *   - Check stop_reason before reading the output. On "refusal", return null.
 *
 * TODO (C): opt into server-side refusal fallbacks. Anthropic's guide recommends it for Opus 5.5:
 *   betas: ["server-side-fallback-2026-07-01"] and fallbacks: "default", on the beta messages API.
 *   Their documented example uses client.beta.messages.create. Check whether the beta API accepts
 *   output_config.format too; if so, add both fields here.
 *
 * NOTES
 *   - zod: the root setup installs zod@3 because the Droid SDK requires Zod 3, but the Anthropic
 *     SDK's zodOutputFormat needs zod v4 types. zod 3.25+ ships the v4 API at "zod/v4", so this file
 *     imports from there. Checked Oct 24: @anthropic-ai/sdk 1.3.0 + zod 3.25.76 type-check cleanly.
 *   - Errors: rate limits and API errors return null (the caller shows the raw error instead).
 *     Anything else is a bug in our code and should crash loudly.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { config } from "../../../shared/src/config.ts";
import { buildPrompt, type Diagnosis, type DiagnosisContext } from "./prompt.ts";

const DiagnosisSchema = z.object({
  summary: z.string(),
  cause: z.string(),
  suggestion: z.string(),
  fact: z.string(),
});

let client: Anthropic | null = null;

/** Returns null when Claude refuses, is rate limited, or returns something that doesn't parse. */
export async function diagnoseWithClaude(ctx: DiagnosisContext): Promise<Diagnosis | null> {
  client ??= new Anthropic();
  try {
    const response = await client.messages.parse({
      model: config.claudeModel,
      max_tokens: 16000,
      output_config: { effort: "low", format: zodOutputFormat(DiagnosisSchema) },
      messages: [{ role: "user", content: buildPrompt(ctx) }],
    });
    if (response.stop_reason === "refusal") return null;
    return response.parsed_output ?? null;
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      console.error("[diagnose] Claude is rate limited; showing the raw error instead.");
      return null;
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`[diagnose] Claude API error ${error.status}: ${error.message}`);
      return null;
    }
    throw error;
  }
}
