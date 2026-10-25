#!/usr/bin/env node
// Local command entry point for projects using the Orkio tool.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const [command, ...args] = process.argv.slice(2);
const scripts = {
  install: 'hooks/src/install.ts',
  doctor: 'scripts/doctor.ts',
  'full-stack': 'scripts/full-stack.ts',
};

if (!command || command === '--help' || command === 'help') {
  console.log(`Orkio — coordinate coding agents across a project

Usage:
  orkio install --name <your-name>   Connect the current project to Orkio
  orkio doctor                     Check tool configuration and database access
  orkio full-stack                 Retrieve the team's integrated project

Requires Node 24+. Configure the tool's .env in ${root}.
Install requires a separate project Git repository. Existing npm commands
for the dashboard, database, and orchestrator run from the Orkio folder.`);
} else if (Object.hasOwn(scripts, command)) {
  const forwarded = [...args];
  if (command !== 'doctor' && !args.some(arg => arg === '--demo' || arg.startsWith('--demo='))) {
    forwarded.push('--demo', process.cwd());
  }
  const result = spawnSync(process.execPath, [path.join(root, scripts[command]), ...forwarded], {
    stdio: 'inherit',
    cwd: root,
    env: process.env,
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else {
  console.error(`Unknown command: ${command}. Run orkio --help.`);
  process.exitCode = 1;
}
