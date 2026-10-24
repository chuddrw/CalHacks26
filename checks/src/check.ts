/**
 * checks/src/check.ts
 *
 * WHAT IT'S FOR
 *   Runs the two checks that decide red or green, the type checker and the tests, inside one
 *   worktree, and turns their output into structured errors with file and line.
 *
 * OWNER: B. WHEN: tonight (spike.ts uses the tsc half), Sat 9:20-13:00.
 * DONE WHEN: on the demo scenario, the combined worktree gives one failing test in
 *            src/sessions/idle.test.ts with a line number, and each snapshot alone is green.
 *            (Checked on the watcher/src/fixture.ts copy of the scenario.)
 *
 * WHAT IT EXPORTS
 *   runChecks(worktree): Promise<CheckOutcome>
 *     ok         true when tsc and vitest both pass
 *     tscErrors  { file, line, col, code, message }[]
 *     testFails  { file, test, message, line, frames }[]   line = first frame in the test file
 *     crash      why a tool died without a usable result, "" if it didn't
 *     log        tsc's and vitest's readable output, cut to 20 KB (goes into check_run.log)
 *   firstError(outcome)           { loc: "file:line", text } of the error a conflict is about
 *   failureSignatures(outcome)    one string per failure, without line numbers, for comparing runs
 *   withoutKnown(outcome, known)  the outcome minus failures whose signature is in `known`
 *   describeFailures(outcome)     every failure as plain text, cut to 4 KB, for the diagnosis prompt
 *
 * COMMANDS (tsc and vitest in parallel, 60 s timeout each; no shell, node + script path)
 *   cwd <worktree>: node <DEMO_REPO_PATH>/node_modules/typescript/bin/tsc --noEmit --pretty false -p .
 *   node <DEMO_REPO_PATH>/node_modules/vitest/vitest.mjs run --root <worktree> --reporter=default
 *     --reporter=json --outputFile.json=<tmp>.json --passWithNoTests --no-cache --no-fsModuleCache
 *   Calling node directly avoids the .cmd shims that can't be spawned without a shell on Windows.
 *   Every worktree links the same node_modules, so vitest's two caches (both under node_modules)
 *   are turned off: parallel runs would share them. tsc is skipped when there's no tsconfig.json.
 *   Versions: typescript 7.0.2, vitest 5.0.5.
 *
 * PARSING (checked with tsc 7.0.2 and vitest 5.0.5)
 *   tsc lines, paths relative to the cwd:
 *     src/analytics/activity.ts(5,3): error TS2322: Type 'string' is not assignable to type 'number'.
 *     regex  ^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$   indented lines continue the message
 *   vitest writes the JSON report to the --outputFile, read it then delete it. Shape (Jest-style):
 *     { success, testResults[] -> { name, status, message,
 *       assertionResults[] -> { ancestorTitles, title, status, failureMessages[] } } }
 *   - name is the absolute path after symlinks (/private/tmp/... on macOS), so both the worktree path
 *     and its real path are stripped. Paths come out relative, with forward slashes.
 *   - failureMessages[0] is the message, then the stack. The line comes from the stack frames that
 *     point into the worktree (node_modules skipped). Fixture demo:
 *     "AssertionError: expected -29850839249 to be 31 // Object.is equality" at idle.test.ts:10:43.
 *   - A test file that fails to load has status "failed", a message, and no assertionResults:
 *     it becomes one failure named "(file failed to load)".
 *
 * NOTES
 *   - A crash (timeout, or a non-zero exit with nothing parsable) counts as red with the reason in
 *     `crash` plus the first 2 KB of the tool's output.
 *   - The report file is deleted after every run, crash or not.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoPath } from "./git.ts";

const TIMEOUT_MS = 60_000;
const MAX_LOG = 20 * 1024;
const MAX_CRASH = 2 * 1024;
const MAX_MESSAGE_LINES = 12;
const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const TSC_GLOBAL = /^error (TS\d+): (.*)$/;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export interface Loc {
  file: string;
  line: number;
}

export interface TscError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

export interface TestFail {
  /** The test file, relative to the worktree. */
  file: string;
  /** describe blocks and the test title, joined with " > ". */
  test: string;
  /** The error message without its stack. */
  message: string;
  /** Line of the first stack frame in the test file itself, 0 if there is none. */
  line: number;
  /** Stack frames inside the worktree, innermost first. */
  frames: Loc[];
}

