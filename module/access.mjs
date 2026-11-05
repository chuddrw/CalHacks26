/** WHAT IT'S FOR: owner-only membership commands using the caller's existing CLI sign-in.
 * Arguments contain public identities and roles only. This never reads or prints auth tokens.
 */
import { spawnSync } from 'node:child_process';
import { config } from '../shared/src/config.ts';
const [action, database, identity, role, ...extra] = process.argv.slice(2);
// Optional, grant only: --name <handle> [--display <Display Name>] binds the identity to an agent handle.
let handle; let display;
let optionsOk = true;
for (let at = 0; at < extra.length; at += 2) {
  const flag = extra[at]; const value = extra[at + 1];
  if (flag === '--name' && handle === undefined && value !== undefined) handle = value;
  else if (flag === '--display' && display === undefined && value !== undefined) display = value;
  else optionsOk = false;
}
if (display !== undefined && handle === undefined) optionsOk = false;
if (handle !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(handle)) optionsOk = false;
if (display !== undefined && (display.length === 0 || display.length > 80)) optionsOk = false;
if (action !== 'grant' && extra.length) optionsOk = false;
const valid = ['grant', 'revoke'].includes(action) && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(database ?? '')
  && /^(?:0x)?[0-9a-fA-F]{64}$/.test(identity ?? '') && !/^0x?0+$/.test(identity ?? '')
  && (action === 'grant' ? ['reader', 'editor'].includes(role) : role === undefined) && optionsOk;
if (!valid) {
  console.error('Usage: node module/access.mjs grant <database> <public-identity> reader|editor [--name <handle> [--display <Display Name>]]\n       node module/access.mjs revoke <database> <public-identity>');
  process.exit(1);
}
const cli = process.env.SPACETIME_CLI || 'spacetime';
function call(reducer, ...values) {
  const result = spawnSync(cli, ['call', database, reducer, ...values.map(value => JSON.stringify(value)), '--server', config.stdbHost], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}
let status = action === 'grant' ? call('grant_access', identity, role) : call('revoke_access', identity);
if (status === 0 && action === 'grant' && handle !== undefined) status = call('set_member_profile', identity, handle, display ?? handle);
process.exit(status);
