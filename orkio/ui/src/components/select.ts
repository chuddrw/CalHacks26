/** WHAT IT'S FOR: compare two drawer selections, so the graph and lists can highlight what's open. */
import type { Selection } from "../team";

export function sameSelection(a: Selection | null, b: Selection): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "agent" && b.kind === "agent") return a.name === b.name;
  if (
    (a.kind === "request" && b.kind === "request") ||
    (a.kind === "conflict" && b.kind === "conflict")
  )
    return a.id === b.id;
  return true;
}
