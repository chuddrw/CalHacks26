/** WHAT IT'S FOR: reset safety/component coverage with isolated source copies, local git fixtures,
 * and fake mutations; never loads the user's .env, calls a database, or pushes a remote.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { recordCoverageCopy, coverageChildEnvironment } from "../module/tests/coverage-source.mjs";
import type { ResetActions } from "./demo-reset.ts";

const isolated = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cowork-reset-source-")));
for (const directory of ["scripts", "shared/src"]) mkdirSync(path.join(isolated, directory), { recursive: true });
for (const file of ["scripts/demo-reset.ts", "shared/src/config.ts", "shared/src/schema.ts", "shared/src/stdb-http.ts"]) {
  copyFileSync(path.resolve(import.meta.dirname, "..", file), path.join(isolated, file));
  recordCoverageCopy(path.resolve(import.meta.dirname, "..", file), path.join(isolated, file));
}
writeFileSync(path.join(isolated, "package.json"), '{"type":"module"}');
writeFileSync(path.join(isolated, ".env"), "# Isolated fixture only; no credentials.\n");
execFileSync("git", ["-C", isolated, "init"], { stdio: "pipe" });
const { buildPlan, executePlan, parseOptions } = await import(pathToFileURL(path.join(isolated, "scripts/demo-reset.ts")).href);
after(() => rmSync(isolated, { recursive: true, force: true }));

function fixture(t: { after(fn: () => void): void }) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cowork-reset-safety-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const hooks = path.join(temporary, "empty-hooks");
  mkdirSync(hooks);
  function repo(name: string, url: string) {
    const directory = path.join(temporary, name);
    mkdirSync(directory);
    const git = (...args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false", "-C", directory, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
    git("init");
    git("remote", "add", "origin", url);
    writeFileSync(path.join(directory, "tracked.txt"), "keep original\n");
    git("add", "tracked.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
    return { directory, git };
  }
  const root = repo("tool", "https://example.invalid/tool.git");
  const demo = repo("demo", "https://example.invalid/demo.git");
  const second = repo("second", "https://example.invalid/demo.git");
  const settings = {
    repoRoot: root.directory, agent: "fixture", stdbHost: "https://example.invalid", stdbDb: "fixture-only", stdbToken: "fixture-not-a-token",
    gitRemote: "origin", mainBranch: "main", listenerMinutes: 25, demoRepoPath: demo.directory, checkDebounceMs: 2000,
    diagnoseWith: "droid" as const, factoryApiKey: "", droidModelId: "", anthropicApiKey: "", claudeModel: "fixture",
  };
  const options = parseOptions(["--agents", "a,b", "--clones", `${demo.directory},${second.directory}`]);
  return { temporary, root, demo, second, settings, options };
}

for (const change of ["unstaged", "staged", "deleted"] as const) {
  test(`preflight refuses ${change} tracked work in a later clone without touching it`, t => {
    const f = fixture(t);
    const tracked = path.join(f.second.directory, "tracked.txt");
    if (change === "deleted") f.second.git("rm", "tracked.txt");
    else {
      writeFileSync(tracked, "preserve this work\n");
      if (change === "staged") f.second.git("add", "tracked.txt");
    }
    const before = f.second.git("status", "--porcelain");
    assert.throws(() => buildPlan(f.options, f.settings), /uncommitted work/);
    assert.equal(f.second.git("status", "--porcelain"), before);
    if (change !== "deleted") assert.equal(readFileSync(tracked, "utf8"), "preserve this work\n");
  });
}

test("realpath checks reject repo 1 reached by a symlink and a clone subdirectory", t => {
  const f = fixture(t);
  const alias = path.join(f.temporary, "root-alias");
  symlinkSync(f.root.directory, alias, "dir");
  const nested = path.join(f.demo.directory, "nested");
  mkdirSync(nested);
  assert.throws(() => buildPlan({ ...f.options, clones: [alias] }, f.settings), /repo 1/);
  assert.throws(() => buildPlan(f.options, { ...f.settings, demoRepoPath: alias }), /repo 1/);
  assert.throws(() => buildPlan({ ...f.options, clones: [nested] }, f.settings), /subdirectory/);
});

test("multiple push destinations are rejected for either configured demo or supplied clone", t => {
  const f = fixture(t);
  f.second.git("remote", "set-url", "--add", "--push", "origin", "https://example.invalid/demo.git");
  f.second.git("remote", "set-url", "--add", "--push", "origin", "https://example.invalid/extra.git");
  assert.throws(() => buildPlan(f.options, f.settings), /Expected one push URL/);
  assert.throws(() => buildPlan({ ...f.options, clones: [f.demo.directory] }, { ...f.settings, demoRepoPath: f.second.directory }), /Expected one push URL/);
});

test("repo 1 remote equality is detected after harmless .git and trailing-slash normalization", t => {
  const f = fixture(t);
  f.root.git("remote", "set-url", "origin", "https://example.invalid/demo/");
  assert.throws(() => buildPlan(f.options, f.settings), /matches repo 1/);
});

test("repo 1 protection inspects different remote names and every mirror push destination", t => {
  const f = fixture(t);
  f.demo.git("remote", "rename", "origin", "team");
  f.demo.git("remote", "set-url", "team", "https://example.invalid/tool.git");
  const options = { ...f.options, clones: [f.demo.directory] };
  assert.throws(() => buildPlan(options, { ...f.settings, gitRemote: "team" }), /matches repo 1/);
  f.root.git("remote", "set-url", "--add", "--push", "origin", "https://example.invalid/mirror.git");
  f.root.git("remote", "set-url", "--add", "--push", "origin", "https://example.invalid/tool.git");
  assert.throws(() => buildPlan(options, { ...f.settings, gitRemote: "team" }), /matches repo 1/);
});

test("repo 1 lookup failures stop preflight rather than bypassing protection", t => {
  const f = fixture(t);
  const unreadableRepository = path.join(f.temporary, "not-a-repository");
  mkdirSync(unreadableRepository);
  assert.throws(() => buildPlan(f.options, { ...f.settings, repoRoot: unreadableRepository }), /not a git repository/);
});

test("repo 1 without any remotes remains valid", t => {
  const f = fixture(t);
  f.root.git("remote", "remove", "origin");
  assert.equal(buildPlan(f.options, f.settings).remoteUrl, "https://example.invalid/demo");
});

test("symlink script invocation executes validation instead of silently exiting successfully", t => {
  const f = fixture(t);
  const alias = path.join(f.temporary, "source-alias");
  symlinkSync(isolated, alias, "dir");
  const result = spawnSync(process.execPath, [path.join(alias, "scripts/demo-reset.ts")], {
    encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: npm run reset/);
});

test("dry-run CLI preflights real fixtures while leaving all state files and refs intact", t => {
  const f = fixture(t);
  const state = path.join(f.demo.git("rev-parse", "--absolute-git-dir"), "cowork-last-tree");
  writeFileSync(state, "preserve-state");
  const before = f.demo.git("show-ref");
  const output = execFileSync(process.execPath, [path.join(isolated, "scripts/demo-reset.ts"), "--agents", "a,b", "--clones", f.demo.directory], {
    cwd: f.second.directory, encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, ...coverageChildEnvironment(), DEMO_REPO_PATH: f.demo.directory, STDB_DB: "dry-run-only", GIT_REMOTE: "origin" },
  });
  assert.match(output, /Dry run: database dry-run-only/);
  assert.match(output, /No changes made/);
  assert.equal(readFileSync(state, "utf8"), "preserve-state");
  assert.equal(f.demo.git("show-ref"), before);
});

test("branch deletion failure stops before any state removal or main force push", async t => {
  const f = fixture(t);
  f.demo.git("tag", "demo-base");
  const plan = buildPlan({ ...f.options, resetMain: true }, f.settings);
  const calls: string[] = [];
  const actions: ResetActions = {
    async resetDatabase() { calls.push("database"); },
    deleteBranch(_directory, _remote, branch) {
      calls.push(branch);
      if (branch === "wip/b") throw new Error("simulated remote failure");
    },
    removeState() { calls.push("state"); },
    resetMain() { calls.push("main"); },
  };
  await assert.rejects(executePlan(plan, actions), /simulated remote failure/);
  assert.deepEqual(calls, ["database", "wip/a", "wip/b"]);
});

test("state-file removal failure stops before resetting main", async t => {
  const f = fixture(t);
  f.demo.git("tag", "demo-base");
  const plan = buildPlan({ ...f.options, resetMain: true }, f.settings);
  let forced = false;
  await assert.rejects(executePlan(plan, {
    async resetDatabase() {}, deleteBranch() {},
    removeState() { throw new Error("simulated permissions failure"); },
    resetMain() { forced = true; },
  }), /simulated permissions failure/);
  assert.equal(forced, false);
});
