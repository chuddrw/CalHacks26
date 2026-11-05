/**
 * adapters/core/cli.ts
 *
 * WHAT IT'S FOR
 *   The one command line every non-Claude adapter (Cursor, Gemini CLI, Python, any MCP client) uses
 *   for publishing and presence, generalized from adapters/codex/cli.ts. Other adapters call it as a
 *   subprocess, so the contract below is fixed.
 *
 * CONTRACT
 *   node --import tsx adapters/core/cli.ts <command> --adapter <id> [--label <Label>] [--cwd <repo>]
 *        [--intent <text>] [--force-report] [--allow-publish] [--allow-automatic]
 *   enable  write consent (needs --allow-publish; --allow-automatic also allows publisher + native hooks)
 *   sync    one publication; stdout ONE line: {"published":boolean,"sha":string|null,"busy"?:boolean}
 *   status  stdout JSON {database, agent, online, status, intent, files, snapshotSha}
 *   start   start the background publisher (needs automatic consent); prints its PID
 *   publish run the publisher in the foreground (what `start` spawns)
 *   stop    stop the publisher and so its online presence
 *   done    post a "Done (not verified by check_with_team): ..." intent for the latest published
 *           snapshot (never report_check); stdout {"summary":...}
 *   Errors: exit code 1 and a generic message on stderr. Never server output, tokens or file contents.
 *
 * THE PUBLISHER
 *   Holds a SpacetimeDB WebSocket (register_agent on connect and reconnect = online presence), syncs
 *   every 2 s, checks every ~30 s whether the database lost our snapshot (reset) and republishes it
 *   without a new Git commit, and after 5 unchanged cycles (~10 s) posts a "Done (idle; not verified)"
 *   intent. Nothing here ever reports a check: green comes only from check_with_team / the full stack.
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config } from '../../shared/src/config.ts';
import { sessionToken } from '../../shared/src/session-token.ts';
import { quietStep, type QuietState } from './publication.ts';
import {
  adapterFrom, enableReporting, lastPublishedSha, markDone, reportingEnabled, statePaths, status, syncWork,
  UsageError, type Adapter,
} from './runtime.ts';

const DONE_AFTER_QUIET_CYCLES = 5;
const POLL_MS = 2000;
const RESET_CHECK_EVERY = 15;
export const COMMANDS = ['enable', 'sync', 'status', 'start', 'publish', 'stop', 'done'] as const;
export type Command = typeof COMMANDS[number];
const CLI_FILE = fileURLToPath(import.meta.url);

export interface CliArgs {
  command: Command; adapter: Adapter; cwd: string; intent?: string;
  forceReport: boolean; allowPublish: boolean; allowAutomatic: boolean;
}

/** Parses and validates argv (without node and script). Throws UsageError on anything unexpected. */
export function parseCli(argv: string[], base = process.cwd()): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      adapter: { type: 'string' }, label: { type: 'string' }, cwd: { type: 'string' }, intent: { type: 'string' },
      'force-report': { type: 'boolean' }, 'allow-publish': { type: 'boolean' }, 'allow-automatic': { type: 'boolean' },
    } });
  } catch { throw new UsageError(usage()); }
  const { values, positionals } = parsed;
  const command = positionals[0] as Command;
  if (positionals.length !== 1 || !COMMANDS.includes(command)) throw new UsageError(usage());
  return {
    command, adapter: adapterFrom(values.adapter, values.label), cwd: path.resolve(base, values.cwd || '.'),
    intent: values.intent, forceReport: values['force-report'] === true,
    allowPublish: values['allow-publish'] === true, allowAutomatic: values['allow-automatic'] === true,
  };
}

export function usage() {
  return `Usage: node --import tsx adapters/core/cli.ts <${COMMANDS.join('|')}> --adapter <id> [--label <Label>] `
    + '[--cwd <repo>] [--intent <text>] [--force-report] [--allow-publish] [--allow-automatic]';
}

/** PID of this adapter's live publisher, or undefined. Checks the process really is our publisher. */
export function running(file: string, adapter: Adapter): number | undefined {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data.adapter !== `orkio-${adapter.id}` || !Number.isInteger(data.pid) || data.pid < 1) return;
    process.kill(data.pid, 0);
    const command = execFileSync('ps', ['-p', String(data.pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
    if (!command.replaceAll('\\', '/').includes('adapters/core/cli.ts') || !` ${command} `.includes(' publish ') || !` ${command.trim()} `.includes(` --adapter ${adapter.id} `)) return;
    return data.pid;
  } catch { return; }
}

/**
 * Atomically claims the publisher PID file. An existing file is removed only when it does not name a
 * live publisher for this adapter, then the create is retried once. Two publishers starting at the same
 * moment: exactly one create ('wx') succeeds, the other sees a live owner and returns false.
 */
export function claimPidFile(file: string, adapter: Adapter, live: (file: string, adapter: Adapter) => number | undefined = running): boolean {
  const body = JSON.stringify({ adapter: `orkio-${adapter.id}`, pid: process.pid });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(file, body, { flag: 'wx', mode: 0o600 }); return true; }
    catch {
      let seen: string;
      try { seen = readFileSync(file, 'utf8'); } catch { continue; } // vanished: retry the create
      const owner = live(file, adapter);
      if (owner) return owner === process.pid;
      // Stale: remove it only if it still holds exactly what we judged stale (not a newer claim).
      try { if (attempt === 0 && readFileSync(file, 'utf8') === seen) rmSync(file, { force: true }); } catch { /* gone */ }
    }
  }
  return false;
}

