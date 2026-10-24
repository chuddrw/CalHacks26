/**
 * hooks/src/lib/listener-lock.ts
 *
 * WHAT IT'S FOR
 *   Makes sure only the NEWEST listener per agent stays alive. Every edit starts a new
 *   snapshot-and-wait.ts process. Without this lock, an agent that made 40 edits would have
 *   40 background processes polling the database.
 *
 * OWNER: A. USED BY: snapshot-and-wait.ts (claim, check, release) and inject-context.ts
 *   (listenerAlive, to decide whether it must deliver conflict messages itself).
 *
 * HOW IT WORKS
 *   <gitDir>/cowork-listener.pid holds the PID of the current listener.
 *   claimListener():     write our PID over the old one. The old listener sees it on its next poll and exits.
 *   isCurrentListener(): true while the file still holds our PID.
 *   releaseListener():   delete the file, but only if it still holds our PID, so we never delete a newer claim.
 *   listenerAlive():     true if the file names a process that is still running.
 *   Call releaseListener() on every exit path, including the wake (exit 2), so nothing is left behind.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

function lockFile(gitDir: string): string {
  return path.join(gitDir, "cowork-listener.pid");
}

function readPid(gitDir: string): number | null {
  try {
    const pid = Number(readFileSync(lockFile(gitDir), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function claimListener(gitDir: string): void {
  writeFileSync(lockFile(gitDir), String(process.pid));
}

export function isCurrentListener(gitDir: string): boolean {
  return readPid(gitDir) === process.pid;
}

export function releaseListener(gitDir: string): void {
  if (isCurrentListener(gitDir)) rmSync(lockFile(gitDir), { force: true });
}

export function listenerAlive(gitDir: string): boolean {
  const pid = readPid(gitDir);
  if (pid === null) return false;
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch {
    return false;
  }
}