export interface CheckOutcome {
  ok: boolean;
  tscErrors: TscError[];
  testFails: TestFail[];
  crash: string;
  log: string;
}

interface ToolRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string;
}

let reportCounter = 0;

/** tsc and vitest in one worktree, in parallel. */
export async function runChecks(worktree: string): Promise<CheckOutcome> {
  const [tsc, vitest] = await Promise.all([runTsc(worktree), runVitest(worktree)]);
  const crash = [tsc.crash, vitest.crash].filter(Boolean).join("\n");
  const log = cut([tsc.log && `$ tsc\n${tsc.log}`, vitest.log && `$ vitest\n${vitest.log}`].filter(Boolean).join("\n\n"), MAX_LOG);
  return {
    ok: tsc.errors.length === 0 && vitest.fails.length === 0 && crash === "",
    tscErrors: tsc.errors,
    testFails: vitest.fails,
    crash,
    log,
  };
}

async function runTsc(worktree: string): Promise<{ errors: TscError[]; crash: string; log: string }> {
  if (!existsSync(path.join(worktree, "tsconfig.json"))) return { errors: [], crash: "", log: "" };
  const tsc = path.join(repo(), "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) return { errors: [], crash: `TypeScript isn't installed: run npm install in ${repo()}.`, log: "" };
  const run = await runNode(tsc, ["--noEmit", "--pretty", "false", "-p", "."], worktree);
  const output = clean(`${run.stdout}${run.stderr}`, worktree);
  const errors = parseTsc(output);
  let crash = "";
  if (run.spawnError) crash = `tsc couldn't start: ${run.spawnError}`;
  else if (run.timedOut) crash = `tsc took longer than ${TIMEOUT_MS / 1000} s.`;
  else if (run.code !== 0 && errors.length === 0) crash = `tsc exited with code ${run.code}: ${cut(output.trim(), MAX_CRASH)}`;
  return { errors, crash, log: output.trim() };
}

async function runVitest(worktree: string): Promise<{ fails: TestFail[]; crash: string; log: string }> {
  const vitest = path.join(repo(), "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitest)) return { fails: [], crash: `Vitest isn't installed: run npm install in ${repo()}.`, log: "" };
  const report = path.join(os.tmpdir(), `cowork-vitest-${process.pid}-${++reportCounter}.json`);
  try {
    const run = await runNode(
      vitest,
      [
        "run",
        "--root",
        worktree,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${report}`,
        "--passWithNoTests",
        "--no-cache",
        "--no-fsModuleCache",
      ],
      worktree,
    );
    const output = clean(`${run.stdout}${run.stderr}`, worktree).trim();
    if (run.spawnError) return { fails: [], crash: `vitest couldn't start: ${run.spawnError}`, log: output };
    if (run.timedOut) return { fails: [], crash: `vitest took longer than ${TIMEOUT_MS / 1000} s.`, log: output };
    let parsed: VitestReport;
    try {
      parsed = JSON.parse(readFileSync(report, "utf8")) as VitestReport;
    } catch {
      return { fails: [], crash: `vitest exited with code ${run.code} and no report: ${cut(output, MAX_CRASH)}`, log: output };
    }
    const fails = parseVitestReport(parsed, worktree);
    const crash =
      run.code !== 0 && fails.length === 0
        ? `vitest exited with code ${run.code} without a failing test: ${cut(errorExcerpt(output), MAX_CRASH)}`
        : "";
    return { fails, crash, log: output };
  } finally {
    rmSync(report, { force: true });
  }
}

/** Parses tsc --pretty false output. Paths stay as tsc printed them, with forward slashes. */
export function parseTsc(output: string): TscError[] {
  const errors: TscError[] = [];
  for (const line of output.split(/\r?\n/)) {
    const located = TSC_LINE.exec(line);
    if (located) {
      errors.push({
        file: located[1]!.replaceAll("\\", "/"),
        line: Number(located[2]),
        col: Number(located[3]),
        code: located[4]!,
        message: located[5]!,
      });
      continue;
    }
    const global = TSC_GLOBAL.exec(line);
    if (global) {
      errors.push({ file: "", line: 0, col: 0, code: global[1]!, message: global[2]! });
      continue;
    }
    const last = errors[errors.length - 1];
    if (last && /^\s+\S/.test(line)) last.message += `\n${line.trim()}`;
  }
  return errors;
}

interface VitestReport {
  success?: boolean;
  testResults?: {
    name: string;
    status?: string;
    message?: string;
    assertionResults?: {
      ancestorTitles?: string[];
      title?: string;
      fullName?: string;
      status?: string;
      failureMessages?: string[];
    }[];
  }[];
}

/** Turns vitest's JSON report into failures with paths relative to the worktree. */
export function parseVitestReport(report: VitestReport, worktree: string): TestFail[] {
  const roots = worktreeRoots(worktree);
  const fails: TestFail[] = [];
  for (const result of report.testResults ?? []) {
    const file = relativeTo(roots, result.name);
    const failed = (result.assertionResults ?? []).filter((test) => test.status === "failed");
    for (const test of failed) {
      const raw = (test.failureMessages ?? []).join("\n").replace(ANSI, "");
      const frames = stackFrames(raw, roots);
      fails.push({
        file,
        test: [...(test.ancestorTitles ?? []), test.title ?? test.fullName ?? "(unnamed test)"].join(" > "),
        message: messageOf(clean(raw, worktree)),
        line: frames.find((frame) => frame.file === file)?.line ?? 0,
        frames,
      });
    }
    if (failed.length === 0 && result.status === "failed") {
      const raw = (result.message ?? "").replace(ANSI, "");
      const frames = stackFrames(raw, roots);
      fails.push({
        file,
        test: "(file failed to load)",
        message: messageOf(clean(raw, worktree)) || "The test file failed to load.",
        line: frames.find((frame) => frame.file === file)?.line ?? 0,
        frames,
      });
    }
  }
  return fails;
}

/** The error a conflict is about: the first tsc error, else the first failing test, else the crash. */
export function firstError(outcome: CheckOutcome): { loc: string; text: string } | null {
  const tsc = outcome.tscErrors[0];
  if (tsc) {
    return {
      loc: tsc.file ? `${tsc.file}:${tsc.line}` : "",
      text: tsc.file ? `${tsc.file}(${tsc.line},${tsc.col}): error ${tsc.code}: ${tsc.message}` : `error ${tsc.code}: ${tsc.message}`,
    };
  }
  const test = outcome.testFails[0];
  if (test) {
    const at = test.frames[0];
    const loc = at ? `${at.file}:${at.line}` : test.line ? `${test.file}:${test.line}` : test.file;
    return { loc, text: `FAIL ${test.file} > ${test.test}\n${test.message}${at ? `\n  at ${at.file}:${at.line}` : ""}` };
  }
  if (outcome.crash) return { loc: "", text: `The check crashed: ${outcome.crash}` };
  return null;
}

/** One string per failure, without line numbers (lines move when other code changes). */
export function failureSignatures(outcome: CheckOutcome): string[] {
  return [
    ...outcome.tscErrors.map(tscSignature),
    ...outcome.testFails.map(testSignature),
    ...(outcome.crash ? ["crash"] : []),
  ];
}

/** The outcome without the failures that were already there (for example on main by itself). */
export function withoutKnown(outcome: CheckOutcome, known: ReadonlySet<string>): CheckOutcome {
  const tscErrors = outcome.tscErrors.filter((error) => !known.has(tscSignature(error)));
  const testFails = outcome.testFails.filter((fail) => !known.has(testSignature(fail)));
  const crash = known.has("crash") ? "" : outcome.crash;
  return { ...outcome, tscErrors, testFails, crash, ok: tscErrors.length === 0 && testFails.length === 0 && crash === "" };
}

/** Every failure as plain text: what the diagnosis prompt gets as the failing output. */
export function describeFailures(outcome: CheckOutcome, max = 4 * 1024): string {
  const parts = [
    ...outcome.tscErrors.map((error) =>
      error.file ? `${error.file}(${error.line},${error.col}): error ${error.code}: ${error.message}` : `error ${error.code}: ${error.message}`,
    ),
    ...outcome.testFails.map(
      (fail) =>
        `FAIL ${fail.file} > ${fail.test}\n${fail.message}${fail.frames.map((frame) => `\n  at ${frame.file}:${frame.line}`).join("")}`,
    ),
    ...(outcome.crash ? [`The check crashed: ${outcome.crash}`] : []),
  ];
  return cut(parts.join("\n\n"), max);
}

function tscSignature(error: TscError): string {
  return `tsc ${error.file} ${error.code} ${error.message}`;
}

function testSignature(fail: TestFail): string {
  return `test ${fail.file} > ${fail.test}`;
}

function runNode(script: string, args: string[], cwd: string): Promise<ToolRun> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        cwd,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
        timeout: TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr, timedOut: false, spawnError: "" });
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        resolve({
          code: typeof failure.code === "number" ? failure.code : null,
          stdout,
          stderr,
          timedOut: failure.killed === true,
          spawnError: typeof failure.code === "string" ? failure.message : "",
        });
      },
    );
  });
}

