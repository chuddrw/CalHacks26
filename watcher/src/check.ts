/**
 * watcher/src/check.ts
 *
 * WHAT IT'S FOR
 *   Runs the two checks that decide red or green, the type checker and the tests, inside one
 *   worktree, and turns their output into structured errors with file and line.
 *
 * OWNER: B. WHEN: tonight (spike.ts uses the tsc half), Sat 9:20-13:00.
 * DONE WHEN: on the demo scenario, the combined worktree gives one failing test in
 *            src/sessions/idle.test.ts with a line number, and each snapshot alone is green.
 *
 * WHAT TO EXPORT
 *   runChecks(worktree): Promise<CheckOutcome>
 *     ok         true when tsc and vitest both pass
 *     tscErrors  { file, line, col, code, message }[]
 *     testFails  { file, test, message, line }[]
 *     log        the combined raw output, cut to 20 KB (goes into check_run.log)
 *
 * COMMANDS (run tsc and vitest in parallel, 60 s timeout each; no shell, use node + script path)
 *   node <DEMO_REPO_PATH>/node_modules/typescript/bin/tsc --noEmit -p <worktree>
 *   node <DEMO_REPO_PATH>/node_modules/vitest/vitest.mjs run --root <worktree> --reporter=json --outputFile=<tmp>.json
 *   Calling node directly avoids the .cmd shims that can't be spawned without a shell on Windows.
 *   Versions npm installed on Oct 24: typescript 7.0.2, vitest 5.0.5. Both commands above were run
 *   against them on the demo scenario.
 *
 * PARSING (checked on the demo scenario with vitest 5.0.5)
 *   tsc lines look like:  src/sessions/idle.ts(7,10): error TS2345: Argument of type ...
 *     regex  ^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$
 *   vitest 5 writes its JSON report to a FILE, not stdout. Without --outputFile it creates
 *   <worktree>/.vitest/json/output.json, so always pass --outputFile with a path under os.tmpdir(),
 *   read it, then delete it. Shape (Jest-style):
 *     { success, numFailedTests, testResults[] -> { name, status, message,
 *       assertionResults[] -> { fullName, status, failureMessages[] } } }
 *   assertionResults[].location is undefined, so take the line from failureMessages: the first stack
 *   frame that matches src/...ts:<line>:<col>. On the demo scenario that's src/sessions/idle.test.ts:10:88,
 *   and the first message line is "AssertionError: expected -29850839249 to be 31".
 *   Make file paths relative to the worktree, with forward slashes.
 *
 * NOTES
 *   - A crash (non-zero exit, no parsable output) counts as red with one error, "check crashed",
 *     plus the first 2 KB of stderr.
 *   - Delete the --outputFile report after reading it, every time. No leftover files.
 */

// TODO (B): runChecks() as described above.
export {};
