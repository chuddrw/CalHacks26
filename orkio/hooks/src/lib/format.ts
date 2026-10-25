/**
 * hooks/src/lib/format.ts
 *
 * WHAT IT'S FOR
 *   The exact wording of everything an agent hears from us. Agents act on these words, so they
 *   live in one file where the team can review and tune them. Change the wording here, never inline.
 *
 * OWNER: A (review the wording against demo-app/CLAUDE.md, so the two agree).
 * USED BY: lib/wake-message.ts (tasks, conflict threads, teammates' messages, decisions),
 *          inject-context.ts (notes), stop.ts (stop reasons), session-start.ts and the MCP server
 *          (teamStatus).
 *
 * RULES FOR THE WORDING
 *   - Start with MESSAGE_PREFIX so the agent knows the message comes from the team tool.
 *   - Say what happened, where, and what to do next, in that order.
 *   - Always repeat the test rule (TEST_RULE): existing tests stay as they are.
 *   - Say what to do, not what to avoid. Naming the forbidden move makes agents more likely to try it.
 *   - Keep each message under about 1,500 characters. Agents read every word of it.
 *
 * WHO DOES WHAT (branch feat/orchestrator)
 *   The orchestrator assigns tasks. Two agents whose work clashes talk to each other directly in a
 *   conflict thread and agree who changes what; if they can't, both humans decide on the dashboard.
 *   Nobody is "the fixer": the conflict row's fixer is only a suggestion.
 */
import {
  MESSAGE_PREFIX,
  ORCHESTRATOR_NAME,
  type AgentRow,
  type ConflictRow,
  type InboxRow,
  type IntentRow,
  type MessageRow,
  type RequestRow,
  type TaskRow,
} from "../../../shared/src/schema.ts";

// Same wording as demo-app/CLAUDE.md. Phrased as what to do, so agents aren't primed with the thing to avoid.
export const TEST_RULE = "Keep every existing test as it is; tests are the team's shared contract. If you believe a test is wrong, say so in one line and stop, so a person can decide.";
const MAX_CHARS = 1500;

function indent(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n");
}

