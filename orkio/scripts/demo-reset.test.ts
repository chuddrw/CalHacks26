/** WHAT IT'S FOR: non-destructive reset safety tests using temporary repositories and fake mutations. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../shared/src/config.ts";
import { buildPlan, executePlan, parseOptions } from "./demo-reset.ts";

function fixture() {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cowork-reset-test-"));
  function repo(name: string, url: string) {
    const directory = path.join(temporary, name);
    mkdirSync(directory);
    const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
    git("init");
    git("remote", "add", "origin", url);
    git("-c", "user.name=Reset Test", "-c", "user.email=reset@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    git("tag", "demo-base");
    return { directory, git };
  }
  const root = repo("tool", "https://example.invalid/tool.git");
  const demo = repo("demo", "https://example.invalid/demo.git");
  const second = repo("second", "https://example.invalid/demo.git");
  return {
    temporary, root, demo, second,
    settings: { ...config, repoRoot: root.directory, demoRepoPath: demo.directory, stdbDb: "test-only" },
    options: parseOptions(["--agents", "a,b", "--clones", `${demo.directory},${second.directory}`]),
  };
}

test("requires explicit targets and rejects unsafe or misspelled arguments", () => {
  for (const args of [[], ["--agents", "a", "--clones", "/tmp", "--yse"], ["--agents", "../bad", "--clones", "/tmp"], ["--agents", "a,", "--clones", "/tmp"]]) {
    assert.throws(() => parseOptions(args));
  }
  assert.equal(parseOptions(["--agents", "a", "--clones", "/tmp"]).yes, false);
});

test("preflights every clone, force-main tag and repository identity", () => {
  const f = fixture();
  try {
    const plan = buildPlan({ ...f.options, resetMain: true }, f.settings);
    assert.deepEqual(plan.branches, ["wip/a", "wip/b"]);
    assert.equal(plan.mainCommit, f.demo.git("rev-parse", "demo-base"));
    writeFileSync(path.join(f.second.directory, "uncommitted.txt"), "preserve me");
    assert.throws(() => buildPlan(f.options, f.settings), /uncommitted work/);
    assert.throws(() => buildPlan({ ...f.options, clones: [f.root.directory] }, f.settings), /repo 1/);
    assert.throws(() => buildPlan(f.options, { ...f.settings, demoRepoPath: f.root.directory }), /repo 1/);
  } finally { rmSync(f.temporary, { recursive: true, force: true }); }
});

test("rejects a changed push URL and missing demo-base tag", () => {
  const f = fixture();
  try {
    f.second.git("remote", "set-url", "--push", "origin", "https://example.invalid/other.git");
    assert.throws(() => buildPlan(f.options, f.settings), /remote does not match/);
    f.demo.git("tag", "-d", "demo-base");
    assert.throws(() => buildPlan({ ...f.options, clones: [f.demo.directory], resetMain: true }, f.settings));
  } finally { rmSync(f.temporary, { recursive: true, force: true }); }
});

test("execution targets only requested refs and the two exact state files", async () => {
  const f = fixture();
  try {
    const plan = buildPlan({ ...f.options, resetMain: true }, f.settings);
    const calls: unknown[][] = [];
    await executePlan(plan, {
      async resetDatabase() { calls.push(["db"]); },
      deleteBranch(...args) { calls.push(["branch", ...args]); },
      removeState(file) { calls.push(["state", file]); },
      resetMain(...args) { calls.push(["main", ...args]); },
    });
    assert.deepEqual(calls, [
      ["db"],
      ...plan.branches.map((branch) => ["branch", plan.clones[0]!.directory, "origin", branch]),
      ...plan.clones.flatMap((clone) => ["cowork-last-tree", "cowork-listener.pid"].map((file) => ["state", path.join(clone.gitDir, file)])),
      ["main", plan.clones[0]!.directory, "origin", plan.mainCommit],
    ]);
  } finally { rmSync(f.temporary, { recursive: true, force: true }); }
});

test("database failure prevents every later mutation", async () => {
  const f = fixture();
  try {
    const plan = buildPlan(f.options, f.settings);
    let changed = false;
    const mutation = () => { changed = true; };
    await assert.rejects(executePlan(plan, {
      async resetDatabase() { throw new Error("unavailable"); },
      deleteBranch: mutation, removeState: mutation, resetMain: mutation,
    }), /unavailable/);
    assert.equal(changed, false);
  } finally { rmSync(f.temporary, { recursive: true, force: true }); }
});
