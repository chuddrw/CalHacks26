/**
 * bench/db-counts.ts
 *
 * WHAT IT'S FOR
 *   The Agent Cowork side of the benchmark (bench/benchmark.py). It counts what happened in the team
 *   database during one benchmark run: how often a human decided something on the dashboard, how
 *   often the system woke an agent by itself, how many messages the agents sent each other, and how
 *   many conflicts were found before anything reached main. It prints one JSON object and changes
 *   nothing in the database.
 *
 * USAGE (run by `python bench/benchmark.py collect --db ...`; you rarely call it yourself)
 *   node bench/db-counts.ts --since <epoch ms> --until <epoch ms>
 *   Reads STDB_HOST / STDB_DB from .env and signs in with this laptop's `spacetime login`, like the
 *   other scripts. Needs read access to the team database.
 *
 * OWNER: A (benchmark, Oct 24).
 */
import { config, missingSettings } from "../shared/src/config.ts";
import { ORCHESTRATOR_NAME, WAKE_KINDS, type TableName, type TableRows } from "../shared/src/schema.ts";
import { finishProcess, selectRows } from "../shared/src/stdb-http.ts";

const args = process.argv.slice(2);
function arg(name: string): number {
  const i = args.indexOf(name);
  const value = i >= 0 ? Number(args[i + 1]) : NaN;
  if (!Number.isFinite(value)) throw new Error(`missing ${name} <epoch ms>`);
  return value;
}

/** True when a row's millisecond timestamp falls inside the run. */
function within(ms: unknown, since: number, until: number): boolean {
  const n = Number(ms);
  return n > 0 && n >= since && n <= until;
}

function tally<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
  return out;
}

async function main(): Promise<number> {
  const missing = missingSettings(["stdbDb"]);
  if (missing.length > 0) {
    console.log(JSON.stringify({ error: `Fill in ${missing.join(", ")} in .env first (see .env.example).` }));
    return 1;
  }
  const since = arg("--since");
  const until = arg("--until");
  const inRun = <T extends { createdAt: number }>(rows: T[]) => rows.filter((row) => within(row.createdAt, since, until));

  // A database running an older module lacks some tables: count what is there and say what isn't.
  const missingTables: string[] = [];
  const rowsOf = <T extends TableName>(table: T) =>
    selectRows(table).catch((error: unknown) => {
      if (!/no such table/i.test(String(error))) throw error;
      missingTables.push(table);
      return [] as TableRows[T][];
    });
  const [reviews, messages, conflicts, inbox, requests, tasks, checks, builds] = await Promise.all([
    rowsOf("review"),
    rowsOf("message"),
    rowsOf("conflict"),
    rowsOf("inbox"),
    rowsOf("request"),
    rowsOf("task"),
    rowsOf("check_run"),
    rowsOf("build"),
  ]);

  const decided = reviews.filter((review) => review.status !== "pending" && within(review.decidedAt, since, until));
  const runMessages = inRun(messages);
  const humanDecisions = runMessages.filter((message) => message.kind === "decision");
  // The orchestrator's own notes in a thread aren't agents talking to each other.
  // An escalation also writes a second "asked for a decision" row at the same moment: count it once.
  const seenMessages = new Set<string>();
  const agentMessages = runMessages.filter((message) => {
    if (message.kind === "decision" || message.author === ORCHESTRATOR_NAME) return false;
    const key = `${message.conflictId}|${message.author}|${message.kind}|${message.createdAt}`;
    if (seenMessages.has(key)) return false;
    seenMessages.add(key);
    return true;
  });
  const runConflicts = inRun(conflicts);
  const wakes = inRun(inbox).filter((row) => WAKE_KINDS.includes(row.kind));
  const runChecks = inRun(checks);

  console.log(
    JSON.stringify({
      db: config.stdbDb,
      host: config.stdbHost,
      ...(missingTables.length ? { missingTables } : {}),
      requests: inRun(requests).length,
      tasks: inRun(tasks).length,
      // Human touches on the dashboard.
      reviewsDecided: decided.length,
      reviewsByStatus: tally(decided, (review) => review.status),
      escalationDecisions: humanDecisions.length,
      conflictsNeedingPerson: runConflicts.filter((conflict) => conflict.status === "needs_human").length,
      // Work the system did without a human.
      autoWakes: wakes.length,
      autoWakesByKind: tally(wakes, (row) => row.kind),
      agentMessages: agentMessages.length,
      agentMessagesByKind: tally(agentMessages, (message) => message.kind),
      conflictsCaught: runConflicts.length,
      conflictsByStatus: tally(runConflicts, (conflict) => conflict.status),
      checksRun: runChecks.length,
      checksRed: runChecks.filter((check) => check.result === "red").length,
      fullStackBuilds: inRun(builds).length,
      fullStackRed: inRun(builds).filter((build) => build.result === "red").length,
    }),
  );
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
await finishProcess(code);
