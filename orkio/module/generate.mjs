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
import { parse } from '@babel/parser';
import { Columns } from '../shared/src/schema.ts';

const modulePath = fileURLToPath(new URL('.', import.meta.url));
const outputPath = fileURLToPath(new URL('../shared/module_bindings', import.meta.url));

/** Parse TypeScript without evaluating module code or relying on version-specific compiler APIs. */
function parseSourceFile(file) {
  return parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'] }).program;
}

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

/** Read the shared interfaces directly, avoiding a second registry of row/reducer signatures.
 * The approved wire convention is u32 IDs and f64 millisecond numbers; aliases and string
 * unions retain their primitive wire types. Unsupported interface syntax fails closed.
 */
export function readInterfaceContract() {
  const file = fileURLToPath(new URL('../shared/src/schema.ts', import.meta.url));
  const source = parseSourceFile(file);
  const declarations = new Map(source.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
    .filter(node => node?.type === 'TSTypeAliasDeclaration' || node?.type === 'TSInterfaceDeclaration')
    .map(node => [node.id.name, node]));
  const fieldName = node => {
    if (node?.type === 'Identifier') return node.name;
    if (node?.type === 'StringLiteral') return node.value;
    throw new Error('Shared interface requires literal field names.');
  };
  function wireType(node, name, seen = new Set()) {
    if (node?.type === 'TSStringKeyword') return { String: [] };
    if (node?.type === 'TSBooleanKeyword') return { Bool: [] };
    if (node?.type === 'TSNumberKeyword') return /(?:^id$|Ids?$)/.test(name) ? { U32: [] } : { F64: [] };
    if (node?.type === 'TSArrayType') return { Array: wireType(node.elementType, name, seen) };
    if (node?.type === 'TSLiteralType' && node.literal.type === 'StringLiteral') return { String: [] };
    if (node?.type === 'TSParenthesizedType') return wireType(node.typeAnnotation, name, seen);
    if (node?.type === 'TSUnionType') {
      const choices = node.types.map(type => wireType(type, name, seen));
      if (choices.every(type => JSON.stringify(type) === JSON.stringify(choices[0]))) return choices[0];
    }
    if (node?.type === 'TSTypeReference' && node.typeName.type === 'Identifier') {
      const reference = node.typeName.name;
      if (reference === 'Exclude' && node.typeParameters?.params.length === 2) return wireType(node.typeParameters.params[0], name, seen);
      const declaration = declarations.get(reference);
      if (declaration?.type === 'TSTypeAliasDeclaration' && !seen.has(reference)) {
        return wireType(declaration.typeAnnotation, name, new Set([...seen, reference]));
      }
    }
    throw new Error(`Unsupported shared wire type for ${name}: ${node?.type ?? '(missing)'}`);
  }
  function members(name) {
    const declaration = declarations.get(name);
    if (declaration?.type !== 'TSInterfaceDeclaration' || declaration.extends?.length) throw new Error(`Missing or unsupported shared ${name} interface.`);
    return declaration.body.body.map(member => {
      if (member.type !== 'TSPropertySignature' || member.optional || member.computed || !member.typeAnnotation) throw new Error(`Unsupported ${name} property.`);
      return { name: fieldName(member.key), type: member.typeAnnotation.typeAnnotation };
    });
  }
  const rows = Object.fromEntries(members('TableRows').map(member => {
    if (member.type.type !== 'TSTypeReference' || member.type.typeName.type !== 'Identifier') throw new Error('TableRows must reference row interfaces.');
    return [member.name, members(member.type.typeName.name).map(field => ({ name: field.name, type: wireType(field.type, field.name) }))];
  }));
  const reducers = Object.fromEntries(members('ReducerArgs').map(member => {
    if (member.type.type !== 'TSTupleType') throw new Error(`ReducerArgs.${member.name} must be a named tuple.`);
    return [member.name, member.type.elementTypes.map(element => {
      if (element.type !== 'TSNamedTupleMember' || element.optional) throw new Error(`Unsupported ${member.name} argument.`);
      const name = fieldName(element.label);
      return { name, type: wireType(element.elementType, name) };
    })];
  }));
  return { rows, reducers };
}

/** Resolve descriptor aliases recursively so an array's element type is part of the contract. */
function descriptorType(type, types, seen = new Set()) {
  const keys = type && typeof type === 'object' ? Object.keys(type) : [];
  if (keys.length !== 1) throw new Error('Malformed descriptor wire type.');
  const kind = keys[0];
  if (kind === 'Ref' && Number.isInteger(type.Ref) && !seen.has(type.Ref)) {
    return descriptorType(types[type.Ref], types, new Set([...seen, type.Ref]));
  }
  if (kind === 'Array') return { Array: descriptorType(type.Array, types, seen) };
  if (['String', 'Bool', 'U32', 'F64'].includes(kind) && Array.isArray(type[kind]) && !type[kind].length) return { [kind]: [] };
  throw new Error(`Unsupported descriptor wire type: ${kind}`);
}

