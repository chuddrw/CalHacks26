/**
 * checks/src/map-errors.ts
 *
 * WHAT IT'S FOR
 *   Turns "the check failed at src/sessions/idle.ts:7" into "that line belongs to b's change, and
 *   the other side of the clash is src/users/user.ts:14 in a's change". This gives the conflict its
 *   two locations (locA, locB) and tells fixer.ts whose code the error sits in.
 *
 * OWNER: B. WHEN: Sat 14:00-19:00.
 * DONE WHEN: on the demo scenario, locB points into src/sessions/idle.ts, locA points at the line
 *            in src/users/user.ts where A changed the unit, and the error owner is b.
 *            (Fixture result: locA src/users/user.ts:14, locB src/sessions/idle.ts:7, owner b.)
 *
 * WHAT IT EXPORTS
 *   mapFailure({ kind, agents, outcome, mergeFiles, changed, readFile }):
 *     Promise<{ locA, locB, errorOwner: AgentName | "" | "both" }>
 *     agents      [agentA] or [agentA, agentB]; locA and locB follow this order
 *     changed     git.changedLines(mainSha, snapshotSha) for each agent
 *     readFile    a file as it is in that agent's snapshot (git.readFileAt), to follow imports
 *
 * RULES
 *   - Error location = the first tsc error, or else the first failing test's first stack frame in
 *     the repo. If that location isn't in anyone's change, the next frames and failures are tried.
 *   - errorOwner = the agent whose changed lines contain that location. If only one agent changed
 *     the file, it's that agent even when the exact line is off. Both, or neither: "both" or "".
 *   - The owner's side: the error location, except when it's in a test file. Then it's the owner's
 *     source file that the test covers (x.test.ts -> x.ts, or a file the test imports), at the
 *     changed line sharing the most names with the other agent's changes (lastLogin, getTime...).
 *   - The other side: the other agent's changed files that the error's file or the owner's file
 *     imports (relative imports, read with readFile; deps.ts isn't needed for this). If there are
 *     none, its other source files; if none of those either, its test files. In that group, the
 *     changed line sharing the most names with the owner's line wins; with no shared names, the
 *     file with the most changed lines, at its first changed line of code.
 *   - "self": locA is the error location, locB is "". "merge": both locations point into the first
 *     file git couldn't merge, at each agent's first change there; errorOwner is "both".
 *   - Line numbers in the merged tree can drift when both agents edited the same file. The file
 *     match decides; the line is a hint.
 */
import type { AgentName, ConflictKind, Loc as LocText } from "../../shared/src/schema.ts";
import type { CheckOutcome, Loc } from "./check.ts";
import { hunkContains, type ChangedLines } from "./git.ts";

export interface MapInput {
  kind: ConflictKind;
  agents: AgentName[];
  /** The red outcome, new failures only. null for "merge". */
  outcome: CheckOutcome | null;
  /** Files git couldn't merge ("merge" only). */
  mergeFiles: string[];
  changed: Map<AgentName, ChangedLines>;
  readFile?: (agent: AgentName, file: string) => Promise<string | null>;
}

