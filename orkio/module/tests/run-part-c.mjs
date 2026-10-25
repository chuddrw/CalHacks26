/** WHAT IT'S FOR: run all C-owned unit/subcomponent/component/datastore-integration tests from one
 * standalone dependency install, without A/B/D setup, developer secrets, or remote services.
 */
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const modulePath=fileURLToPath(new URL('..',import.meta.url));
const root=path.dirname(modulePath);
const require=createRequire(new URL('../package.json',import.meta.url));
// --import needs a file:// URL: a plain absolute path like c:... fails on Windows.
const loader=new URL('./register-dependencies.mjs',import.meta.url).href;
const env={...process.env};
for(const key of Object.keys(env)) if(/TOKEN|SECRET|PASSWORD|API_KEY/.test(key)) delete env[key];
delete env.NODE_OPTIONS;
const files=[
  ...globSync('orchestrator/src/diagnose/*.test.ts',{cwd:root}),
  ...globSync('scripts/demo-reset*.test.ts',{cwd:root}),
  ...globSync('shared/src/*.test.ts',{cwd:root}),
  'module/tests/generate.test.mjs',
  ...globSync('module/tests/*-cli.unit.test.mjs',{cwd:root}),
].sort().map(file=>path.join(root,file));
const coverageDirectory=env.COWORK_COVERAGE_DIR;
const suites=[
  {name:'Database, adapter components and C datastore integration',args:[path.join(path.dirname(require.resolve('vitest/package.json')),'vitest.mjs'),'run',...(coverageDirectory?['--coverage','--coverage.reportsDirectory',path.join(coverageDirectory,'vitest')]:[])],cwd:modulePath},
  {name:'Diagnosis/shared units, adapters, orchestration and reset safety',args:['--import',loader,'--test',...files],cwd:root},
];
let failed=false;
for(const [index,suite] of suites.entries()){
  console.log(`Part C: ${suite.name}`);
  const result=spawnSync(process.execPath,suite.args,{cwd:suite.cwd,env:coverageDirectory&&index===1?{...env,NODE_V8_COVERAGE:path.join(coverageDirectory,'native'),COWORK_COVERAGE_SOURCE_MAPS:path.join(coverageDirectory,'copies')}:env,stdio:'inherit',timeout:60_000});
  if(result.error){console.error(result.error.message);failed=true;}
  if(result.status!==0) failed=true;
}
process.exitCode=failed?1:0;
