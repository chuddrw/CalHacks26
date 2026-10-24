/**
 * watcher/src/fixer.ts
 *
 * WHAT IT'S FOR
 *   Decides which agent has to fix a conflict. It's the "Who fixes" rule from plan.md, kept as one
 *   small pure function so it's easy to test and easy to explain to judges.
 *
 * OWNER: B. WHEN: Sat 14:00-19:00.
 * DONE WHEN: the demo scenario picks b (the error is in b's new file), even though a pushed last.
 *            (Fixture: picks b.)
 *
 * THE RULE
 *   1. kind "self":  the snapshot's author.
 *   2. kind "merge": whoever pushed last.
 *   3. kind "pair":  the agent whose changed lines contain the first error location
 *                    (map-errors.ts). If that's neither or both of them: whoever pushed last.
 */
import type { AgentName, ConflictKind } from "../../shared/src/schema.ts";

export interface FixerInput {
  kind: ConflictKind;
  /** One agent for "self", two for "merge" and "pair". */
  agents: AgentName[];
  /** From map-errors.ts: the agent whose change contains the error, "both", or "" for neither. */
  errorOwner: AgentName | "both" | "";
  /** The agent whose snapshot is newest among `agents`. */
  lastPusher: AgentName;
}

export function pickFixer(input: FixerInput): AgentName {
  if (input.kind === "self") return input.agents[0] ?? input.lastPusher;
  if (input.kind === "merge") return input.lastPusher;
  if (input.errorOwner !== "" && input.errorOwner !== "both" && input.agents.includes(input.errorOwner)) {
    return input.errorOwner;
  }
  return input.lastPusher;
}
