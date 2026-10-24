/**
 * watcher/src/fixture.ts
 *
 * WHAT IT'S FOR
 *   A throwaway copy of the demo scenario for testing the watcher end to end before demo-app and
 *   the real hooks exist: a local bare "remote", the watcher's own clone (with typescript and
 *   vitest installed), and one clone per agent. Each step edits an agent's clone, snapshots it to
 *   wip/<agent> with the same git commands as hooks/src/lib/snapshot.ts, and calls post_snapshot
 *   through shared/src/stdb-http.ts, exactly like the hook will.
 *
 * OWNER: B.
 * USAGE (from the repo root; STDB_* from .env or the environment):
 *   npm run fixture -w watcher -- setup [--dir <path>]      fresh repos, then prints DEMO_REPO_PATH
 *   npm run fixture -w watcher -- play <step>... [--dir <path>]
 *   npm run fixture -w watcher -- reset [--dir <path>]      clones and main back to the baseline,
 *                                                           wip branches deleted, reset_all
 *   --dir defaults to <os tmp>/cowork-fixture. Run the watcher with DEMO_REPO_PATH=<dir>/watcher.
 *
 * STEPS (the demo is b-idle, a-ms, then b-fix; the others test one rule each)
 *   b-idle   b adds src/sessions/idle.ts and its test, assuming lastLogin is in seconds. Green alone.
 *   a-ms     a switches lastLogin to milliseconds and updates every caller it can see. Green alone.
 *            With b-idle: one "pair" conflict a x b, error in b's idle test, fixer b.
 *   b-fix    b pulls a's snapshot into its working tree (what the pull_teammate tool does) and fixes
 *            idle.ts. Everything green again: the conflict resolves.
 *   b-cheat  instead of fixing, b deletes its idle test. The guard sends the conflict to a person.
 *   c-self   c breaks its own module (a type error). One "self" conflict, fixer c.
 *   c-unself c undoes that.
 *   merge    a, then b, change the same line of session.ts (the timeout, to values its tests still
 *            accept). Both green alone; one "merge" conflict, fixer b (pushed last).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { callReducer } from "../../shared/src/stdb-http.ts";
import { config, missingSettings } from "../../shared/src/config.ts";
import { wipBranch } from "../../shared/src/schema.ts";
import { git } from "./git.ts";

const AGENTS = ["a", "b", "c"] as const;
type Agent = (typeof AGENTS)[number];

const BASELINE: Record<string, string> = {
  ".gitignore": "node_modules\n",
  "package.json": `${JSON.stringify(
    {
      name: "cowork-fixture",
      private: true,
      type: "module",
      scripts: { typecheck: "tsc --noEmit", test: "vitest run" },
      devDependencies: { typescript: "^7.0.2", vitest: "^5.0.5" },
    },
    null,
    2,
  )}\n`,
  "tsconfig.json": `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`,
  "vitest.config.ts": `import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
`,
  "src/contracts/user.ts": `/** The shared User type every module reads. */
export interface User {
  id: string;
  name: string;
  /** Last login, in seconds since the Unix epoch. */
  lastLogin: number;
  logins: number;
}
`,
  "src/users/user.ts": `import type { User } from "../contracts/user";

/** Creates a user who has never logged in. */
export function createUser(id: string, name: string): User {
  return { id, name, lastLogin: 0, logins: 0 };
}

/**
 * Records a login at the given time.
 * Updates the login count and the last login time.
 */
export function recordLogin(u: User, at: Date): User {
  u.logins += 1;
  u.lastLogin = Math.floor(at.getTime() / 1000);
  return u;
}
`,
  "src/users/user.test.ts": `import { describe, expect, it } from "vitest";
import { createUser, recordLogin } from "./user";

describe("recordLogin", () => {
  it("stores the login time and counts logins", () => {
    const u = recordLogin(createUser("u1", "Ada"), new Date("2026-10-24T12:00:00Z"));
    expect(u.lastLogin).toBe(1792843200);
    expect(u.logins).toBe(1);
  });
});
`,
  "src/sessions/session.ts": `import type { User } from "../contracts/user";

