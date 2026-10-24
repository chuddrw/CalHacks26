/** WHAT IT'S FOR: Part C module-management CLI boundary tests against byte-identical fixture sources.
 * Every child CLI/generator is fake; environment loading uses a temporary project and synthetic settings.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageChildEnvironment, recordCoverageCopy } from './coverage-source.mjs';

const manageSource = fileURLToPath(new URL('../manage.mjs', import.meta.url));
const configSource = fileURLToPath(new URL('../../shared/src/config.ts', import.meta.url));
function fixture({ envFile = 'STDB_DB=fixture-database\nSTDB_HOST=http://127.0.0.1:1\n' } = {}) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cowork-manage-cli-')));
  const project = path.join(directory, 'project');
  const modulePath = path.join(project, 'module');
  const configPath = path.join(project, 'shared', 'src');
  const bin = path.join(directory, 'bin');
  const cwd = path.join(directory, 'unrelated-working-directory');
  for (const target of [modulePath, configPath, bin, cwd]) mkdirSync(target, { recursive: true });
  writeFileSync(path.join(project, 'package.json'), '{"type":"module"}\n');
  if (envFile !== null) writeFileSync(path.join(project, '.env'), envFile);
  const command = path.join(modulePath, 'manage.mjs');
  const copiedConfig = path.join(configPath, 'config.ts');
  copyFileSync(manageSource, command);
  copyFileSync(configSource, copiedConfig);
  recordCoverageCopy(manageSource, command);
  recordCoverageCopy(configSource, copiedConfig);
  const capture = path.join(directory, 'arguments.json');
  const cli = path.join(bin, 'fake-spacetime.cjs');
  const fakeCli = `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.COWORK_MANAGE_CAPTURE,JSON.stringify({kind:'cli',args:process.argv.slice(2),cwd:process.cwd()}));if(process.env.COWORK_MANAGE_SIGNAL)process.kill(process.pid,'SIGTERM');else process.exit(Number(process.env.COWORK_MANAGE_EXIT||0));\n`;
  writeFileSync(cli, fakeCli, { mode: 0o700 });
  writeFileSync(path.join(bin, 'spacetime'), fakeCli, { mode: 0o700 });
  // generate must dispatch to the module's own entry point using Node, never the spacetime binary.
  writeFileSync(path.join(modulePath, 'generate.mjs'), `import{writeFileSync}from'node:fs';writeFileSync(process.env.COWORK_MANAGE_CAPTURE,JSON.stringify({kind:'generate',args:process.argv.slice(2),execPath:process.execPath,cwd:process.cwd()}));process.exit(Number(process.env.COWORK_MANAGE_EXIT||0));\n`);
  function run(args, { env = {}, executable = cli, exit = '0', signal = false } = {}) {
    return spawnSync(process.execPath, [command, ...args], {
      cwd, encoding: 'utf8', timeout: 5000,
      env: {
        PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
        ...coverageChildEnvironment(),
        ...(executable === null ? {} : { SPACETIME_CLI: executable }),
        COWORK_MANAGE_CAPTURE: capture, COWORK_MANAGE_EXIT: exit,
        ...(signal ? { COWORK_MANAGE_SIGNAL: '1' } : {}),
        ...env,
      },
    });
  }
  return { directory, modulePath, cwd, capture, run, recorded: () => JSON.parse(readFileSync(capture, 'utf8')) };
}

function withFixture(body, options) {
  const f = fixture(options);
  try { body(f); } finally { rmSync(f.directory, { recursive: true, force: true }); }
}

test('publish forwards public process settings and the actual module path as distinct arguments', () => {
  withFixture(f => {
    const result = f.run(['publish'], { env: { STDB_DB: 'approved-process-db', STDB_HOST: 'http://127.0.0.1:2' } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.recorded(), { kind: 'cli', args: ['publish', 'approved-process-db', '--module-path', f.modulePath + path.sep, '--server', 'http://127.0.0.1:2'], cwd: f.cwd });
  });
});

test('logs finds fixture .env relative to the copied repository despite an unrelated cwd', () => {
  withFixture(f => {
    const result = f.run(['logs']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.recorded(), { kind: 'cli', args: ['logs', 'fixture-database', '--server', 'http://127.0.0.1:1'], cwd: f.cwd });
  });
});

test('generate runs its local entry point under the current Node executable without requiring a database', () => {
  withFixture(f => {
    const result = f.run(['generate'], { executable: path.join(f.directory, 'must-not-run') });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.recorded(), { kind: 'generate', args: [], execPath: process.execPath, cwd: f.cwd });
  }, { envFile: null });
});

test('omitting an explicit CLI selects only the recording spacetime executable on fixture PATH', () => {
  withFixture(f => {
    const result = f.run(['logs'], { executable: null });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.recorded().args, ['logs', 'fixture-database', '--server', 'http://127.0.0.1:1']);
  });
});

for (const action of ['publish', 'logs']) {
  test(`${action} rejects a missing database before launching any child`, () => {
    withFixture(f => {
      const result = f.run([action]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Set the public STDB_DB/);
      assert.equal(existsSync(f.capture), false);
    }, { envFile: null });
  });
}

for (const database of ['', 'UpperCase', '--server', 'has_underscore', 'has space', 'trailing-', 'double--dash', 'name;touch-file']) {
  test(`publish rejects invalid database ${JSON.stringify(database)} without a subprocess`, () => {
    withFixture(f => {
      const result = f.run(['publish'], { env: { STDB_DB: database } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Set the public STDB_DB/);
      assert.equal(existsSync(f.capture), false);
    });
  });
}

for (const args of [[], ['unknown']]) {
  test(`management CLI rejects ${args.length ? 'unknown' : 'missing'} action with usage`, () => {
    withFixture(f => {
      const result = f.run(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Usage: node module\/manage.mjs generate\|publish\|logs/);
      assert.equal(existsSync(f.capture), false);
    });
  });
}

for (const action of ['publish', 'logs', 'generate']) {
  test(`${action} propagates a failing child exit status`, () => {
    withFixture(f => {
      const result = f.run([action], { exit: '7' });
      assert.equal(result.status, 7, result.stderr);
      assert.equal(f.recorded().kind, action === 'generate' ? 'generate' : 'cli');
    });
  });
}

test('missing executable reports ENOENT and exits unsuccessfully rather than claiming success', () => {
  withFixture(f => {
    const result = f.run(['logs'], { executable: path.join(f.directory, 'nonexistent-cli') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
    assert.equal(existsSync(f.capture), false);
  });
});

test('a child terminated by signal becomes an unsuccessful management command', () => {
  withFixture(f => {
    const result = f.run(['logs'], { signal: true });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(f.recorded().kind, 'cli');
  });
});
