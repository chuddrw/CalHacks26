/** WHAT IT'S FOR: locate a conflict's source lines in the snapshot's display-only unified diff. */
export interface DiffLine {
  kind: "added" | "removed" | "context";
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** Parse at the final colon so paths containing a colon still work. */
export function parseLocation(
  location: string,
): { path: string; line: number } | null {
  const match = /^(.*):(\d+)$/.exec(location);
  if (!match || !match[1] || Number(match[2]) < 1) return null;
  return { path: match[1].replaceAll("\\", "/"), line: Number(match[2]) };
}

/** No source fetches: snapshots may be truncated, so an unavailable excerpt returns []. */
export function excerptFromDiff(
  diff: string,
  location: string,
  radius = 2,
): DiffLine[] {
  const target = parseLocation(location);
  if (!target) return [];
  let file = "";
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const result: DiffLine[] = [];
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      file = "";
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith("--- ")) {
      // Keep the old path for deleted files (whose +++ path is /dev/null).
      file = raw.slice(4).split("\t")[0].replace(/^a\//, "");
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      const next = raw.slice(4).split("\t")[0].replace(/^b\//, "");
      if (next !== "/dev/null") file = next;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const marker = raw[0];
    if (marker !== "+" && marker !== "-" && marker !== " ") {
      if (!raw.startsWith("\\ No newline")) inHunk = false;
      continue;
    }
    const line: DiffLine = {
      kind: marker === "+" ? "added" : marker === "-" ? "removed" : "context",
      text: raw.slice(1),
      ...(marker !== "+" ? { oldLine } : {}),
      ...(marker !== "-" ? { newLine } : {}),
    };
    if (
      file === target.path &&
      Math.abs((line.newLine ?? newLine) - target.line) <= radius
    ) {
      result.push(line);
    }
    if (marker !== "+") oldLine++;
    if (marker !== "-") newLine++;
  }
  return result;
}
