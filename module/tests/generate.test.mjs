/** WHAT IT'S FOR: fail-closed tests for the approved CLI descriptor correction. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { restorePolicy } from '../generate.mjs';

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
