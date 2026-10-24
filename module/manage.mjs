/** WHAT IT'S FOR: Part C CLI entry points; require a configured database before publishing. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../shared/src/config.ts';

const modulePath = fileURLToPath(new URL('.', import.meta.url));
const action = process.argv[2];
let args;
let command = process.env.SPACETIME_CLI || 'spacetime';
if (action === 'generate') {
  command = process.execPath;
  args = [fileURLToPath(new URL('./generate.mjs', import.meta.url))];
} else if (action === 'publish' || action === 'logs') {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(config.stdbDb)) {
    console.error('Set the public STDB_DB process setting to the approved database name first.');
    process.exit(1);
  }
  args = action === 'publish'
    ? ['publish', config.stdbDb, '--module-path', modulePath, '--server', config.stdbHost]
    : ['logs', config.stdbDb, '--server', config.stdbHost];
} else {
  console.error('Usage: node module/manage.mjs generate|publish|logs');
  process.exit(1);
}
const result = spawnSync(command, args, { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
