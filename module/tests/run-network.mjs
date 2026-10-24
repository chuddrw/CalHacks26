/** WHAT IT'S FOR: self-contained local HTTP/WS integration test. Starts its own ephemeral server,
 * keys, CLI config and port, then cleans all resources. No account login, Maincloud or A/B/D needed.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const modulePath=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(new URL('../package.json',import.meta.url));
const temporary=mkdtempSync(path.join(os.tmpdir(),'cowork-network-suite-'));
const env={...process.env};
for(const key of Object.keys(env)) if(/TOKEN|SECRET|PASSWORD|API_KEY/.test(key)) delete env[key];
delete env.NODE_OPTIONS;
function executable(candidate){
  const choices=candidate.includes(path.sep)?[candidate]:(env.PATH??'').split(path.delimiter).map(directory=>path.join(directory,candidate));
  for(const choice of choices)try{accessSync(choice,constants.X_OK);return realpathSync(choice);}catch{}
  throw new Error(`Missing official SpacetimeDB executable ${candidate}; set SPACETIME_CLI and SPACETIMEDB_SCHEMA_EXTRACTOR to matching 2.13.0 binaries.`);
}
let server;
let client;
let serverExit;
let logs='';
try{
  const cli=executable(env.SPACETIME_CLI||'spacetime');
  const standalone=executable(env.SPACETIMEDB_SCHEMA_EXTRACTOR||path.join(path.dirname(cli),'spacetimedb-standalone'));
  const reservation=createServer();
  const port=await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',()=>resolve(reservation.address().port));});
  await new Promise((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const privatePath=path.join(temporary,'test-private.pem'),publicPath=path.join(temporary,'test-public.pem');
  writeFileSync(privatePath,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  writeFileSync(publicPath,keys.publicKey.export({type:'spki',format:'pem'}));
  server=spawn(standalone,['start','--listen-addr',`127.0.0.1:${port}`,'--data-dir',path.join(temporary,'data'),'--in-memory','--non-interactive','--jwt-priv-key-path',privatePath,'--jwt-pub-key-path',publicPath],{env,stdio:['ignore','pipe','pipe']});
  serverExit=new Promise(resolve=>{server.once('exit',(code,signal)=>resolve({code,signal}));server.once('error',error=>resolve({error}));});
  for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{logs=(logs+chunk.toString()).slice(-10000);});
  const deadline=Date.now()+15_000;
  while(true){
    if(server.exitCode!==null||server.signalCode)throw new Error(`Local server exited before readiness: ${logs}`);
    try{const response=await fetch(`http://127.0.0.1:${port}/v1/ping`,{signal:AbortSignal.timeout(300)});if(response.ok)break;}catch{}
    if(Date.now()>deadline)throw new Error(`Local server readiness timed out: ${logs}`);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  console.log('Part C: isolated HTTP/WebSocket integration (temporary local database)');
  client=spawn(process.execPath,[require.resolve('tsx/cli'),fileURLToPath(new URL('./access-network.mjs',import.meta.url))],{
    cwd:modulePath,env:{...env,SPACETIME_CLI:cli,COWORK_TEST_TEMP_ROOT:temporary,COWORK_TEST_PORT:String(port),COWORK_TEST_DATABASE:`cowork-access-${process.pid}`},stdio:'inherit',
  });
  const result=await new Promise(resolve=>{
    const timer=setTimeout(()=>{client.kill('SIGTERM');resolve({error:new Error('Local integration exceeded 45 seconds')});},45_000);
    client.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
    client.once('error',error=>{clearTimeout(timer);resolve({error});});
  });
  if(result.error)throw result.error;
  if(result.code!==0)throw new Error(`Local integration failed (${result.code??result.signal})`);
}catch(error){console.error(error.message);process.exitCode=1;}
finally{
  if(client&&client.exitCode===null&&!client.signalCode)client.kill('SIGTERM');
  if(server&&server.exitCode===null&&!server.signalCode){
    server.kill('SIGTERM');
    let timeout;
    await Promise.race([serverExit,new Promise(resolve=>{timeout=setTimeout(()=>{server.kill('SIGKILL');resolve();},2000);})]);
    clearTimeout(timeout);
    if(server.exitCode===null&&!server.signalCode)await serverExit;
  }
  rmSync(temporary,{recursive:true,force:true});
}
