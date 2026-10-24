/**
 * shared/src/config.ts
 *
 * WHAT IT'S FOR
 *   The one place where Node code (hooks, MCP server, watcher, scripts) reads its settings.
 *   It loads the .env file at the root of repo 1 no matter what the current directory is.
 *   That matters for the hooks: Claude Code runs them from the demo-app folder, not from here.
 *
 * OWNER: C. USED BY: hooks/, mcp/, watcher/, scripts/.
 * NOT USED BY the UI: browser code reads import.meta.env.VITE_* instead.
 *
 * NOTES
 *   - Nothing here throws at import time. A hook must never crash an agent's turn because a
 *     setting is missing; it calls missingSettings() and fails open (hooks/src/lib/hook-io.ts).
 *   - process.loadEnvFile is built into Node, so there is no dotenv dependency. Its failures
 *     produce only configLoadError's fixed signal; file contents and credentials are never logged.
 *   - Setting names and meanings: .env.example.
 */
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const envFile = path.join(repoRoot, ".env");
/** A missing .env is normal. Other load errors must not prevent hooks from importing settings. */
export const configLoadError: "env_load_failed" | null = (() => {
  try {
    process.loadEnvFile(envFile);
    return null;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? null : "env_load_failed";
  }
})();

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  repoRoot,
  agent: env("COWORK_NAME"),
  stdbHost: env("STDB_HOST", "https://maincloud.spacetimedb.com"),
  stdbDb: env("STDB_DB"),
  stdbToken: env("STDB_TOKEN"),
  gitRemote: env("GIT_REMOTE", "origin"),
  mainBranch: env("MAIN_BRANCH", "main"),
  listenerMinutes: Number(env("LISTENER_MINUTES", "25")),
  demoRepoPath: env("DEMO_REPO_PATH"),
  checkDebounceMs: Number(env("CHECK_DEBOUNCE_MS", "2000")),
  diagnoseWith: env("DIAGNOSE_WITH", "droid") === "claude" ? "claude" : "droid",
  factoryApiKey: env("FACTORY_API_KEY"),
  droidModelId: env("DROID_MODEL_ID"),
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  claudeModel: env("CLAUDE_MODEL", "claude-opus-5-5"),
} as const;

export type Setting = Exclude<keyof typeof config, "repoRoot">;

/** Returns the settings in `names` that are empty, so the caller can decide what to do. */
export function missingSettings(names: Setting[]): Setting[] {
  return names.filter((name) => config[name] === "");
}