/** Minutes of inactivity after which a session expires. */
export const SESSION_TIMEOUT_MINUTES = 30;

/** True when the user's last login is older than the session timeout. */
export function isSessionExpired(u: User, now: Date): boolean {
  const elapsedSeconds = now.getTime() / 1000 - u.lastLogin;
  return elapsedSeconds > SESSION_TIMEOUT_MINUTES * 60;
}
`,
  "src/sessions/session.test.ts": `import { describe, expect, it } from "vitest";
import { createUser, recordLogin } from "../users/user";
import { isSessionExpired } from "./session";

describe("isSessionExpired", () => {
  const u = recordLogin(createUser("u1", "Ada"), new Date("2026-10-24T12:00:00Z"));

  it("keeps a fresh session", () => {
    expect(isSessionExpired(u, new Date("2026-10-24T12:10:00Z"))).toBe(false);
  });

  it("expires after the timeout", () => {
    expect(isSessionExpired(u, new Date("2026-10-24T12:31:00Z"))).toBe(true);
  });
});
`,
  "src/analytics/activity.ts": `import type { User } from "../contracts/user";

/** How many users logged in at or after \`since\`. */
export function activeSince(users: User[], since: Date): number {
  const sinceSeconds = since.getTime() / 1000;
  return users.filter((u) => u.lastLogin >= sinceSeconds).length;
}
`,
  "src/analytics/activity.test.ts": `import { describe, expect, it } from "vitest";
import { createUser, recordLogin } from "../users/user";
import { activeSince } from "./activity";

describe("activeSince", () => {
  it("counts users who logged in since a time", () => {
    const early = recordLogin(createUser("u1", "Ada"), new Date("2026-10-24T08:00:00Z"));
    const late = recordLogin(createUser("u2", "Grace"), new Date("2026-10-24T12:00:00Z"));
    expect(activeSince([early, late], new Date("2026-10-24T10:00:00Z"))).toBe(1);
  });
});
`,
  "src/api/routes.ts": `import type { User } from "../contracts/user";

/** The user JSON the frontend reads. The frontend works in milliseconds. */
export function userJson(u: User) {
  return { id: u.id, name: u.name, lastLoginMs: u.lastLogin * 1000 };
}
`,
};

const IDLE = `import type { User } from "../contracts/user";

/**
 * Whole minutes since the user's last login, for the "idle for N minutes" badge.
 */
export function minutesSinceLastLogin(u: User, now: Date): number {
  return Math.floor((now.getTime() / 1000 - u.lastLogin) / 60);
}
`;

const IDLE_TEST = `import { describe, expect, it } from "vitest";
import { createUser, recordLogin } from "../users/user";
import { minutesSinceLastLogin } from "./idle";

