/**
 * WHAT IT'S FOR: generate official CLI bindings while preserving the frozen camelCase SQL names.
 * SpacetimeDB 2.13's standalone extract-schema output drops CaseConversionPolicy. CLI validation
 * then defaults to SnakeCase even though the published module honors None. Restore only that
 * omitted setting in the descriptor input; never rewrite generated output.
 * Official implementation: github.com/clockworklabs/SpacetimeDB/tree/v2.13.0/crates/cli/src/schema_extract.rs
 * Naming validation: github.com/clockworklabs/SpacetimeDB/blob/v2.13.0/crates/schema/src/def/validate/v10.rs
 * CLI JSON input: github.com/clockworklabs/SpacetimeDB/blob/v2.13.0/crates/cli/src/subcommands/generate.rs
 * Usage: node module/generate.mjs. SPACETIME_CLI can point to the actual versioned CLI binary.
 * The standalone extractor is discovered beside that binary, then on PATH. If `spacetime`
 * is an updater/manager shim, set SPACETIMEDB_SCHEMA_EXTRACTOR to its active version's
 * spacetimedb-standalone binary. Neither override installs or changes global tools.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Columns } from '../shared/src/schema.ts';

const modulePath = fileURLToPath(new URL('.', import.meta.url));
const outputPath = fileURLToPath(new URL('../shared/module_bindings', import.meta.url));

/** Accept a future fixed extractor unchanged, and reject any contradictory or duplicate policy. */
export function restorePolicy(raw) {
  if (!raw?.V10 || !Array.isArray(raw.V10.sections)) throw new Error('Expected a V10 module descriptor.');
  const policies = raw.V10.sections.filter(section => Object.hasOwn(section, 'CaseConversionPolicy'));
  if (policies.length > 1 || (policies.length && JSON.stringify(policies[0].CaseConversionPolicy) !== '{"None":[]}')) {
    throw new Error('Extractor returned a conflicting or duplicate case-conversion policy.');
  }
  if (!policies.length) raw.V10.sections.push({ CaseConversionPolicy: { None: [] } });
  return raw;
}

function executable(candidate) {
  const candidates = candidate.includes(path.sep) ? [candidate] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, candidate));
  for (const file of candidates) {
    try { accessSync(file, constants.X_OK); return realpathSync(file); } catch { /* Try next PATH entry. */ }
  }
  throw new Error(`Cannot find executable ${candidate}. Set SPACETIME_CLI and SPACETIMEDB_SCHEMA_EXTRACTOR if needed.`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${path.basename(command)} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

/** Check every emitted public field against the frozen column order and descriptor types. */
export function validateBindings(raw, directory) {
  const sections = raw.V10.sections;
  const tables = sections.find(section => section.Tables)?.Tables;
  const types = sections.find(section => section.Typespace)?.Typespace?.types;
  if (!Array.isArray(tables) || !Array.isArray(types)) throw new Error('Descriptor lacks tables or types.');
  for (const [name, columns] of Object.entries(Columns)) {
    const table = tables.find(table => table.source_name === name);
    const elements = types[table?.product_type_ref]?.Product?.elements;
    if (!elements || JSON.stringify(elements.map(element => element.name.some)) !== JSON.stringify(columns)) {
      throw new Error(`Descriptor disagrees with frozen ${name} columns.`);
    }
    const source = readFileSync(path.join(directory, `${name}_table.ts`), 'utf8');
    const fields = [...source.matchAll(/^  (\w+): __t\.(\w+)\((.*)$/gm)];
    if (JSON.stringify(fields.map(field => field[1])) !== JSON.stringify(columns)) throw new Error(`Generated ${name} columns disagree.`);
    for (const [index, field] of fields.entries()) {
      const wireName = field[3].match(/\.name\("([^"]+)"\)/)?.[1] ?? field[1];
      const type = Object.keys(elements[index].algebraic_type)[0].toLowerCase();
      if (wireName !== columns[index] || field[2] !== type) throw new Error(`Generated ${name}.${field[1]} name/type disagrees with module.`);
      if (['id', 'conflictId'].includes(field[1]) && type !== 'u32') throw new Error(`Public ${name}.${field[1]} must remain a number (u32).`);
      if (['createdAt', 'resolvedAt', 'lastSnapshotAt'].includes(field[1]) && type !== 'f64') throw new Error(`Public ${name}.${field[1]} must remain number milliseconds (f64).`);
    }
  }
}

function copyGenerated(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyGenerated(source, target);
    else if (entry.isFile() && entry.name.endsWith('.ts')) copyFileSync(source, target);
  }
}

export function generateBindings() {
  const source = readFileSync(path.join(modulePath, 'src/index.ts'), 'utf8');
  if (!/CASE_CONVERSION_POLICY\s*:\s*CaseConversionPolicy\.None\b/.test(source)) {
    throw new Error('Generation correction requires module CASE_CONVERSION_POLICY: CaseConversionPolicy.None.');
  }
  const cli = executable(process.env.SPACETIME_CLI || 'spacetime');
  let extractor;
  if (process.env.SPACETIMEDB_SCHEMA_EXTRACTOR) extractor = executable(process.env.SPACETIMEDB_SCHEMA_EXTRACTOR);
  else {
    try { extractor = executable(path.join(path.dirname(cli), 'spacetimedb-standalone')); }
    catch { extractor = executable('spacetimedb-standalone'); }
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cowork-generate-'));
  try {
    run(cli, ['build', '--module-path', modulePath], modulePath);
    const raw = restorePolicy(JSON.parse(run(extractor, ['extract-schema', path.join(modulePath, 'dist/bundle.js'), '--host-type', 'js'], temporary)));
    const descriptor = path.join(temporary, 'module.json');
    writeFileSync(descriptor, JSON.stringify(raw));
    // 2.13 still resolves a default module directory for --module-def; no build occurs here.
    mkdirSync(path.join(temporary, 'spacetimedb'));
    const generated = path.join(temporary, 'bindings');
    run(cli, ['generate', '--lang', 'typescript', '--out-dir', generated, '--module-def', descriptor, '--no-config', '-y'], temporary);
    validateBindings(raw, generated);
    copyGenerated(generated, outputPath);
    console.log('Generated and verified public bindings with preserved SQL names.');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { generateBindings(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
