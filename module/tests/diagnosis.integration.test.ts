/** WHAT IT'S FOR: integrate C's real datastore/auth/notifications with C's diagnosis runner and
 * disposable leases. Provider behavior is injected; no A/B/D code, model keys, or network is used.
 */
import { expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import database, * as reducers from '../src/index';
import { createDiagnosisRunner, type DiagnosisInput, type WorktreeLease } from '../../watcher/src/diagnose/index.ts';
import type { Diagnosis } from '../../watcher/src/diagnose/prompt.ts';
import type { ConflictRow } from '../../shared/src/schema.ts';

type Ctx = Parameters<typeof reducers.post_snapshot>[0];
const proposed: Diagnosis = {summary:'Unit mismatch',cause:'One change stores milliseconds; the other assumes seconds.',suggestion:'Convert the idle calculation to milliseconds.',fact:'User.lastLogin is milliseconds.'};
function fixture() {
  const h = createModuleTestHarness(database, reducers);
  const auth = (sub: string, id: bigint) => TestAuth.fromJwtPayload(JSON.stringify({iss:'c-integration',sub}),new ConnectionId(id));
  const owner = auth('owner',1n);
  const diagnoser = auth('diagnoser',2n);
  const ownerIdentity = h.viewContext(owner).sender.toHexString();
  const identity = h.viewContext(diagnoser).sender.toHexString();
  const env = {ACCESS_OWNER_IDENTITY:ownerIdentity,get:(() => ownerIdentity) as Ctx['env']['get']};
  const tx = <T>(caller: TestAuth, fn: (ctx: Ctx) => T) => h.withReducerTx(caller,ctx => fn({
    ...ctx,identity:ctx.identity,databaseIdentity:ctx.databaseIdentity,senderAuth:ctx.senderAuth,env,
  }));
  tx(owner,ctx => {
    reducers.grant_access(ctx,{identity,role:'editor'});
    reducers.post_snapshot(ctx,{agent:'a',sha:'a1',baseSha:'base',files:['user.ts'],diff:'lastLogin = at.getTime()'});
    reducers.post_snapshot(ctx,{agent:'b',sha:'b1',baseSha:'base',files:['idle.ts'],diff:'now / 1000 - lastLogin'});
    reducers.report_check(ctx,{runKey:'a1+b1',agents:['a','b'],result:'red',log:'Expected 31 minutes'});
    reducers.report_conflict(ctx,{kind:'pair',agentA:'a',agentB:'b',locA:'user.ts:1',locB:'idle.ts:1',error:'Expected 31 minutes',fixer:'b',runKey:'a1+b1'});
  });
  const conflict = [...h.db.conflictData.iter()][0]! as ConflictRow;
  const input: DiagnosisInput = {conflict,sides:[...h.db.snapshotData.iter()].map(s => ({agent:s.agent,intent:'',files:s.files,diff:s.diff})),failingOutput:'Expected 31 minutes'};
  const leases: string[] = [];
  const acquireWorktree = async (): Promise<WorktreeLease> => {
    const directory = await mkdtemp(path.join(os.tmpdir(),'cowork-c-integration-'));
    leases.push(directory);
    await writeFile(path.join(directory,'evidence.txt'),input.failingOutput);
    return {path:directory,cleanup:() => rm(directory,{recursive:true,force:true})};
  };
  const current = () => {
    const row = h.db.conflictData.id.find(conflict.id);
    return row?.status === 'open' && row.runKey === conflict.runKey && row.error === conflict.error;
  };
  const dependencies = {
    acquireWorktree,
    isCurrent:current,
    addDiagnosisStep:async (conflictId:number,source:'droid'|'claude',kind:Parameters<typeof reducers.add_diagnosis_step>[1]['kind'],detail:string) => {
      tx(diagnoser,ctx => reducers.add_diagnosis_step(ctx,{conflictId,source,kind,detail}));
    },
    setExplanationIfCurrent:async (conflictId:number,expectedRunKey:string,expectedError:string,expectedFixer:string,explanation:string) => {
      tx(diagnoser,ctx => reducers.set_explanation_if_current(ctx,{conflictId,expectedRunKey,expectedError,expectedFixer,explanation}));
    },
  };
  return {h,owner,diagnoser,identity,tx,input,leases,dependencies};
}

it('persists a diagnosis through authorized callbacks, releases the lease, and publishes its fact only on resolution', async () => {
  const f = fixture();
  const runner = createDiagnosisRunner({...f.dependencies,mode:'droid',droid:async (context,onStep) => {
    expect(await readFile(path.join(context.worktree,'evidence.txt'),'utf8')).toBe(f.input.failingOutput);
    expect(context.sides.map(s => s.agent)).toEqual(['a','b']);
    onStep('tool_call','Read evidence.txt');
    onStep('tool_result','Expected 31 minutes');
    return proposed;
  }});
  try {
    const result = await runner.diagnose(f.input);
    expect(result).toEqual(proposed);
    expect(f.h.db.conflictData.id.find(f.input.conflict.id)?.explanation).toContain(proposed.cause);
    expect([...f.h.db.diagnosisStepData.iter()].map(s => s.kind)).toEqual(['status','tool_call','tool_result','final']);
    expect([...f.h.db.inboxData.iter()].filter(m => m.kind === 'info')).toHaveLength(1); // Only original non-fixer note.
    expect([...f.h.db.intentData.iter()].filter(row => row.verified)).toEqual([]);
    expect(f.h.db.conflictData.id.find(f.input.conflict.id)?.status).toBe('open');
    await expect(access(f.leases[0]!)).rejects.toThrow();
    f.tx(f.diagnoser,ctx => {
      reducers.post_snapshot(ctx,{agent:'b',sha:'fixed',baseSha:'base',files:['idle.ts'],diff:'milliseconds fix'});
      reducers.report_check(ctx,{runKey:'a1+fixed',agents:['a','b'],result:'green',log:'checks passed'});
      reducers.resolve_conflict_if_current(ctx,{conflictId:f.input.conflict.id,expectedRunKey:f.input.conflict.runKey,
        expectedError:f.input.conflict.error,expectedFixer:f.input.conflict.fixer,verifiedRunKey:'a1+fixed',verifiedFact:result!.fact});
    });
    expect([...f.h.db.agentData.iter()].every(row => row.status === 'green')).toBe(true);
    expect([...f.h.db.intentData.iter()]).toMatchObject([{agent:'watcher',verified:true,summary:proposed.fact}]);
    expect([...f.h.db.inboxData.iter()].filter(row => row.kind === 'fact').map(row => row.agent).sort()).toEqual(['a','b']);
    expect(f.h.db.escalation_timer.count()).toBe(0n);
  } finally { await Promise.all(f.leases.map(directory => rm(directory,{recursive:true,force:true}))); }
});

it('revoking the diagnosis identity mid-investigation denies publication and still cleans its worktree', async () => {
  const f = fixture();
  let started!: () => void;
  let finish!: (value:Diagnosis) => void;
  const ready = new Promise<void>(resolve => { started=resolve; });
  const runner = createDiagnosisRunner({...f.dependencies,mode:'droid',droid:async () => { started();return new Promise<Diagnosis>(resolve => {finish=resolve;}); }});
  const pending = runner.diagnose(f.input);
  try {
    await ready;
    f.tx(f.owner,ctx => reducers.revoke_access(ctx,{identity:f.identity}));
    finish(proposed);
    await expect(pending).rejects.toThrow('Editor access required');
    expect(f.h.db.conflictData.id.find(f.input.conflict.id)?.explanation).toBe('');
    expect([...f.h.db.intentData.iter()].filter(row => row.verified)).toEqual([]);
    await expect(access(f.leases[0]!)).rejects.toThrow();
  } finally { await Promise.all(f.leases.map(directory => rm(directory,{recursive:true,force:true}))); }
});

it('a human-review transition during diagnosis suppresses final output without changing review status', async () => {
  const f = fixture();
  let started!: () => void;
  let finish!: (value:Diagnosis) => void;
  const ready = new Promise<void>(resolve => {started=resolve;});
  const runner=createDiagnosisRunner({...f.dependencies,mode:'droid',droid:async () => {started();return new Promise<Diagnosis>(resolve => {finish=resolve;});}});
  const pending=runner.diagnose(f.input);
  try {
    await ready;
    f.tx(f.owner,ctx => reducers.flag_needs_human(ctx,{conflictId:f.input.conflict.id,reason:'test was removed'}));
    finish(proposed);
    expect(await pending).toBeNull();
    expect(f.h.db.conflictData.id.find(f.input.conflict.id)).toMatchObject({status:'needs_human',explanation:''});
    expect([...f.h.db.intentData.iter()].filter(row => row.verified)).toEqual([]);
    expect([...f.h.db.agentData.iter()].every(row => row.status === 'red')).toBe(true);
    await expect(access(f.leases[0]!)).rejects.toThrow();
  } finally {await Promise.all(f.leases.map(directory => rm(directory,{recursive:true,force:true})));}
});
