/** WHAT IT'S FOR: credit fixture copies only when they are byte-identical to the actual C source.
 * Optional coverage metadata contains code/hashes and paths only, never fixture .env contents.
 */
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import path from 'node:path';
export function recordCoverageCopy(original,copy){
  const directory=process.env.COWORK_COVERAGE_SOURCE_MAPS;
  if(!directory)return;
  const source=readFileSync(original,'utf8');
  if(source!==readFileSync(copy,'utf8'))throw new Error('Coverage source copy differs from implementation');
  mkdirSync(directory,{recursive:true});
  writeFileSync(path.join(directory,`${process.pid}-${randomUUID()}.json`),JSON.stringify({original:realpathSync(original),copy:realpathSync(copy),sha256:createHash('sha256').update(source).digest('hex')}));
}
export function coverageChildEnvironment(){
  return process.env.NODE_V8_COVERAGE?{NODE_V8_COVERAGE:process.env.NODE_V8_COVERAGE}:{};
}
