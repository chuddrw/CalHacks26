/** WHAT IT'S FOR: measured C coverage across Vitest and native Node test processes. Both are
 * converted using AST-aware V8-to-Istanbul counters, then merged by original source location.
 * Byte-identical fixture copies are hash-checked before crediting them to the source file.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mergeScriptCovs} from '@bcoe/v8-coverage';
import convert from 'ast-v8-to-istanbul';
import {parseAstAsync} from 'vitest/node';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import {root,sourceFiles,relativeSources,vitestSourceFiles} from './coverage-scope.mjs';

const directory=fileURLToPath(new URL('../coverage',import.meta.url));
// Only this command's fixed report directory is removed; no caller-supplied deletion paths.
rmSync(directory,{recursive:true,force:true});
for(const name of ['native','copies'])mkdirSync(path.join(directory,name),{recursive:true});
const startedAt=new Date().toISOString();
const run=spawnSync(process.execPath,[fileURLToPath(new URL('./run-part-c.mjs',import.meta.url))],{
  cwd:root,env:{...process.env,COWORK_COVERAGE_DIR:directory},stdio:'inherit',timeout:120000,
});
if(run.error||run.status!==0){console.error(run.error?.message??'Tests failed; no successful coverage report will be published.');process.exit(1);}
const hash=source=>createHash('sha256').update(source).digest('hex');
const source=new Map(sourceFiles.map(file=>[file,readFileSync(file,'utf8')]));
const aliases=new Map();
for(const name of readdirSync(path.join(directory,'copies'))){
  const record=JSON.parse(readFileSync(path.join(directory,'copies',name),'utf8'));
  if(source.has(record.original)&&hash(source.get(record.original))===record.sha256)aliases.set(record.copy,record.original);
  else if(source.has(record.original))throw new Error(`Coverage source changed while tests ran: ${record.original}`);
}
const scripts=new Map();
for(const name of readdirSync(path.join(directory,'native')).filter(name=>name.endsWith('.json'))){
  const raw=JSON.parse(readFileSync(path.join(directory,'native',name),'utf8'));
  for(const script of raw.result??[]){
    let file;try{file=fileURLToPath(script.url);}catch{continue;}
    file=aliases.get(file)??file;
    if(!source.has(file))continue;
    // Native TS stripping preserves positions; an appended sourceURL footer is not executable source.
    const length=source.get(file).length;
    const functions=script.functions.map(fn=>({...fn,ranges:fn.ranges.filter(range=>range.startOffset<length).map(range=>({...range,endOffset:Math.min(length,range.endOffset)}))})).filter(fn=>fn.ranges.length);
    const normalized={...script,url:pathToFileURL(file).href,functions};
    const group=scripts.get(file)??[];group.push(normalized);scripts.set(file,group);
  }
}
const map=libCoverage.createCoverageMap({});
const vitestReport=path.join(directory,'vitest','coverage-final.json');
if(!existsSync(vitestReport))throw new Error('Vitest coverage output is missing');
const vitestMap=JSON.parse(readFileSync(vitestReport,'utf8'));
for(const file of vitestSourceFiles){
  if(!vitestMap[file])throw new Error(`Missing required Vitest coverage: ${file}`);
  map.addFileCoverage(vitestMap[file]);
}
for(const file of sourceFiles){
  if(vitestSourceFiles.includes(file))continue;
  const code=file.endsWith('.ts')?stripTypeScriptTypes(source.get(file),{mode:'strip'}):source.get(file);
  const group=scripts.get(file);
  // Include untouched files in the denominator rather than reporting only loaded modules.
  if(!group&&map.files().includes(file))continue;
  const coverage=group?mergeScriptCovs(group):{url:pathToFileURL(file).href,functions:[]};
  map.merge(await convert({code,ast:parseAstAsync(code),coverage,wrapperLength:0}));
}
map.filter(file=>source.has(file));
const context=libReport.createContext({dir:directory,coverageMap:map});
for(const name of ['text','html','json','json-summary'])reports.create(name).execute(context);
const summary=map.getCoverageSummary().toJSON();
const metadata={
  startedAt,completedAt:new Date().toISOString(),engine:'Vitest V8 + native Node V8, AST-aware Istanbul reports with one authoritative collector per file',
  scope:relativeSources,files:sourceFiles.length,fixtureCopies:aliases.size,
  collectors:{vitest:vitestSourceFiles.map(file=>path.relative(root,file)),node:sourceFiles.filter(file=>!vitestSourceFiles.includes(file)).map(file=>path.relative(root,file))},
  excludes:['A/B/D implementations','generated bindings','test code and infrastructure','node_modules','ignored separate demo repository'],
  notes:['Statements, functions and branches come from executable AST nodes; TypeScript types/comments are not counted.','Fixture-copy hits are credited only after byte-identity hashing.','Cross-engine counters are not merged for the same file; extra integration hits in Node-owned files are conservatively ignored.','No remote service, Maincloud, model API or user credentials are required.'],
  total:summary,
};
writeFileSync(path.join(directory,'measurement.json'),JSON.stringify(metadata,null,2)+'\n');
console.log(`Part C measured coverage: ${summary.lines.pct}% lines, ${summary.statements.pct}% statements, ${summary.functions.pct}% functions, ${summary.branches.pct}% branches`);