export interface MappedFailure {
  locA: LocText;
  locB: LocText;
  errorOwner: AgentName | "both" | "";
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const STOP_WORDS = new Set([
  "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch", "class", "const",
  "continue", "default", "delete", "describe", "do", "else", "enum", "expect", "export", "extends",
  "false", "finally", "for", "from", "function", "get", "if", "implements", "import", "in",
  "instanceof", "interface", "is", "it", "keyof", "let", "never", "new", "null", "number", "object",
  "of", "private", "protected", "public", "readonly", "return", "set", "static", "string", "super",
  "switch", "test", "this", "throw", "toBe", "toEqual", "true", "try", "type", "typeof", "undefined",
  "unknown", "var", "void", "while", "with", "yield", "Array", "Date", "JSON", "Math", "Number",
  "Object", "Promise", "String", "console", "vitest",
]);

export async function mapFailure(input: MapInput): Promise<MappedFailure> {
  const [a, b] = input.agents;
  if (!a) return { locA: "", locB: "", errorOwner: "" };
  const changesOf = (agent: AgentName): ChangedLines => input.changed.get(agent) ?? new Map();
  const read = async (agent: AgentName, file: string) => (input.readFile ? input.readFile(agent, file) : null);

  if (input.kind === "merge") {
    const file = input.mergeFiles[0] ?? "";
    return {
      locA: format(firstChangeIn(changesOf(a), file) ?? (file ? { file, line: 0 } : null)),
      locB: b ? format(firstChangeIn(changesOf(b), file) ?? (file ? { file, line: 0 } : null)) : "",
      errorOwner: "both",
    };
  }

  const locations = errorLocations(input.outcome);
  if (input.kind === "self" || !b) {
    return { locA: format(locations[0] ?? firstCodeChange(changesOf(a))), locB: "", errorOwner: a };
  }

  const { owner, at } = findOwner(locations, [a, b], changesOf);
  if (owner === a || owner === b) {
    const other = owner === a ? b : a;
    const ownerChanges = changesOf(owner);
    const otherChanges = changesOf(other);
    let ownerLoc: Loc | null = at;
    if (at && TEST_FILE.test(at.file)) {
      const tested = await testedSource(at.file, owner, ownerChanges, tokensOfChanges(otherChanges), read);
      if (tested) ownerLoc = tested;
    }
    const anchors = unique([at?.file, ownerLoc?.file].filter((file): file is string => Boolean(file)));
    const otherLoc = await otherSide(other, otherChanges, anchors, owner, lineTokens(ownerChanges, ownerLoc), read);
    const ownerText = format(ownerLoc ?? firstCodeChange(ownerChanges));
    const otherText = format(otherLoc);
    return owner === a
      ? { locA: ownerText, locB: otherText, errorOwner: owner }
      : { locA: otherText, locB: ownerText, errorOwner: owner };
  }

  // Both or neither: each side is that agent's change nearest the error.
  const anchors = at ? [at.file] : [];
  const sideOf = async (agent: AgentName): Promise<Loc | null> => {
    const changes = changesOf(agent);
    if (at && changes.has(at.file)) return nearestChange(changes, at);
    return otherSide(agent, changes, anchors, agent, new Set(), read);
  };
  return { locA: format(await sideOf(a)), locB: format(await sideOf(b)), errorOwner: owner };
}

/** Where the failures point: the first tsc error, then each failing test's frames, in order. */
function errorLocations(outcome: CheckOutcome | null): Loc[] {
  if (!outcome) return [];
  const locations: Loc[] = [];
  for (const error of outcome.tscErrors) if (error.file) locations.push({ file: error.file, line: error.line });
  for (const fail of outcome.testFails) {
    if (fail.frames.length > 0) locations.push(...fail.frames);
    else locations.push({ file: fail.file, line: fail.line });
  }
  return locations;
}

function findOwner(
  locations: Loc[],
  agents: AgentName[],
  changesOf: (agent: AgentName) => ChangedLines,
): { owner: AgentName | "both" | ""; at: Loc | null } {
  for (const at of locations) {
    const byLine = agents.filter((agent) => (changesOf(agent).get(at.file) ?? []).some((hunk) => hunkContains(hunk, at.line)));
    if (byLine.length === 1) return { owner: byLine[0]!, at };
    if (byLine.length > 1) return { owner: "both", at };
    const byFile = agents.filter((agent) => changesOf(agent).has(at.file));
    if (byFile.length === 1) return { owner: byFile[0]!, at };
    if (byFile.length > 1) return { owner: "both", at };
  }
  return { owner: "", at: locations[0] ?? null };
}

/** The owner's source file that a failing test covers, at the line most related to the other side. */
async function testedSource(
  testFile: string,
  owner: AgentName,
  ownerChanges: ChangedLines,
  otherTokens: Set<string>,
  read: (agent: AgentName, file: string) => Promise<string | null>,
): Promise<Loc | null> {
  const sameName = testFile.replace(/\.(test|spec)(\.[cm]?[jt]sx?)$/, "$2");
  const imported = await importedFiles(testFile, owner, read);
  const candidates = unique([sameName, ...imported]).filter((file) => ownerChanges.has(file) && !TEST_FILE.test(file));
  if (candidates.length === 0) return null;
  return bestLine(candidates, ownerChanges, otherTokens) ?? firstCodeChangeIn(ownerChanges, candidates[0]!);
}

/** The other agent's change most related to the error: imported files first, then shared names. */
async function otherSide(
  agent: AgentName,
  changes: ChangedLines,
  anchors: string[],
  anchorReader: AgentName,
  tokens: Set<string>,
  read: (agent: AgentName, file: string) => Promise<string | null>,
): Promise<Loc | null> {
  const files = [...changes.keys()];
  if (files.length === 0) return null;
  const imported = new Set<string>();
  for (const anchor of anchors) {
    for (const file of await importedFiles(anchor, anchorReader, read)) if (changes.has(file)) imported.add(file);
    if (anchorReader !== agent) for (const file of await importedFiles(anchor, agent, read)) if (changes.has(file)) imported.add(file);
  }
  const group = [
    files.filter((file) => imported.has(file) && !TEST_FILE.test(file)),
    files.filter((file) => !imported.has(file) && !TEST_FILE.test(file)),
    files.filter((file) => TEST_FILE.test(file)),
  ].find((candidates) => candidates.length > 0);
  if (!group) return firstCodeChange(changes);
  const busiest = [...group].sort((x, y) => changedCount(changes, y) - changedCount(changes, x))[0]!;
  return bestLine(group, changes, tokens) ?? firstCodeChangeIn(changes, busiest);
}

/** The changed line in `files` that shares the most names with `tokens`, or null if none shares any. */
function bestLine(files: string[], changes: ChangedLines, tokens: Set<string>): Loc | null {
  let best: Loc | null = null;
  let bestScore = 0;
  for (const file of files) {
    for (const hunk of changes.get(file) ?? []) {
      for (let index = 0; index < hunk.added.length; index++) {
        const score = new Set(tokenize(hunk.added[index]!).filter((token) => tokens.has(token))).size;
        if (score > bestScore) {
          best = { file, line: hunk.start + index };
          bestScore = score;
        }
      }
    }
  }
  return best;
}

/** Repo-relative files that `file` imports with a relative path, read from that agent's snapshot. */
async function importedFiles(
  file: string,
  agent: AgentName,
  read: (agent: AgentName, file: string) => Promise<string | null>,
): Promise<string[]> {
  const source = await read(agent, file);
  if (!source) return [];
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const files: string[] = [];
  for (const match of source.matchAll(IMPORT)) {
    const spec = match[1]!;
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    const base = normalize(dir ? `${dir}/${spec}` : spec);
    const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
    files.push(base, ...SOURCE_EXTENSIONS.map((ext) => `${stem}${ext}`), ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`));
  }
  return unique(files);
}

function normalize(file: string): string {
  const parts: string[] = [];
  for (const part of file.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function tokensOfChanges(changes: ChangedLines): Set<string> {
  const tokens = new Set<string>();
  for (const hunks of changes.values()) for (const hunk of hunks) for (const text of hunk.added) for (const token of tokenize(text)) tokens.add(token);
  return tokens;
}

/** Names on the chosen line, or on all the agent's changes when the line isn't one of them. */
function lineTokens(changes: ChangedLines, loc: Loc | null): Set<string> {
  if (loc) {
    for (const hunk of changes.get(loc.file) ?? []) {
      const text = hunk.added[loc.line - hunk.start];
      if (text !== undefined && loc.line >= hunk.start) return new Set(tokenize(text));
    }
  }
  return tokensOfChanges(changes);
}

/** Identifiers on a line of code, without keywords, short names, strings and comments. */
function tokenize(text: string): string[] {
  if (isComment(text)) return [];
  const code = text.replace(/\/\/.*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
  return (code.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function isComment(text: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(text);
}

function firstChangeIn(changes: ChangedLines, file: string): Loc | null {
  const hunk = (changes.get(file) ?? [])[0];
  return hunk ? { file, line: Math.max(hunk.start, 1) } : null;
}

function firstCodeChangeIn(changes: ChangedLines, file: string): Loc | null {
  for (const hunk of changes.get(file) ?? []) {
    const index = hunk.added.findIndex((text) => text.trim() !== "" && !isComment(text));
    if (index >= 0) return { file, line: hunk.start + index };
  }
  return firstChangeIn(changes, file);
}

function firstCodeChange(changes: ChangedLines): Loc | null {
  for (const file of changes.keys()) if (!TEST_FILE.test(file)) return firstCodeChangeIn(changes, file);
  const [file] = changes.keys();
  return file === undefined ? null : firstCodeChangeIn(changes, file);
}

function nearestChange(changes: ChangedLines, at: Loc): Loc {
  let best: Loc = { file: at.file, line: at.line };
  let distance = Number.POSITIVE_INFINITY;
  for (const hunk of changes.get(at.file) ?? []) {
    const line = Math.max(hunk.start, 1);
    const gap = hunkContains(hunk, at.line) ? 0 : Math.abs(line - at.line);
    if (gap < distance) {
      distance = gap;
      best = { file: at.file, line: gap === 0 ? at.line : line };
    }
  }
  return best;
}

function changedCount(changes: ChangedLines, file: string): number {
  return (changes.get(file) ?? []).reduce((sum, hunk) => sum + Math.max(hunk.count, 1), 0);
}

function format(loc: Loc | null): LocText {
  if (!loc || !loc.file) return "";
  return loc.line > 0 ? `${loc.file}:${loc.line}` : loc.file;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
