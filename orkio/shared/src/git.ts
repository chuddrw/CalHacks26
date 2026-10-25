/**
 * shared/src/git.ts
 *
 * WHAT IT'S FOR
 *   One small helper for running git from Node without a shell. The hooks use it for snapshots, the
 *   MCP server for pull_teammate, and the tests for their throwaway repos. Because it passes an
 *   argument array to execFile, paths with spaces or backslashes need no quoting on Windows or Mac.
 *
 * OWNER: A.
 *
 * NOTES
 *   - Output is trimmed by default (handy for shas and file lists). Pass { raw: true } for patches:
 *     `git apply` needs the final newline that trimming would remove.
 *   - On Windows, git prints "LF will be replaced by CRLF" warnings on stderr. They only show up in
 *     the error message when a command actually fails.
 */
import { execFile } from "node:child_process";

export interface GitOptions {
  env?: NodeJS.ProcessEnv;
  /** Written to git's stdin, e.g. a patch for `git apply`. */
  input?: string;
  timeoutMs?: number;
  /** Return stdout exactly as git printed it. */
  raw?: boolean;
}

export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        env: options.env ?? process.env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs ?? 30_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolve(options.raw ? stdout : stdout.trim());
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}
