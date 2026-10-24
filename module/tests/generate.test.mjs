/** WHAT IT'S FOR: fail-closed tests for the approved CLI descriptor correction. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readInterfaceContract, restorePolicy, validateBindings } from '../generate.mjs';

function bindingFixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cowork-binding-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const contract = readInterfaceContract();
  function builder(type) {
    if (type.Array) return `__t.array(${builder(type.Array)})`;
    return `__t.${{ String: 'string', Bool: 'bool', U32: 'u32', F64: 'f64' }[Object.keys(type)[0]]}()`;
  }
  const types = [], views = [], keys = [];
  for (const [name, fields] of Object.entries(contract.rows)) {
    views.push({ source_name: name, is_public: true, is_anonymous: false, return_type: { Array: { Ref: types.length } } });
    types.push({ Product: { elements: fields.map(field => ({ name: { some: field.name }, algebraic_type: field.type })) } });
    keys.push({ view_source_name: name, columns: [fields[0].name] });
    writeFileSync(path.join(directory, `${name}_table.ts`), `export default __t.row({\n${fields.map((field, index) => `  ${field.name}: ${builder(field.type)}${index ? '' : '.primaryKey()'},`).join('\n')}\n});\n`);
  }
  const reducers = Object.entries(contract.reducers).map(([name, fields]) => {
    writeFileSync(path.join(directory, `${name}_reducer.ts`), `export default {\n${fields.map(field => `  ${field.name}: ${builder(field.type)},`).join('\n')}\n};\n`);
    return { source_name: name, visibility: { ClientCallable: [] }, params: { elements: fields.map(field => ({ name: { some: field.name }, algebraic_type: field.type })) } };
  });
  return { directory, types, reducers, raw: { V10: { sections: [{ Tables: [] }, { Typespace: { types } }, { Views: views }, { ViewPrimaryKeys: keys }, { Reducers: reducers }] } } };
}

test('restores only the omitted None policy and leaves all existing descriptor data intact', () => {
  const section = { Typespace: { types: [] } };
  const raw = { V10: { sections: [section] } };
  assert.equal(restorePolicy(raw), raw);
  assert.deepEqual(raw.V10.sections, [section, { CaseConversionPolicy: { None: [] } }]);
});

test('accepts a fixed extractor policy without duplication', () => {
  const raw = { V10: { sections: [{ CaseConversionPolicy: { None: [] } }] } };
  const before = JSON.stringify(raw);
  restorePolicy(raw);
  assert.equal(JSON.stringify(raw), before);
});

test('rejects conflicting, duplicate, malformed and unsupported descriptors', () => {
  for (const raw of [
    { V10: { sections: [{ CaseConversionPolicy: { SnakeCase: [] } }] } },
    { V10: { sections: [{ CaseConversionPolicy: { None: [] } }, { CaseConversionPolicy: { None: [] } }] } },
    { V10: { sections: [{ CaseConversionPolicy: { None: null } }] } },
    { V9: {} }, null,
  ]) assert.throws(() => restorePolicy(raw));
});

test('rejects generation that would expose a backing table publicly', () => {
  const raw = {V10:{sections:[{Tables:[{table_access:{Public:[]}}]}, {Typespace:{types:[]}}, {Views:[]}, {ViewPrimaryKeys:[]}]}};
  assert.throws(() => validateBindings(raw, '/unused'), /must all be private/);
});

test('rejects anonymous views for the signed-in query contract', () => {
  const raw = {V10:{sections:[{Tables:[]}, {Typespace:{types:[]}}, {Views:[{source_name:'agent',is_public:true,is_anonymous:true}]}, {ViewPrimaryKeys:[]}]}};
  assert.throws(() => validateBindings(raw, '/unused'), /authenticated public view/);
});

test('derives recursive row types and guarded reducer argument order from the actual shared interfaces', () => {
  const contract = readInterfaceContract();
  assert.deepEqual(contract.rows.agent.find(field => field.name === 'files').type, { Array: { String: [] } });
  assert.deepEqual(contract.reducers.mark_delivered, [{ name: 'inboxIds', type: { Array: { U32: [] } } }]);
  assert.deepEqual(contract.reducers.set_explanation_if_current.map(field => field.name), ['conflictId', 'expectedRunKey', 'expectedError', 'expectedFixer', 'explanation']);
  assert.deepEqual(contract.reducers.resolve_conflict_if_current.map(field => field.name), ['conflictId', 'expectedRunKey', 'expectedError', 'expectedFixer', 'verifiedRunKey', 'verifiedFact']);
});

test('accepts a complete shared-interface descriptor and generated builders', t => {
  const f = bindingFixture(t);
  assert.doesNotThrow(() => validateBindings(f.raw, f.directory));
});

test('rejects a descriptor array whose element type changed despite the same outer array type', t => {
  const f = bindingFixture(t);
  f.types[0].Product.elements.find(field => field.name.some === 'files').algebraic_type = { Array: { U32: [] } };
  assert.throws(() => validateBindings(f.raw, f.directory), /Descriptor agent names, order or types/);
});

test('rejects a generated array element type that disagrees with the descriptor and shared row', t => {
  const f = bindingFixture(t);
  const file = path.join(f.directory, 'agent_table.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('__t.array(__t.string())', '__t.array(__t.bool())'));
  assert.throws(() => validateBindings(f.raw, f.directory), /Generated agent names, order or types/);
});

test('rejects a generated client property rename hidden behind a matching wire-name override', t => {
  const f = bindingFixture(t);
  const file = path.join(f.directory, 'agent_table.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('  lastSnapshotAt: __t.f64(),', '  last_snapshot_at: __t.f64().name("lastSnapshotAt"),'));
  assert.throws(() => validateBindings(f.raw, f.directory), /Generated client field last_snapshot_at disagrees/);
});

test('rejects reordered reducer arguments even when both arguments are strings', t => {
  const f = bindingFixture(t);
  const fields = f.reducers.find(reducer => reducer.source_name === 'post_snapshot').params.elements;
  [fields[1], fields[2]] = [fields[2], fields[1]];
  assert.throws(() => validateBindings(f.raw, f.directory), /Reducer post_snapshot names, order or types/);
});

test('rejects generated reducer argument order drift independently of the module descriptor', t => {
  const f = bindingFixture(t);
  const file = path.join(f.directory, 'post_snapshot_reducer.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('  sha: __t.string(),\n  baseSha: __t.string(),', '  baseSha: __t.string(),\n  sha: __t.string(),'));
  assert.throws(() => validateBindings(f.raw, f.directory), /Generated reducer post_snapshot names, order or types/);
});

test('rejects reducer argument array element drift and extra client-callable endpoints', t => {
  const f = bindingFixture(t);
  const field = f.reducers.find(reducer => reducer.source_name === 'mark_delivered').params.elements[0];
  field.algebraic_type = { Array: { String: [] } };
  assert.throws(() => validateBindings(f.raw, f.directory), /Reducer mark_delivered names, order or types/);
  field.algebraic_type = { Array: { U32: [] } };
  f.reducers.push({ source_name: 'unreviewed_reset', visibility: { ClientCallable: [] }, params: { elements: [] } });
  assert.throws(() => validateBindings(f.raw, f.directory), /Client-callable reducers disagree/);
});

test('symlink generator invocation executes validation instead of silently returning success', t => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cowork-generator-entrypoint-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const alias = path.join(temporary, 'generate.mjs');
  symlinkSync(fileURLToPath(new URL('../generate.mjs', import.meta.url)), alias);
  const missingCli = path.join(temporary, 'no-such-spacetime');
  const result = spawnSync(process.execPath, [alias], {
    encoding: 'utf8', timeout: 10000, env: { PATH: '', SPACETIME_CLI: missingCli },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot find executable/);
  assert.match(result.stderr, /no-such-spacetime/);
});

test('library import from eval tolerates a non-file argv without executing generation', () => {
  const source = `await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../generate.mjs', import.meta.url))).href)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, 'not-a-real-entrypoint'], {
    encoding: 'utf8', timeout: 10000, env: { PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
