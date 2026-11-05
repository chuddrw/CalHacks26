/**
 * WHAT IT'S FOR: the kickoff flow for a team that only has a goal. The module's `kickoff` rows hold
 * the goal, the orchestrator's questions, and its proposal (who owns what, shared contracts, first
 * tasks) plus the text of a cowork.owners.json for a human to commit. The table may not exist on an
 * older database, so every reader tolerates an empty list. Pure TypeScript, no React.
 */
import type { KickoffRow, KickoffStatus } from "../../shared/src/schema.ts";
export type { KickoffRow, KickoffStatus };
export const KICKOFF_STATUSES: readonly KickoffStatus[] = ["new", "planning", "needs_answers", "proposed", "approved", "rejected", "failed"];

export interface KickoffMember {
  handle: string;
  displayName: string;
  strengths?: string;
}
export interface ProposalOwner {
  agent: string;
  human: string;
  feature: string;
  paths: string[];
}
export interface ProposalTask {
  agent: string;
  title: string;
  details: string;
  files: string[];
}
export interface Proposal {
  owners: ProposalOwner[];
  contracts: string[];
  tasks: ProposalTask[];
  notes: string;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

function parse(value: string): unknown {
  try {
    return value.trim() ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseQuestions(row: Pick<KickoffRow, "questions">): string[] {
  return strings(parse(row.questions));
}

export function parseMembers(row: Pick<KickoffRow, "members">): KickoffMember[] {
  const raw = parse(row.members);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({ handle: text(m.handle), displayName: text(m.displayName), ...(text(m.strengths) ? { strengths: text(m.strengths) } : {}) }))
    .filter((m) => m.handle);
}

/** The proposal, or null while there isn't a readable one. Missing parts become empty lists. */
export function parseProposal(row: Pick<KickoffRow, "proposal">): Proposal | null {
  const raw = parse(row.proposal);
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const owners = (Array.isArray(p.owners) ? p.owners : [])
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => ({ agent: text(o.agent), human: text(o.human), feature: text(o.feature), paths: strings(o.paths) }));
  const tasks = (Array.isArray(p.tasks) ? p.tasks : (Array.isArray(p.firstTasks) ? p.firstTasks : []))
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => ({ agent: text(o.agent), title: text(o.title), details: text(o.details), files: strings(o.files) }));
  const contracts = (Array.isArray(p.contracts) ? p.contracts : (Array.isArray(p.shared) ? p.shared : []))
    .map((c) => (typeof c === "string" ? c : text((c as Record<string, unknown> | null)?.path ?? (c as Record<string, unknown> | null)?.name)))
    .filter(Boolean);
  const notes = text(p.notes) || text(p.architecture);
  return { owners, contracts, tasks, notes };
}

/** What the form sends for submit_kickoff's `members` argument. */
export function membersJson(members: KickoffMember[]): string {
  return JSON.stringify(members.filter((m) => m.handle.trim()).map((m) => ({
    handle: m.handle.trim(),
    displayName: m.displayName.trim(),
    ...(m.strengths?.trim() ? { strengths: m.strengths.trim() } : {}),
  })));
}

/** What the form sends for answer_kickoff's `answers` argument: one string per question, in order. */
export function answersJson(questions: string[], answers: string[]): string {
  return JSON.stringify(questions.map((q, i) => ({ question: q, answer: (answers[i] ?? "").trim() })));
}

/** A readable problem with a kickoff draft, or "" when it can be sent. */
export function kickoffProblem(goal: string, members: KickoffMember[]): string {
  if (!goal.trim()) return "Describe the goal.";
  if (goal.length > 4000) return `Goal is too long: ${goal.length} of 4000 characters.`;
  if (members.filter((m) => m.handle.trim()).length === 0) return "Add at least one team member.";
  return "";
}

/** A problem with the answers, or "" when every question has one. */
export function answersProblem(questions: string[], answers: string[]): string {
  const missing = questions.findIndex((_, i) => !(answers[i] ?? "").trim());
  return missing >= 0 ? `Answer question ${missing + 1}.` : "";
}

export const statusLabel: Record<KickoffStatus, string> = {
  new: "Waiting for the orchestrator",
  planning: "The orchestrator is working on a proposal",
  needs_answers: "The orchestrator has questions",
  proposed: "Proposal ready for review",
  approved: "Approved",
  rejected: "Sent back",
  failed: "Failed",
};

/** The newest kickoff, if any. */
export const latestKickoff = (rows: KickoffRow[]): KickoffRow | undefined =>
  [...rows].sort((a, b) => b.id - a.id)[0];

/** One sample per status for ?demo. */
export function sampleKickoffs(now: number): KickoffRow[] {
  const members = JSON.stringify([
    { handle: "ana", displayName: "Ana", strengths: "frontend" },
    { handle: "ben", displayName: "Ben", strengths: "backend" },
  ]);
  const proposal = JSON.stringify({
    owners: [
      { agent: "ana", human: "Ana", feature: "Web app", paths: ["src/web/"] },
      { agent: "ben", human: "Ben", feature: "API and data", paths: ["src/api/"] },
    ],
    contracts: ["src/contracts/"],
    tasks: [
      { agent: "ana", title: "Scaffold the web app", details: "Vite + React shell that calls the API contract.", files: ["src/web/"] },
      { agent: "ben", title: "Define the API contract", details: "Types for the three endpoints.", files: ["src/contracts/api.ts"] },
    ],
    notes: "Ana builds the UI against src/contracts; Ben owns the contract and the server.",
  });
  const ownersJson = JSON.stringify(
    {
      about: "Proposed by the Orkio kickoff.",
      shared: ["src/contracts/"],
      owners: [
        { agent: "ana", human: "Ana", feature: "Web app", paths: ["src/web/"] },
        { agent: "ben", human: "Ben", feature: "API and data", paths: ["src/api/"] },
      ],
    },
    null,
    2,
  );
  const base = { requester: "ana", goal: "A study-group matcher for the demo", constraints: "TypeScript, 24 hours, demo on stage", members, answers: "", questions: "[]", proposal: "", ownersJson: "", note: "" };
  const row = (id: number, status: KickoffStatus, extra: Partial<KickoffRow> = {}): KickoffRow => ({
    ...base, id, status, createdAt: now - id * 120_000, updatedAt: now - id * 60_000, ...extra,
  });
  return [
    row(7, "failed", { note: "The planner timed out." }),
    row(6, "rejected", { proposal, ownersJson, note: "Ben owns too much; split the API." }),
    row(5, "approved", { proposal, ownersJson }),
    row(4, "proposed", { proposal, ownersJson }),
    row(3, "needs_answers", { questions: JSON.stringify(["Is there an existing backend, or do we build one?", "Which data must be in the demo?"]) }),
    row(2, "planning"),
    row(1, "new"),
  ];
}
