/**
 * hooks/src/lib/format.ts
 *
 * WHAT IT'S FOR
 *   The exact wording of everything an agent hears from us. Agents act on these words, so they
 *   live in one file where the team can review and tune them. Change the wording here, never inline.
 *
 * OWNER: A (review the wording with C, who writes demo-app/CLAUDE.md, so the two agree).
 * USED BY: snapshot-and-wait.ts (conflictForFixer), inject-context.ts (notes),
 *          stop.ts (stopReason), session-start.ts (teamStatus).
 *
 * RULES FOR THE WORDING
 *   - Start with MESSAGE_PREFIX so the agent knows the message comes from the team tool.
 *   - Say what broke, where, and what to do next, in that order.
 *   - Always repeat the test rule (TEST_RULE): existing tests stay as they are.
 *   - Say what to do, not what to avoid. Naming the forbidden move makes agents more likely to try it.
 *   - Keep each message under about 1,500 characters. Agents read every word of it.
 */
import {
  MESSAGE_PREFIX,
  WATCHER_NAME,
  type AgentRow,
  type ConflictRow,
  type InboxRow,
  type IntentRow,
} from "../../../shared/src/schema.ts";

// Same wording as demo-app/CLAUDE.md. Phrased as what to do, so agents aren't primed with the thing to avoid.
const TEST_RULE = "Keep every existing test as it is; tests are the team's shared contract. If you believe a test is wrong, say so in one line and stop, so a person can decide.";
const MAX_CHARS = 1500;

function indent(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n");
}

function clip(text: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n(cut; call the team_status tool for the rest)` : text;
}

/**
 * The message that wakes the fixer. `theirPlan` is the teammate's latest post_intent summary
 * (fixer-message.ts fetches it), so the fixer knows why the other change was made.
 */
export function conflictForFixer(c: ConflictRow, theirPlan = ""): string {
  const iAmA = c.fixer === c.agentA;
  const other = iAmA ? c.agentB : c.agentA;
  const mine = iAmA ? c.locA : c.locB;
  const theirs = iAmA ? c.locB : c.locA;

  const headline =
    c.kind === "self"
      ? "Your uncommitted change fails on its own (type check or tests)."
      : c.kind === "merge"
        ? `git can't merge your uncommitted change with ${other}'s: you both edited the same lines.`
        : `Your uncommitted change and ${other}'s each pass alone, but fail together.`;

  const todo =
    c.kind === "pair"
      ? `Call the pull_teammate tool with "${other}". It brings ${other}'s in-progress change into your working tree. Keep their changes exactly as pulled (their plan says why they made them), and adapt your own files until npm test passes with both.`
      : c.kind === "merge"
        ? `Rework your edit in ${theirs || mine} so it no longer overlaps ${other}'s, or ask your human to coordinate with ${other}'s human.`
        : "Fix your change until the type check and the tests pass.";

  return clip(
    [
      `${MESSAGE_PREFIX} CONFLICT #${c.id}: you are the fixer.`,
      headline,
      mine ? `  yours:  ${mine}` : "",
      c.kind !== "self" && theirs ? `  theirs: ${theirs} (${other})` : "",
      c.kind === "self"
        ? ""
        : theirPlan
          ? `${other}'s plan: ${theirPlan}`
          : `${other} posted no plan. Read their change (pull_teammate) or call team_status to see why they made it.`,
      "First error:",
      indent(c.error),
      c.explanation ? `Why: ${c.explanation}` : "Why: the diagnosis is still running. It will arrive as a note.",
      "What to do now:",
      `  1. ${todo}`,
      `  2. ${TEST_RULE}`,
      "  3. The check re-runs after your next edit. You'll hear from cowork again only if it's still red.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

const KIND_LABEL: Record<InboxRow["kind"], string> = {
  conflict: "CONFLICT",
  info: "info",
  heads_up: "heads-up",
  fact: "verified fact",
};

/** Quiet notes delivered on the next tool call or prompt. */
export function notes(rows: InboxRow[]): string {
  // Part C's module already starts each message with MESSAGE_PREFIX; the header line carries it once.
  const lines = rows.map((row) => `- [${KIND_LABEL[row.kind]}] ${row.message.replace(/^\[cowork\]\s*/, "")}`);
  return clip([`${MESSAGE_PREFIX} ${rows.length} new note(s) from your team:`, ...lines].join("\n"));
}

/** Why the fixer may not end its turn yet. */
export function stopReason(c: ConflictRow): string {
  return `${MESSAGE_PREFIX} Conflict #${c.id} is still open and you are its fixer. Fix it before you finish, or explain why you can't. ${TEST_RULE}`;
}

/** The team picture for a new session. */
export function teamStatus(agents: AgentRow[], intents: IntentRow[], openForMe: ConflictRow[]): string {
  const facts = intents.filter((i) => i.verified || i.agent === WATCHER_NAME);
  const plans = intents.filter((i) => !i.verified && i.agent !== WATCHER_NAME).slice(-10);
  return clip(
    [
      `${MESSAGE_PREFIX} Team status`,
      ...agents.map((a) => `- ${a.name}: ${a.online ? "online" : "offline"}, ${a.status}${a.intent ? `, working on: ${a.intent}` : ""}`),
      facts.length ? "Verified facts (treat these as true):" : "",
      ...facts.map((f) => `- ${f.summary}`),
      plans.length ? "Recent plans from teammates:" : "",
      ...plans.map((p) => `- ${p.agent}: ${p.summary}`),
      ...openForMe.map((c) => `You are the fixer of open conflict #${c.id}. Fix it first.`),
      "Before you change anything other files import, call the post_intent tool.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
