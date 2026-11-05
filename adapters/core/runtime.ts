/**
 * adapters/core/runtime.ts
 *
 * WHAT IT'S FOR
 *   The side-effecting half of every non-Claude adapter, generalized from adapters/codex/runtime.ts:
 *   publishing consent, sync (snapshot + database report under a lock), Done marking and status.
 *   Parameterized by an Adapter ({ id, label }) so Cursor, Gemini CLI and any other client share
 *   one implementation and the same safety rules.
 *
 * STATE (all inside the workspace clone's .git directory, never in tracked files)
 *   cowork-<id>-publish-enabled.json   consent: agent, database, remote, automatic
 *   cowork-<id>-<agent>-<db>.json      publication state (pending + lastPublished)
 *   cowork-<id>-<agent>-<db>.json.lock one publisher at a time; holds the owner's PID
 *   cowork-<id>-publisher-<agent>.json     the publisher's PID file (cli.ts)
 *
 * SAFETY
 *   - Nothing is published until `enable --allow-publish` wrote a consent file that matches the
 *     current agent, database and remote. Automatic publishing (publisher, native hooks) additionally
 *     needs consent written with --allow-automatic.
 *   - Snapshots come from hooks/src/lib/snapshot.ts: Git plumbing in a temporary index, so the
 *     active branch, real index, stash and working files are never touched.
 *   - A lock left by a crashed process (its PID no longer exists) is recovered; a live one is respected.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, missingSettings } from '../../shared/src/config.ts';
import { callReducer, selectRows, sqlString } from '../../shared/src/stdb-http.ts';
import { gitDirOf, takeSnapshot } from '../../hooks/src/lib/snapshot.ts';
import { publishWork, type Publication, type SyncResult } from './publication.ts';

export interface Adapter { id: string; label: string }

/** A message that is safe to show the user as is (no paths with secrets, no server output). */
export class UsageError extends Error {}

const ID = /^[a-z0-9-]{1,40}$/;

/** Validates an adapter id and derives a display label ("cursor" -> "Cursor") when none is given. */
export function adapterFrom(id: string | undefined, label?: string): Adapter {
  if (!id || !ID.test(id)) throw new UsageError('--adapter must be 1-40 characters of a-z, 0-9 or "-".');
  const clean = (label ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return { id, label: clean || id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') };
}

export async function statePaths(adapter: Adapter, cwd: string) {
  const gitDir = await gitDirOf(cwd);
  const key = `${config.agent}-${config.stdbDb}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const state = path.join(gitDir, `cowork-${adapter.id}-${key}.json`);
  return {
    consent: path.join(gitDir, `cowork-${adapter.id}-publish-enabled.json`),
    state, lock: `${state}.lock`,
    publisher: path.join(gitDir, `cowork-${adapter.id}-publisher-${config.agent.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`),
  };
}

export async function enableReporting(adapter: Adapter, cwd: string, automatic = false) {
  if (missingSettings(['agent', 'stdbDb']).length) throw new UsageError('Set COWORK_NAME and STDB_DB in the Orkio .env first.');
  const { consent } = await statePaths(adapter, cwd);
  writeFileSync(consent, JSON.stringify({ agent: config.agent, database: config.stdbDb, remote: config.gitRemote, automatic }), { mode: 0o600 });
}

/** True only for consent matching the current agent, database and remote (and automatic, when asked). */
export async function reportingEnabled(adapter: Adapter, cwd: string, automatic = false) {
  try {
    const consent = JSON.parse(readFileSync((await statePaths(adapter, cwd)).consent, 'utf8'));
    return consent.agent === config.agent && consent.database === config.stdbDb && consent.remote === config.gitRemote
      && Boolean(config.agent) && (!automatic || consent.automatic === true);
  } catch { return false; }
}

function processAlive(pid: number): boolean | 'unknown' {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : 'unknown'; }
}

/** Takes the lock file, recovering it only when its owner PID is provably gone. False = busy. */
export function acquireLock(lock: string, alive: (pid: number) => boolean | 'unknown' = processAlive): boolean {
  if (existsSync(lock)) {
    let owner: number;
    try { owner = Number(readFileSync(lock, 'utf8')); } catch { return false; }
    if (!Number.isSafeInteger(owner) || owner < 1 || alive(owner) !== false) return false;
    rmSync(lock, { force: true });
  }
  try {
    const fd = openSync(lock, 'wx');
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}

function readState(file: string): Publication {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Publication : {};
}

export async function syncWork(adapter: Adapter, cwd: string, intent?: string, forceReport = false): Promise<SyncResult> {
  if (!await reportingEnabled(adapter, cwd)) throw new UsageError('Publishing is disabled. Run enable --allow-publish after approving its destinations.');
  if (missingSettings(['agent', 'stdbDb']).length) throw new UsageError('Set COWORK_NAME and STDB_DB in the Orkio .env first.');
  const files = await statePaths(adapter, cwd);
  if (!acquireLock(files.lock)) return { published: false, sha: null, busy: true };
  try {
    return await publishWork({
      snapshot: () => takeSnapshot(cwd, config.agent),
      read: () => readState(files.state),
      write: state => {
        writeFileSync(files.state + '.tmp', JSON.stringify(state), { mode: 0o600 });
        renameSync(files.state + '.tmp', files.state);
      },
      reportSnapshot: s => callReducer('post_snapshot', [config.agent, s.sha, s.baseSha, s.files, s.diff], 10000),
      reportIntent: (summary, changed) => callReducer('post_intent', [config.agent, summary, changed, []], 10000),
    }, adapter.label, intent, forceReport);
  } finally { rmSync(files.lock, { force: true }); }
}

/** The sha this adapter last published from this clone, if any (local state only). */
export async function lastPublishedSha(adapter: Adapter, cwd: string): Promise<string | null> {
  try { return readState((await statePaths(adapter, cwd)).state).lastPublished?.snapshot.sha ?? null; }
  catch { return null; }
}

/** The Done text. Says plainly that no check ran. */
export function doneSummary(sha: string, idle = false) {
  return `Done (${idle ? 'idle; ' : ''}not verified by check_with_team): snapshot ${sha.slice(0, 8)} published; no further changes detected.`;
}

export type PostIntent = (reducer: 'post_intent', args: [string, string, string[], string[]], timeoutMs: number) => Promise<void>;

/**
 * Mark a published snapshot Done: a "Done (not verified ...)" intent, and nothing else. It never calls
 * report_check. The module accepts any current green check_run for complete_task and conflict
 * resolution, so green must come only from check_with_team or the full-stack build.
 */
export async function markDone(sha: string, idle = false, post: PostIntent = callReducer) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new UsageError('A full published snapshot SHA is required.');
  const summary = doneSummary(sha, idle);
  await post('post_intent', [config.agent, summary, [], []], 10000);
  return summary;
}

/** Read-only view of this agent in the database; also how the publisher detects a database reset. */
export async function status() {
  if (missingSettings(['agent', 'stdbDb']).length) throw new UsageError('Set COWORK_NAME and STDB_DB in the Orkio .env first.');
  const [agents, snapshots] = await Promise.all([
    selectRows('agent'), selectRows('snapshot', `agent = ${sqlString(config.agent)}`),
  ]);
  const agent = agents.find(row => row.name === config.agent);
  const latest = snapshots.sort((a, b) => b.id - a.id)[0];
  return { database: config.stdbDb, agent: config.agent, online: agent?.online ?? false,
    status: agent?.status ?? 'unknown', intent: agent?.intent ?? '', files: agent?.files ?? [],
    snapshotSha: latest?.sha ?? null };
}
