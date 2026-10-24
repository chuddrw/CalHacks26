/** WHAT IT'S FOR: fail-closed tests for the approved CLI descriptor correction. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { restorePolicy, validateBindings } from '../generate.mjs';

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
