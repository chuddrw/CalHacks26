/** WHAT IT'S FOR: explicit snapshot/check evidence for reducer component fixtures, never a guard bypass. */
import * as module from '../src/index';
type Ctx = Parameters<typeof module.post_snapshot>[0];

export function seedRedConflict(ctx: Ctx, args: Parameters<typeof module.report_conflict>[1]): void {
  const agents = [args.agentA, args.agentB].filter(Boolean);
  const shas = args.runKey.split('+');
  if (agents.length !== shas.length) throw new Error('Conflict fixture runKey must list its participant snapshot SHAs.');
  const snapshots = [...ctx.db.snapshotData.iter()];
  for (const [index, agent] of agents.entries()) {
    const sha = shas.find(sha => sha.startsWith(agent)) ?? shas[index]!;
    const latest = snapshots.filter(row => row.agent === agent).sort((a, b) => b.id - a.id)[0];
    if (latest?.sha !== sha) module.post_snapshot(ctx, { agent, sha, baseSha: 'base', files: [], diff: '' });
  }
  module.report_check(ctx, { runKey: args.runKey, agents, result: 'red', log: args.error });
  module.report_conflict(ctx, args);
}

export function reportCurrentGreen(ctx: Ctx, conflictId: number): string {
  const conflict = ctx.db.conflictData.id.find(conflictId);
  if (!conflict) throw new Error('Green fixture requires an existing conflict.');
  const agents = [conflict.agentA, conflict.agentB].filter(Boolean);
  const snapshots = [...ctx.db.snapshotData.iter()];
  const shas = agents.map(agent => snapshots.filter(row => row.agent === agent).sort((a, b) => b.id - a.id)[0]?.sha);
  if (shas.some(sha => !sha)) throw new Error('Green fixture requires snapshots for every participant.');
  const runKey = (shas as string[]).sort().join('+');
  module.report_check(ctx, { runKey, agents, result: 'green', log: 'fixture checks passed' });
  return runKey;
}

export function resolveAfterGreen(ctx: Ctx, args: Parameters<typeof module.resolve_conflict>[1]): void {
  if (ctx.db.conflictData.id.find(args.conflictId)) reportCurrentGreen(ctx, args.conflictId);
  module.resolve_conflict(ctx, args);
}
