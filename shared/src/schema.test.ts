/** WHAT THIS FILE IS FOR: shared run/pair cache-key invariants without database or client dependencies. */
import assert from "node:assert/strict";
import test from "node:test";
import { pairKey, runKey } from "./schema.ts";

test("equivalent snapshot sets have the same run key without mutating caller ordering", () => {
  const shas = ["f00", "001", "abc"];
  const original = [...shas];
  assert.equal(runKey(shas), runKey(["abc", "f00", "001"]));
  assert.deepEqual(shas, original);
  assert.notEqual(runKey(shas), runKey(["f00", "001", "abd"]));
});

test("self and unordered teammate pairs retain distinct keys", () => {
  assert.equal(pairKey("zoe", "amy"), pairKey("amy", "zoe"));
  assert.equal(pairKey("amy", ""), "amy");
  assert.notEqual(pairKey("amy", ""), pairKey("amy", "zoe"));
  assert.notEqual(pairKey("amy", "zoe"), pairKey("amy", "zoe-2"));
});
