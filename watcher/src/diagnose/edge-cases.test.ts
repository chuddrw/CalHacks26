/** WHAT IT'S FOR: safe default-adapter and failed fallback edge cases, using inert C settings. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseWithDroid} from './droid.ts';
import {createDiagnosisRunner,type DiagnosisInput} from './index.ts';
const input:DiagnosisInput={conflict:{id:901,pair:'a',kind:'self',agentA:'a',agentB:'',locA:'a.ts:1',locB:'',error:'fixture',explanation:'',fixer:'a',status:'open',runKey:'sha',createdAt:1,resolvedAt:0},sides:[],failingOutput:'fixture'};
test('default Droid adapter returns unavailable without fixture credentials or SDK startup',async()=>{
  let steps=0;
  assert.equal(await diagnoseWithDroid({...input,worktree:'/unused-fixture'},()=>{steps++;}),null);
  assert.equal(steps,0);
});
test('a thrown Claude fallback reports unavailability and still releases its own lease',async()=>{
  const details:string[]=[];let cleaned=0;
  const runner=createDiagnosisRunner({mode:'claude',isCurrent:()=>true,
    acquireWorktree:async()=>({path:'/unused-fixture',cleanup:async()=>{cleaned++;}}),
    claude:async()=>{throw new Error('fixture transport failure');},
    addDiagnosisStep:async(_id,_source,_kind,detail)=>{details.push(detail);},
    setExplanationIfCurrent:async()=>{throw new Error('must not publish unavailable output');},
  });
  assert.equal(await runner.diagnose(input),null);
  assert.deepEqual(details,['Asking Claude for diagnosis','Claude unavailable','diagnosis unavailable']);
  assert.equal(cleaned,1);
});
