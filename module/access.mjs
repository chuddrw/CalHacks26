/** WHAT IT'S FOR: owner-only membership commands using the caller's existing CLI sign-in.
 * Arguments contain public identities and roles only. This never reads or prints auth tokens.
 */
import { spawnSync } from 'node:child_process';
import { config } from '../shared/src/config.ts';
const [action, database, identity, role, ...extra] = process.argv.slice(2);
const valid = ['grant', 'revoke'].includes(action) && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(database ?? '')
  && /^(?:0x)?[0-9a-fA-F]{64}$/.test(identity ?? '') && !/^0x?0+$/.test(identity ?? '')
  && (action === 'grant' ? ['reader', 'editor'].includes(role) : role === undefined) && !extra.length;
if (!valid) {
  console.error('Usage: node module/access.mjs grant <database> <public-identity> reader|editor\n       node module/access.mjs revoke <database> <public-identity>');
  process.exit(1);
}
const args = ['call', database, action === 'grant' ? 'grant_access' : 'revoke_access', JSON.stringify(identity)];
if (action === 'grant') args.push(JSON.stringify(role));
args.push('--server', config.stdbHost);
const result = spawnSync(process.env.SPACETIME_CLI || 'spacetime', args, { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