/** Parse official generated builders without executing generated code. */
function generatedFields(file) {
  const source = parseSourceFile(file);
  let expression = source.body.find(node => node.type === 'ExportDefaultDeclaration')?.declaration;
  if (expression?.type === 'CallExpression' && expression.callee.type === 'MemberExpression'
      && expression.callee.object.name === '__t' && expression.callee.property.name === 'row') expression = expression.arguments[0];
  if (expression?.type !== 'ObjectExpression') throw new Error(`Unsupported generated fields in ${path.basename(file)}.`);
  function builder(node) {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed) throw new Error('Unsupported generated type builder.');
    const method = node.callee.property.name;
    if (node.callee.object.type === 'Identifier' && node.callee.object.name === '__t') {
      if (method === 'array' && node.arguments.length === 1) return { type: { Array: builder(node.arguments[0]).type } };
      const kind = { string: 'String', bool: 'Bool', u32: 'U32', f64: 'F64' }[method];
      if (kind && !node.arguments.length) return { type: { [kind]: [] } };
    } else if (['name', 'primaryKey', 'autoInc', 'index', 'default', 'unique'].includes(method)) {
      const result = builder(node.callee.object);
      if (method === 'name') {
        if (node.arguments.length !== 1 || node.arguments[0].type !== 'StringLiteral') throw new Error('Unsupported generated column name.');
        result.name = node.arguments[0].value;
      }
      return result;
    }
    throw new Error(`Unsupported generated type builder: ${method}`);
  }
  return expression.properties.map(property => {
    if (property.type !== 'ObjectProperty' || property.computed || !['Identifier', 'StringLiteral'].includes(property.key.type)) throw new Error('Unsupported generated field.');
    const result = builder(property.value);
    const name = property.key.name ?? property.key.value;
    if (result.name !== undefined && result.name !== name) throw new Error(`Generated client field ${name} disagrees with its wire name.`);
    return { name, type: result.type };
  });
}

function checkFields(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} names, order or types disagree with shared/src/schema.ts.`);
}

/** Check authenticated views and client-callable reducer arguments against the shared interfaces. */
export function validateBindings(raw, directory) {
  const sections = raw.V10.sections;
  const tables = sections.find(section => section.Tables)?.Tables;
  const types = sections.find(section => section.Typespace)?.Typespace?.types;
  const views = sections.find(section => section.Views)?.Views;
  const keys = sections.find(section => section.ViewPrimaryKeys)?.ViewPrimaryKeys;
  if (!Array.isArray(tables) || !Array.isArray(types) || !Array.isArray(views) || !Array.isArray(keys)) {
    throw new Error('Descriptor lacks private tables, authenticated views or primary keys.');
  }
  if (tables.some(table => !Object.hasOwn(table.table_access, 'Private'))) {
    throw new Error('Backing tables must all be private.');
  }
  const contract = readInterfaceContract();
  for (const [name, columns] of Object.entries(Columns)) {
    const view = views.find(view => view.source_name === name);
    if (!view?.is_public || view.is_anonymous) throw new Error(`${name} must be an authenticated public view.`);
    if (!keys.some(key => key.view_source_name === name && JSON.stringify(key.columns) === JSON.stringify([columns[0]]))) {
      throw new Error(`${name} must preserve its original primary key.`);
    }
    const elements = types[view.return_type?.Array?.Ref]?.Product?.elements;
    if (!elements || JSON.stringify(elements.map(element => element.name.some)) !== JSON.stringify(columns)) {
      throw new Error(`Descriptor disagrees with frozen ${name} columns.`);
    }
    checkFields(elements.map(element => ({ name: element.name.some, type: descriptorType(element.algebraic_type, types) })), contract.rows[name], `Descriptor ${name}`);
    checkFields(generatedFields(path.join(directory, `${name}_table.ts`)), contract.rows[name], `Generated ${name}`);
  }
  if (JSON.stringify(Object.keys(contract.rows).sort()) !== JSON.stringify(Object.keys(Columns).sort())) throw new Error('Columns and TableRows query names disagree.');
  const reducers = sections.find(section => section.Reducers)?.Reducers;
  if (!Array.isArray(reducers)) throw new Error('Descriptor lacks reducer definitions.');
  const callable = reducers.filter(reducer => Object.hasOwn(reducer.visibility ?? {}, 'ClientCallable'));
  if (JSON.stringify(callable.map(reducer => reducer.source_name).sort()) !== JSON.stringify(Object.keys(contract.reducers).sort())) throw new Error('Client-callable reducers disagree with ReducerArgs.');
  for (const reducer of callable) {
    const expected = contract.reducers[reducer.source_name];
    const fields = reducer.params?.elements;
    if (!Array.isArray(fields)) throw new Error(`Malformed ${reducer.source_name} arguments.`);
    checkFields(fields.map(field => ({ name: field.name?.some, type: descriptorType(field.algebraic_type, types) })), expected, `Reducer ${reducer.source_name}`);
    checkFields(generatedFields(path.join(directory, `${reducer.source_name}_reducer.ts`)), expected, `Generated reducer ${reducer.source_name}`);
  }
}

function copyGenerated(from, to) {
  mkdirSync(to, { recursive: true });
  // Remove only stale CLI-generated .ts artifacts; retain README and any non-generated files.
  for (const entry of readdirSync(to, { withFileTypes: true })) {
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      const source = path.join(from, entry.name);
      if (!readdirSync(from).includes(entry.name)) continue;
      copyGenerated(source, target);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !readdirSync(from).includes(entry.name)
      && readFileSync(target, 'utf8').startsWith('// THIS FILE IS AUTOMATICALLY GENERATED BY SPACETIMEDB.')) {
      rmSync(target);
    }
  }
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

function invokedDirectly() {
  // Library imports from eval/stdin do not necessarily have a filesystem argv[1].
  try { return Boolean(process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href); }
  catch { return false; }
}

if (invokedDirectly()) {
  try { generateBindings(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
