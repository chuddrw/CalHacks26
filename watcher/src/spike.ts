/**
 * watcher/src/spike.ts
 *
 * WHAT IT'S FOR
 *   The first proof for B, with no database involved: given two branch names, merge both onto main
 *   in a throwaway worktree, run tsc and vitest, print the result, and clean up. It now runs on the
 *   same git.ts and check.ts the watcher uses, so it's also the quickest way to test those two.
 *
 * OWNER: B.
 * USAGE (from the repo root): npm run spike:watcher -- <branch-a> <branch-b>
 *   Branch names on the remote, e.g. wip/a wip/b. On the fixture (watcher/src/fixture.ts, steps
 *   b-idle and a-ms) it prints "merge ok" twice, tsc clean, and one failing vitest test in
 *   src/sessions/idle.test.ts:10.
 * DONE WHEN: it prints "merge ok" for both branches plus a tsc result and a vitest result, and
 *            `git worktree list` in DEMO_REPO_PATH shows nothing extra afterwards.
 *
 * STEPS
 *   1. git -C <DEMO_REPO_PATH> fetch <remote>
 *   2. git.makeWorktree("spike"): a detached worktree at <remote>/<main>, node_modules linked
 *   3. git.mergeInto() <remote>/<branch-a>, then <remote>/<branch-b>; print the result of each
 *   4. check.runChecks(): tsc and vitest in parallel; print the errors
 *   5. In a finally block: git.removeWorktree()
 */
import { config, missingSettings } from "../../shared/src/config.ts";
import { firstError, runChecks } from "./check.ts";
import { git, makeWorktree, mergeInto, removeWorktree } from "./git.ts";

async function main(): Promise<number> {
  const branches = process.argv.slice(2);
  if (branches.length !== 2) {
    console.error("Usage: npm run spike:watcher -- <branch-a> <branch-b>");
    return 1;
  }
  const missing = missingSettings(["demoRepoPath"]);
  if (missing.length > 0) {
    console.error(`Set ${missing.join(", ")} first (.env).`);
    return 1;
  }

  await git(["fetch", "--quiet", config.gitRemote]);
  const dir = await makeWorktree("spike");
  try {
    for (const branch of branches) {
      const merged = await mergeInto(dir, `refs/remotes/${config.gitRemote}/${branch}`);
      if (!merged.ok) {
        console.log(`${branch}: merge conflict in ${merged.files.join(", ")}`);
        return 0;
      }
      console.log(`${branch}: merge ok`);
    }

    const started = Date.now();
    const outcome = await runChecks(dir);
    console.log(`\nChecked in ${((Date.now() - started) / 1000).toFixed(1)} s: ${outcome.ok ? "green" : "red"}`);
    console.log(
      outcome.tscErrors.length === 0
        ? "tsc: no errors"
        : `tsc: ${outcome.tscErrors.length} error(s)\n${outcome.tscErrors.map((e) => `  ${e.file}:${e.line} ${e.code} ${e.message}`).join("\n")}`,
    );
    console.log(
      outcome.testFails.length === 0
        ? "vitest: no failing tests"
        : `vitest: ${outcome.testFails.length} failing test(s)\n${outcome.testFails
            .map((f) => `  ${f.file}:${f.line} ${f.test}\n    ${f.message.split("\n")[0]}`)
            .join("\n")}`,
    );
    if (outcome.crash) console.log(`crash: ${outcome.crash}`);
    const first = firstError(outcome);
    if (first) console.log(`\nThe conflict would be about ${first.loc || "(no location)"}:\n${first.text}`);
    return 0;
  } finally {
    await removeWorktree(dir);
  }
}

process.exitCode = await main();