const automaticOff = () => new UsageError('Automatic publishing is disabled. Run enable --allow-publish --allow-automatic after approving continuous reporting.');

export async function startPublisher(adapter: Adapter, cwd: string): Promise<number | undefined> {
  if (!await reportingEnabled(adapter, cwd, true)) throw automaticOff();
  const file = (await statePaths(adapter, cwd)).publisher;
  const pid = running(file, adapter);
  if (pid) return pid;
  const log = openSync(file + '.log', 'a', 0o600);
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_FILE, 'publish', '--adapter', adapter.id,
      '--label', adapter.label, '--cwd', cwd], { cwd: config.repoRoot, detached: true, stdio: ['ignore', log, log] });
    child.unref();
    return child.pid;
  } finally { closeSync(log); }
}

async function publish(adapter: Adapter, cwd: string, intent?: string) {
  if (!await reportingEnabled(adapter, cwd, true)) throw automaticOff();
  const file = (await statePaths(adapter, cwd)).publisher;
  if (!claimPidFile(file, adapter)) { console.log(`${adapter.label} publisher is already running.`); return; }
  const { DbConnection } = await import('../../shared/module_bindings/index.ts');
  let connection: InstanceType<typeof DbConnection> | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const shutdown = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    connection?.disconnect();
    if (running(file, adapter) === process.pid) rmSync(file, { force: true });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const token = await sessionToken();
  if (!token) { shutdown(); throw new UsageError('Sign in with spacetime login before starting the publisher.'); }
  const register = (conn: InstanceType<typeof DbConnection>) => {
    void conn.reducers.registerAgent({ agent: config.agent }).then(
      () => console.log(`Presence connected: ${config.agent} in ${config.stdbDb}.`),
      () => console.error('Presence registration failed; check Editor access.'),
    );
  };
  connection = DbConnection.builder().withUri(config.stdbHost).withDatabaseName(config.stdbDb).withToken(token)
    .withAutomaticReconnect().onConnect(register).onAutomaticReconnect(register)
    .onConnectError(() => console.error('Presence connection failed; check sign-in and database access.')).build();
  let cycles = 0;
  let quiet: QuietState = { quietCycles: 0 };
  async function tick() {
    if (stopped) return;
    try {
      // Restore published work after a database reset, without creating another Git commit.
      const force = cycles++ % RESET_CHECK_EVERY === 0 && !(await status()).snapshotSha;
      const result = await syncWork(adapter, cwd, intent, force);
      if (result.published) console.log(`Published snapshot ${result.sha} to ${config.stdbDb}.`);
      const step = quietStep(quiet, result, DONE_AFTER_QUIET_CYCLES);
      if (step.done) console.log(await markDone(step.done, true));
      quiet = step.state; // only after markDone succeeded, so a failed Done is retried next cycle
    } catch { console.error(`${adapter.label} publication failed; retrying. No working files were changed.`); }
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  }
  await tick();
}

export async function run(args: CliArgs, out: (line: string) => void = line => console.log(line)) {
  const { adapter, cwd } = args;
  switch (args.command) {
    case 'enable':
      if (!args.allowPublish) throw new UsageError('Use --allow-publish only after approving GitHub snapshots and database reporting.');
      await enableReporting(adapter, cwd, args.allowAutomatic);
      out(`Enabled ${adapter.label} publication to ${config.gitRemote}/wip/${config.agent} and ${config.stdbDb}`
        + (args.allowAutomatic ? ' (automatic: publisher and native hooks allowed).' : ' (manual sync only).'));
      break;
    case 'sync': out(JSON.stringify(await syncWork(adapter, cwd, args.intent, args.forceReport))); break;
    case 'status': out(JSON.stringify(await status(), null, 2)); break;
    case 'start': out(`${adapter.label} publisher PID: ${await startPublisher(adapter, cwd)}`); break;
    case 'publish': await publish(adapter, cwd, args.intent); break;
    case 'stop': {
      const pid = running((await statePaths(adapter, cwd)).publisher, adapter);
      if (pid) { process.kill(pid, 'SIGTERM'); out(`${adapter.label} publisher stopped.`); }
      else out(`No ${adapter.label} publisher is running.`);
      break;
    }
    case 'done': {
      if (!await reportingEnabled(adapter, cwd)) throw new UsageError('Publishing is disabled. Run enable --allow-publish first.');
      const sha = await lastPublishedSha(adapter, cwd) ?? (await status()).snapshotSha;
      if (!sha) throw new UsageError('Nothing has been published yet. Run sync first.');
      out(JSON.stringify({ summary: await markDone(sha) }));
      break;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === CLI_FILE) {
  try {
    await run(parseCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof UsageError ? error.message
      : 'Orkio adapter failed. Check Git access, spacetime login, and database Editor access.');
    process.exitCode = 1;
  }
}