describe("minutesSinceLastLogin", () => {
  it("counts minutes since login", () => {
    const u = recordLogin(createUser("u1", "Ada"), new Date("2026-10-24T12:00:00Z"));
    const now = new Date("2026-10-24T12:31:00Z");

    expect(minutesSinceLastLogin(u, now)).toBe(31);
  });
});
`;

type Step = (dir: string) => Promise<Agent[]>;

const STEPS: Record<string, Step> = {
  "b-idle": async (dir) => {
    write(dir, "b", "src/sessions/idle.ts", IDLE);
    write(dir, "b", "src/sessions/idle.test.ts", IDLE_TEST);
    return ["b"];
  },
  "a-ms": async (dir) => {
    edit(dir, "a", "src/contracts/user.ts", "in seconds since the Unix epoch", "in milliseconds since the Unix epoch");
    edit(dir, "a", "src/users/user.ts", "Math.floor(at.getTime() / 1000)", "at.getTime()");
    edit(dir, "a", "src/users/user.test.ts", "toBe(1792843200)", "toBe(1792843200000)");
    edit(
      dir,
      "a",
      "src/sessions/session.ts",
      "const elapsedSeconds = now.getTime() / 1000 - u.lastLogin;\n  return elapsedSeconds > SESSION_TIMEOUT_MINUTES * 60;",
      "const elapsedMs = now.getTime() - u.lastLogin;\n  return elapsedMs > SESSION_TIMEOUT_MINUTES * 60_000;",
    );
    edit(
      dir,
      "a",
      "src/analytics/activity.ts",
      "const sinceSeconds = since.getTime() / 1000;\n  return users.filter((u) => u.lastLogin >= sinceSeconds).length;",
      "return users.filter((u) => u.lastLogin >= since.getTime()).length;",
    );
    edit(dir, "a", "src/api/routes.ts", "lastLoginMs: u.lastLogin * 1000", "lastLoginMs: u.lastLogin");
    return ["a"];
  },
  "b-fix": async (dir) => {
    await pullTeammate(dir, "b", "a");
    edit(dir, "b", "src/sessions/idle.ts", "(now.getTime() / 1000 - u.lastLogin) / 60", "(now.getTime() - u.lastLogin) / 60_000");
    return ["b"];
  },
  "b-cheat": async (dir) => {
    rmSync(path.join(dir, "b", "src/sessions/idle.test.ts"));
    return ["b"];
  },
  "c-self": async (dir) => {
    edit(dir, "c", "src/analytics/activity.ts", ".length;", ".length.toString();");
    return ["c"];
  },
  "c-unself": async (dir) => {
    edit(dir, "c", "src/analytics/activity.ts", ".length.toString();", ".length;");
    return ["c"];
  },
  merge: async (dir) => {
    edit(dir, "a", "src/sessions/session.ts", "SESSION_TIMEOUT_MINUTES = 30", "SESSION_TIMEOUT_MINUTES = 25");
    await snapshotAndPost(dir, "a");
    edit(dir, "b", "src/sessions/session.ts", "SESSION_TIMEOUT_MINUTES = 30", "SESSION_TIMEOUT_MINUTES = 20");
    return ["b"];
  },
};

function clone(dir: string, agent: Agent | "watcher"): string {
  return path.join(dir, agent);
}

function write(dir: string, agent: Agent, file: string, content: string): void {
  const target = path.join(clone(dir, agent), file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function edit(dir: string, agent: Agent, file: string, from: string, to: string): void {
  const target = path.join(clone(dir, agent), file);
  const before = readFileSync(target, "utf8");
  if (!before.includes(from)) throw new Error(`${agent}: ${file} doesn't contain ${JSON.stringify(from)}`);
  writeFileSync(target, before.replace(from, to));
}

function identity(name: string): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: "cowork@localhost",
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: "cowork@localhost",
  };
}

/** What the pull_teammate MCP tool does: apply the teammate's snapshot diff to this working tree. */
async function pullTeammate(dir: string, agent: Agent, teammate: Agent): Promise<void> {
  const cwd = clone(dir, agent);
  await git(["fetch", "--quiet", "origin", wipBranch(teammate)], { cwd });
  const base = (await git(["merge-base", "origin/main", "FETCH_HEAD"], { cwd })).stdout.trim();
  const diff = (await git(["diff", "--binary", base, "FETCH_HEAD"], { cwd })).stdout;
  await git(["apply", "--3way"], { cwd, input: diff });
}

/** The commands from hooks/src/lib/snapshot.ts: temp index, write-tree, commit-tree, force-push. */
async function snapshotAndPost(dir: string, agent: Agent): Promise<void> {
  const cwd = clone(dir, agent);
  const gitDir = (await git(["rev-parse", "--absolute-git-dir"], { cwd })).stdout.trim();
  const tmpIndex = path.join(gitDir, `cowork-index-${process.pid}`);
  let tree: string;
  try {
    if (existsSync(path.join(gitDir, "index"))) copyFileSync(path.join(gitDir, "index"), tmpIndex);
    await git(["add", "-A"], { cwd, env: { GIT_INDEX_FILE: tmpIndex } });
    tree = (await git(["write-tree"], { cwd, env: { GIT_INDEX_FILE: tmpIndex } })).stdout.trim();
  } finally {
    rmSync(tmpIndex, { force: true });
  }
  const message = `wip ${agent} ${new Date().toISOString()}`;
  const sha = (await git(["commit-tree", tree, "-p", "HEAD", "-m", message], { cwd, env: identity(`cowork-${agent}`) })).stdout.trim();
  await git(["push", "--force", "--quiet", "origin", `${sha}:refs/heads/${wipBranch(agent)}`], { cwd });
  const baseSha = (await git(["merge-base", "HEAD", "origin/main"], { cwd })).stdout.trim();
  const files = (await git(["diff", "--name-only", baseSha, sha], { cwd })).stdout.split("\n").filter(Boolean);
  const diff = (await git(["diff", baseSha, sha], { cwd })).stdout.slice(0, 50 * 1024);
  await callReducer("post_snapshot", [agent, sha, baseSha, files, diff]);
  console.log(`${agent}: pushed ${wipBranch(agent)} ${sha.slice(0, 8)} (${files.join(", ") || "no changes"})`);
}

