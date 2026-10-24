/** Part C's deliberately small command grammar: one read/check command, no shell syntax or mutations. */
export const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);

export function isReadOnlyCommand(command: string): boolean {
  // No quotes, substitutions, pipelines, redirects, control characters, expansions or shell programs.
  if (!command || !/^[A-Za-z0-9_./:@=+\- ]+$/.test(command)) return false;
  const words = command.trim().split(/ +/);
  const executable = words.shift();
  const safePaths = (items: string[]) => items.every(item => !item.startsWith("-") && !item.startsWith("/") && !item.split("/").includes(".."));
  if (executable === "./node_modules/.bin/tsc") {
    return words.join(" ") === "--noEmit --incremental false";
  }
  if (executable === "./node_modules/.bin/vitest") {
    return words.shift() === "run" && safePaths(words);
  }
  if (executable === "git") {
    const subcommand = words.shift();
    if (!subcommand || !["diff", "show", "log"].includes(subcommand)) return false;
    // Suppress repository-configured external diff/text conversion programs.
    if (words.shift() !== "--no-ext-diff" || words.shift() !== "--no-textconv") return false;
    return words.every(word => ["--stat", "--name-only", "--oneline", "--"].includes(word) || (!word.startsWith("-") && !word.startsWith("/")));
  }
  if (executable === "cat") return words.length > 0 && safePaths(words);
  if (executable === "ls") return words.every(word => ["-a", "-l", "-la"].includes(word) || safePaths([word]));
  if (executable === "rg" || executable === "grep") {
    return words.length > 0 && words.every(word => ["-n", "-r", "-R", "-i", "--files"].includes(word) || safePaths([word]));
  }
  return false;
}
