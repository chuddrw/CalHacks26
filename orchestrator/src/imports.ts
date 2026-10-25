/**
 * orchestrator/src/imports.ts
 *
 * WHAT IT'S FOR
 *   Finds which files import a given file: in the orchestrator's worktree of main, and in the lines
 *   teammates' in-progress snapshots add. The contract rule (rules.ts) uses it to find the owners whose
 *   features depend on a shared contract, including code that exists only on someone's laptop
 *   (in the demo, b's new src/sessions/idle.ts).
 *
 * OWNER: A (branch feat/orchestrator). Relative imports only (`./x`, `../x`); a regex, not a compiler,
 * which is plenty for "who depends on src/contracts/user.ts".
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** "src/contracts/user.ts" -> "src/contracts/user": imports name files without their extension. */
function stem(file: string): string {
  return file.replace(/\\/g, "/").replace(/\.(?:d\.)?[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
}

function targetsOf(file: string, text: string): string[] {
  const dir = path.posix.dirname(file.replace(/\\/g, "/"));
  return [...text.matchAll(SPECIFIER)].map((match) => stem(path.posix.normalize(path.posix.join(dir, match[1]!))));
}

/** Every importer -> the stems it imports, for the files of a checkout. */
export function scanCheckout(root: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relative);
      else if (SOURCE.test(entry.name)) result.set(relative, targetsOf(relative, readFileSync(path.join(root, relative), "utf8")));
    }
  };
  walk("");
  return result;
}

/** The same for the lines a unified diff adds (a snapshot's diff against main). */
export function scanDiff(diff: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const name = line.slice(4).trim();
      file = name === "/dev/null" ? "" : name.replace(/^b\//, "");
      continue;
    }
    if (!file || !line.startsWith("+") || line.startsWith("+++")) continue;
    const targets = targetsOf(file, line.slice(1));
    if (targets.length) result.set(file, [...(result.get(file) ?? []), ...targets]);
  }
  return result;
}

/** Returns importers(target): every file, on main or in a snapshot, that imports `target`. */
export function importIndex(root: string, diffs: string[]): (target: string) => string[] {
  const maps = [scanCheckout(root), ...diffs.map(scanDiff)];
  return (target: string) => {
    const wanted = stem(target);
    const found = new Set<string>();
    for (const map of maps) for (const [importer, targets] of map) if (targets.includes(wanted) && stem(importer) !== wanted) found.add(importer);
    return [...found].sort();
  };
}
