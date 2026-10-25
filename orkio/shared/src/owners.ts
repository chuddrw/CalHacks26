/**
 * shared/src/owners.ts
 *
 * WHAT IT'S FOR
 *   Reads cowork.owners.json from a clone of the team's app (repo 2, like a CODEOWNERS file): which
 *   agent owns which feature, the human each agent works for, and which paths are shared
 *   contracts. The orchestrator assigns work by it and applies the contract rule with it (a change
 *   to a shared path, or to another owner's path, is major and needs the affected humans' review).
 *
 * OWNER: A (branch feat/orchestrator). USED BY: orchestrator/, mcp/ (team_status).
 *
 * FILE SHAPE (repo 2, cowork.owners.json)
 *   { "about": "...", "shared": ["src/contracts/"],
 *     "owners": [{ "agent": "a", "human": "A", "feature": "Users and logins", "paths": ["src/users/"] }, ...] }
 *   A path ending in "/" is a folder; otherwise it names one file. Paths are relative to the repo
 *   root, with forward slashes. The longest matching path wins.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentName } from "./schema.ts";

export const OWNERS_FILE = "cowork.owners.json";

export interface Owner {
  agent: AgentName;
  /** The human this agent works for, as the dashboard shows them. */
  human: string;
  feature: string;
  paths: string[];
}

export interface Owners {
  /** Shared contracts: every owner's code may depend on them. */
  shared: string[];
  owners: Owner[];
}

/** Reads and checks <repoDir>/cowork.owners.json. Throws a readable error when it's missing or wrong. */
export function readOwners(repoDir: string): Owners {
  const file = path.join(repoDir, OWNERS_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`${OWNERS_FILE} is missing on main. Add it to the repo so the orchestrator knows who owns what.`);
  }
  return parseOwners(text);
}

export function parseOwners(text: string): Owners {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${OWNERS_FILE} isn't valid JSON.`);
  }
  const record = value as { shared?: unknown; owners?: unknown };
  const strings = (items: unknown, label: string): string[] => {
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) throw new Error(`${OWNERS_FILE}: ${label} must be a list of paths.`);
    return (items as string[]).map(normalize);
  };
  if (!Array.isArray(record.owners) || record.owners.length === 0) throw new Error(`${OWNERS_FILE}: "owners" must list at least one owner.`);
  const owners = record.owners.map((item, index): Owner => {
    const owner = item as Partial<Owner>;
    if (typeof owner.agent !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(owner.agent)) {
      throw new Error(`${OWNERS_FILE}: owners[${index}].agent must be an agent name (COWORK_NAME).`);
    }
    return {
      agent: owner.agent,
      human: typeof owner.human === "string" && owner.human ? owner.human : owner.agent.toUpperCase(),
      feature: typeof owner.feature === "string" ? owner.feature : "",
      paths: strings(owner.paths ?? [], `owners[${index}].paths`),
    };
  });
  return { shared: strings(record.shared ?? [], "shared"), owners };
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matches(prefix: string, file: string): boolean {
  return prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix;
}

/** The owner of `file` (longest matching path), or undefined when nobody owns it. */
export function ownerOf(owners: Owners, file: string): Owner | undefined {
  const target = normalize(file);
  let best: { owner: Owner; length: number } | undefined;
  for (const owner of owners.owners) {
    for (const prefix of owner.paths) {
      if (matches(prefix, target) && (!best || prefix.length > best.length)) best = { owner, length: prefix.length };
    }
  }
  return best?.owner;
}

export function isShared(owners: Owners, file: string): boolean {
  const target = normalize(file);
  return owners.shared.some((prefix) => matches(prefix, target));
}

/** The human behind an agent, for messages ("B's human"). Falls back to the agent's name. */
export function humanOf(owners: Owners | null, agent: AgentName): string {
  return owners?.owners.find((owner) => owner.agent === agent)?.human ?? agent;
}