function clip(text: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n(cut; call the team_status tool for the rest)` : text;
}

/**
 * What the database said beyond the conflict's own facts, e.g. "Still red after your last change." or
 * "A person sent your fix ... back (reason)". Empty for a plain new conflict.
 */
export function wakeReason(inboxMessage: string): string {
  return inboxMessage
    .replace(/^\[cowork\]\s*/, "")
    .replace(/\s*Conflict #\d+: you are the fixer\.?$/, "")
    .replace(/^Conflict #\d+ with [a-z0-9_-]+: .*$/, "")
    .trim();
}

/** The other agent of a conflict, seen from `me`. */
export function otherAgent(c: ConflictRow, me: string): string {
  return c.agentA === me ? c.agentB : c.agentA;
}

/** The message that wakes an agent with a new task from the orchestrator. */
export function taskMessage(task: TaskRow, request: RequestRow | undefined): string {
  return clip(
    [
      `${MESSAGE_PREFIX} TASK #${task.id} from the orchestrator: ${task.title}`,
      request ? `Asked by ${request.agent}'s human (request #${request.id}): "${request.body.split("\n")[0]}"` : "",
      task.details,
      task.files.length ? `Files: ${task.files.join(", ")}` : "",
      task.major ? "This is a major change. The humans whose features it affects approved it on the dashboard." : "",
      "What to do:",
      "  1. Work in your own files. Call post_intent before you change anything other files import.",
      "  2. When you're done, call check_with_team. It runs the type check and the tests on your work together with every teammate's work in progress.",
      `  3. When it's green, call complete_task(${task.id}, "<one line on what you did>").`,
      "  If a teammate's work gets in the way, a [cowork] conflict thread is where you two settle it.",
      `  ${TEST_RULE}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/**
 * The message that wakes an agent when a conflict thread with it opens: flagged by the orchestrator
 * (kind "potential") or found by a check (pair, merge, self). `theirPlan` is the other agent's latest
 * intent; `thread` the messages so far; `reason` wakeReason() of the inbox note.
 */
export function conflictOpened(c: ConflictRow, me: string, theirPlan = "", thread: MessageRow[] = [], reason = ""): string {
  const other = otherAgent(c, me);
  const mine = c.agentA === me ? c.locA : c.locB;
  const theirs = c.agentA === me ? c.locB : c.locA;
  const suggested = c.fixer === me ? "you adapt" : `${c.fixer} adapts`;
  if (c.kind === "self" || !other) {
    return clip(
      [
        `${MESSAGE_PREFIX} CONFLICT #${c.id}: your uncommitted change fails on its own (type check or tests).`,
        reason,
        mine ? `  yours: ${mine}` : "",
        "First error:",
        indent(c.error),
        "What to do now: fix your change, then call check_with_team.",
        `  ${TEST_RULE}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const headline =
    c.kind === "potential"
      ? `The orchestrator expects your work and ${other}'s to clash: ${c.error.split("\n")[0]}`
      : c.kind === "merge"
        ? `git can't merge your uncommitted change with ${other}'s: you both edited the same lines.`
        : `Your uncommitted change and ${other}'s each pass alone, but fail together.`;
  const said = thread.filter((m) => m.author !== me).slice(-3);
  return clip(
    [
      `${MESSAGE_PREFIX} CONFLICT #${c.id} with ${other}. ${headline}`,
      reason,
      c.kind === "potential" ? c.error.split("\n").slice(1).join(" ").trim() : "",
      mine ? `  yours:  ${mine}` : "",
      theirs ? `  theirs: ${theirs} (${other})` : "",
      c.kind === "potential" ? "" : `First error:\n${indent(c.error)}`,
      theirPlan ? `${other}'s plan: ${theirPlan}` : `${other} posted no plan yet. Ask them, or read their change with pull_teammate("${other}").`,
      ...said.map((m) => `${m.author === ORCHESTRATOR_NAME ? "Orchestrator" : m.author}: ${m.body}`),
      `Suggested: ${suggested}. You and ${other} decide who changes what.`,
      "What to do now:",
      `  1. Talk to ${other} directly: message_teammate(${c.id}, ...). Say what you're changing and what you need from them. Each message wakes them.`,
      `  2. Change only your own files. To test with ${other}'s in-progress work, call pull_teammate("${other}") and keep their changes as pulled.`,
      `  3. When your side is done, call check_with_team, then agree(${c.id}, "<the fact you both now treat as true>"). It resolves when you both agree and the check is green.`,
      `  4. If you can't agree, call escalate(${c.id}, "<why>"). Both humans then decide on the dashboard.`,
      `  ${TEST_RULE}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/**
 * The message that wakes an agent with new messages in its conflict thread: a teammate's message
 * or agreement, the orchestrator adding something, or both humans' decision.
 */
export function threadMessage(c: ConflictRow, me: string, fresh: MessageRow[]): string {
  const other = otherAgent(c, me);
  const decision = fresh.filter((m) => m.kind === "decision").at(-1);
  const theyAgreed = fresh.some((m) => m.author === other && m.kind === "agree");
  const lines = fresh.map((m) => {
    const who = m.author === ORCHESTRATOR_NAME ? "The orchestrator" : m.kind === "decision" ? "Your humans decided" : m.author;
    const verb = m.kind === "decision" ? ":" : m.kind === "agree" ? " agrees:" : " says:";
    return `${who}${verb}\n${indent(m.body)}`;
  });
  const next = decision
    ? [`Do what your humans decided. Change only your own files, call check_with_team, then agree(${c.id}, "<the fact you both now treat as true>").`]
    : theyAgreed
      ? [`If you agree too and your side is done, call check_with_team, then agree(${c.id}, "<the fact>"). Otherwise reply with message_teammate(${c.id}, ...).`]
      : [`Reply with message_teammate(${c.id}, ...). When your side is done: check_with_team, then agree(${c.id}, "<the fact>"). Can't agree: escalate(${c.id}, "<why>").`];
  return clip(
    [`${MESSAGE_PREFIX} CONFLICT #${c.id} with ${other || "you"} (${c.error.split("\n")[0]}):`, ...lines, ...next, `  ${TEST_RULE}`].join("\n"),
  );
}

const KIND_LABEL: Record<InboxRow["kind"], string> = {
  conflict: "CONFLICT",
  task: "TASK",
  message: "message",
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

/** Why an agent may not end its turn yet: it owes a teammate a reply in a conflict thread. */
export function stopReasonReply(c: ConflictRow, me: string): string {
  const other = otherAgent(c, me);
  return `${MESSAGE_PREFIX} Conflict #${c.id} with ${other} is open and the last word in it isn't yours. Before you finish, reply with message_teammate(${c.id}, ...), agree(${c.id}, "<the fact>") once your side is done and check_with_team is green, or escalate(${c.id}, "<why>"). ${TEST_RULE}`;
}

/** Why an agent may not end its turn yet: a task from the orchestrator is still open. */
export function stopReasonTask(task: TaskRow): string {
  return `${MESSAGE_PREFIX} Task #${task.id} ("${task.title}") is still open. If it's done, call check_with_team and then complete_task(${task.id}, "<what you did>"). If you're waiting on a teammate, tell them with message_teammate in your conflict thread, then you can stop.`;
}

/** The team picture for a new session (and the team_status tool). */
export function teamStatus(
  agents: AgentRow[],
  intents: IntentRow[],
  myConflicts: ConflictRow[],
  myTasks: TaskRow[] = [],
  me = "",
): string {
  const facts = intents.filter((i) => i.verified || i.agent === ORCHESTRATOR_NAME);
  const plans = intents.filter((i) => !i.verified && i.agent !== ORCHESTRATOR_NAME).slice(-10);
  return clip(
    [
      `${MESSAGE_PREFIX} Team status`,
      ...agents.map((a) => `- ${a.name}: ${a.online ? "online" : "offline"}, ${a.status}${a.intent ? `, working on: ${a.intent}` : ""}`),
      facts.length ? "Verified facts (treat these as true):" : "",
      ...facts.map((f) => `- ${f.summary}`),
      plans.length ? "Recent plans from teammates:" : "",
      ...plans.map((p) => `- ${p.agent}: ${p.summary}`),
      myTasks.length ? "Your open tasks from the orchestrator:" : "",
      ...myTasks.map((t) => `- task #${t.id}${t.status === "waiting_review" ? " (waiting for review, don't start yet)" : ""}: ${t.title}`),
      ...myConflicts.map((c) =>
        c.status === "escalated"
          ? `Conflict #${c.id} with ${otherAgent(c, me) || "you"} is with both humans. Wait for their decision.`
          : `Conflict #${c.id} with ${otherAgent(c, me) || "you"} is open: settle it with message_teammate / agree / escalate first.`,
      ),
      "Before you change anything other files import, call the post_intent tool. To ask the orchestrator for something, use ask_orchestrator.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