/** The worktree's path as given and after symlinks, with forward slashes, each ending in "/", longest first. */
function worktreeRoots(worktree: string): string[] {
  const roots = new Set([path.resolve(worktree)]);
  try {
    roots.add(realpathSync(worktree));
  } catch {
    // The worktree is gone; the given path is all there is.
  }
  return [...roots].map((root) => `${root.replaceAll("\\", "/").replace(/\/$/, "")}/`).sort((a, b) => b.length - a.length);
}

function relativeTo(roots: string[], file: string): string {
  const normalized = file.replaceAll("\\", "/").replace(/^file:\/\//, "");
  for (const root of roots) {
    if (normalized.startsWith(root)) return normalized.slice(root.length);
  }
  return normalized;
}

/** Stack frames that point into the worktree, outside node_modules. */
function stackFrames(text: string, roots: string[]): Loc[] {
  const frames: Loc[] = [];
  for (const match of text.matchAll(/(?:file:\/\/)?((?:[A-Za-z]:)?[^\s()]+?):(\d+):(\d+)/g)) {
    const absolute = match[1]!.replaceAll("\\", "/");
    const root = roots.find((candidate) => absolute.startsWith(candidate));
    const file = root ? absolute.slice(root.length) : "";
    if (!file || file.startsWith("node_modules/") || file.includes("/node_modules/")) continue;
    const frame = { file, line: Number(match[2]) };
    if (!frames.some((seen) => seen.file === frame.file && seen.line === frame.line)) frames.push(frame);
  }
  return frames;
}

/** The message part of an error: everything before the first "at ..." stack line. */
function messageOf(text: string): string {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s+at\s/.test(line)) break;
    lines.push(line.trimEnd());
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(0, MAX_MESSAGE_LINES).join("\n").trim();
}

/** Lines of a crashed vitest run that look like the reason. */
function errorExcerpt(output: string): string {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => /error/i.test(line));
  return (start >= 0 ? lines.slice(start, start + 20) : lines.slice(-20)).join("\n");
}

/** Removes colours and shortens the worktree's paths to "." so logs read the same in every worktree. */
function clean(text: string, worktree: string): string {
  let result = text.replace(ANSI, "").replaceAll("file://", "");
  for (const root of worktreeRoots(worktree)) {
    result = result.replaceAll(root, "./").replaceAll(root.slice(0, -1), ".");
    if (process.platform === "win32") result = result.replaceAll(root.slice(0, -1).replaceAll("/", "\\"), ".");
  }
  return result;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n... (cut at ${Math.round(max / 1024)} KB)`;
}

function repo(): string {
  return repoPath();
}