async function setup(dir: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const remote = path.join(dir, "remote.git");
  const seed = path.join(dir, "seed");
  await git(["init", "--bare", "--quiet", "--initial-branch=main", remote], { cwd: dir });
  await git(["init", "--quiet", "--initial-branch=main", seed], { cwd: dir });
  for (const [file, content] of Object.entries(BASELINE)) {
    mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    writeFileSync(path.join(seed, file), content);
  }
  await git(["add", "-A"], { cwd: seed });
  await git(["commit", "--quiet", "-m", "baseline"], { cwd: seed, env: identity("fixture") });
  await git(["tag", "demo-base"], { cwd: seed });
  await git(["push", "--quiet", remote, "main", "demo-base"], { cwd: seed });
  rmSync(seed, { recursive: true, force: true });
  for (const name of ["watcher", ...AGENTS] as const) {
    await git(["clone", "--quiet", remote, clone(dir, name)], { cwd: dir });
  }
  console.log("Installing typescript and vitest in the watcher's clone...");
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: clone(dir, "watcher"),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (install.status !== 0) throw new Error("npm install failed in the watcher's clone");
  console.log(`\nFixture ready in ${dir}. Run the watcher with:\n  DEMO_REPO_PATH=${clone(dir, "watcher")}`);
}

async function reset(dir: string): Promise<void> {
  const remote = path.join(dir, "remote.git");
  await git(["update-ref", "refs/heads/main", "refs/tags/demo-base"], { cwd: remote });
  for (const agent of AGENTS) {
    const cwd = clone(dir, agent);
    await git(["push", "--quiet", "origin", "--delete", wipBranch(agent)], { cwd, allowFail: true });
    await git(["fetch", "--quiet", "origin"], { cwd });
    await git(["reset", "--hard", "--quiet", "origin/main"], { cwd });
    await git(["clean", "-fdq"], { cwd });
  }
  await callReducer("reset_all", []);
  console.log("Fixture reset: clones on the baseline, no wip branches, tables cleared.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf("--dir");
  const dir = path.resolve(dirFlag >= 0 && args[dirFlag + 1] ? args[dirFlag + 1]! : path.join(os.tmpdir(), "cowork-fixture"));
  const rest = args.filter((_, i) => i !== dirFlag && i !== dirFlag + 1);
  const [command, ...steps] = rest;

  if (command === "setup") return setup(dir);

  const missing = missingSettings(["stdbDb", "stdbToken"]);
  if (missing.length > 0) throw new Error(`Set ${missing.join(", ")} first (.env or the environment).`);
  if (command === "reset") return reset(dir);
  if (command === "play" && steps.length > 0) {
    for (const name of steps) {
      const step = STEPS[name];
      if (!step) throw new Error(`Unknown step ${name}. Steps: ${Object.keys(STEPS).join(", ")}`);
      for (const agent of await step(dir)) await snapshotAndPost(dir, agent);
    }
    return;
  }
  console.log(`Usage: fixture setup | play <${Object.keys(STEPS).join("|")}>... | reset   [--dir <path>]`);
  console.log(`Database: ${config.stdbHost} ${config.stdbDb}`);
}

await main();
