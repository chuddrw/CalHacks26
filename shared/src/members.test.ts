/** WHAT THIS FILE IS FOR: the pure helpers that turn a typed name into an agent handle and normalise identities. */
import assert from "node:assert/strict";
import test from "node:test";
import { freeHandle, grantCommand, normalizeIdentity, slugHandle } from "./members.ts";

test("a typed name becomes a lowercase handle", () => {
  assert.equal(slugHandle("Catherine"), "catherine");
  assert.equal(slugHandle("  Ana María Ruiz "), "ana-maria-ruiz");
  assert.equal(slugHandle("###"), "");
});

test("a taken handle gets the next free number", () => {
  assert.equal(freeHandle("sam", ["a", "b"]), "sam");
  assert.equal(freeHandle("sam", ["sam"]), "sam-2");
  assert.equal(freeHandle("sam", ["sam", "sam-2"]), "sam-3");
});

test("identities compare equal however the server prints them", () => {
  const hex = "ab".repeat(32);
  assert.equal(normalizeIdentity(`0x${hex.toUpperCase()}`), hex);
  assert.equal(normalizeIdentity({ __identity__: `0x${hex}` }), hex);
  assert.equal(normalizeIdentity([hex]), hex);
});

test("the owner's command carries only the public identity, handle and display name", () => {
  const hex = "cd".repeat(32);
  const command = grantCommand(hex, "catherine", 'Cath "C"');
  assert.match(command, new RegExp(`grant \\S+ ${hex} editor --name catherine --display "Cath C"$`));
});
