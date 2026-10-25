/** WHAT IT'S FOR: exercise C's approval CLI process boundary with a local recording executable,
 * never a database, actual account, credential file or remote service.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {coverageChildEnvironment} from './coverage-source.mjs';
const command = fileURLToPath(new URL('../access.mjs',import.meta.url));
// --import needs a file:// URL; a plain absolute Windows path fails.
const loader = new URL('./register-dependencies.mjs',import.meta.url).href;
const identity = 'ab'.repeat(32);
function fixture() {
  const directory=mkdtempSync(path.join(os.tmpdir(),'cowork-admin-cli-'));
  const capture=path.join(directory,'arguments.json');
  const cli=path.join(directory,'fake-spacetime');
  writeFileSync(cli, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.COWORK_TEST_CAPTURE,JSON.stringify(process.argv.slice(2)));process.exit(Number(process.env.COWORK_TEST_EXIT || 0));\n`,{mode:0o700});
  const run=(args,exit='0') => spawnSync(process.execPath,['--import',loader,command,...args],{
    cwd:directory,encoding:'utf8',timeout:5000,
    env:{PATH:process.env.PATH,...coverageChildEnvironment(),SPACETIME_CLI:cli,COWORK_TEST_CAPTURE:capture,COWORK_TEST_EXIT:exit},
  });
  return {directory,capture,run};
}
for (const role of ['reader','editor']) test(`grant ${role} forwards only the reviewed database, public identity and role`,() => {
  const f=fixture();
  try {
    const result=f.run(['grant','agent-cowork-orch',identity,role]);
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.capture,'utf8')),['call','agent-cowork-orch','grant_access',JSON.stringify(identity),JSON.stringify(role),'--server','http://127.0.0.1:1']);
  } finally {rmSync(f.directory,{recursive:true,force:true});}
});
test('revoke forwards one public identity and propagates CLI failure without inventing success',() => {
  const f=fixture();
  try {
    const result=f.run(['revoke','agent-cowork-orch',identity],'7');
    assert.equal(result.status,7);
    assert.deepEqual(JSON.parse(readFileSync(f.capture,'utf8')),['call','agent-cowork-orch','revoke_access',JSON.stringify(identity),'--server','http://127.0.0.1:1']);
  } finally {rmSync(f.directory,{recursive:true,force:true});}
});
for (const [label,args] of [
  ['missing arguments',[]],
  ['unknown operation',['delete','agent-cowork-orch',identity]],
  ['injected target',['grant','--server',identity,'reader']],
  ['malformed identity',['grant','agent-cowork-orch','not-an-identity','editor']],
  ['zero identity',['grant','agent-cowork-orch','0'.repeat(64),'editor']],
  ['owner escalation',['grant','agent-cowork-orch',identity,'owner']],
  ['extra revoke role',['revoke','agent-cowork-orch',identity,'editor']],
  ['unexpected arguments',['grant','agent-cowork-orch',identity,'reader','--anonymous']],
]) test(`approval CLI rejects ${label} before launching a subprocess`,() => {
  const f=fixture();
  try {const result=f.run(args);assert.equal(result.status,1);assert.match(result.stderr,/Usage:/);assert.equal(existsSync(f.capture),false);}
  finally {rmSync(f.directory,{recursive:true,force:true});}
});
