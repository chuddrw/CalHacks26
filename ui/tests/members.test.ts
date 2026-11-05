/** WHAT IT'S FOR: names for agents, the signed-in identity, and the Team drawer's rows. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScene } from "./fixtures.ts";
import {
  agentChip,
  agentLabel,
  displayNameOf,
  myProfile,
  normalizeMembers,
  personLabel,
  setIdentity,
  setMembers,
  type MemberProfileRow,
} from "../src/members.ts";
import { teamRows } from "../src/teamPanel.ts";
import { upper } from "../src/team.ts";
import { draftProblem } from "../src/ask.ts";

const rows: MemberProfileRow[] = [
  { identity: "ABC123", handle: "a", displayName: "Catherine", createdAt: 1 },
  { identity: "def456", handle: "b", displayName: "  ", createdAt: 2 },
];

test("a known handle shows its person's name, an unknown one falls back to the handle", () => {
  assert.equal(displayNameOf("a", rows), "Catherine");
  assert.equal(agentLabel("a", rows), "Catherine's agent");
  assert.equal(agentChip("a", rows), "Catherine's agent");
  assert.equal(personLabel("a", rows), "Catherine");
  assert.equal(agentLabel("z", rows), "z");
  assert.equal(agentChip("z", rows), "Agent Z");
  assert.equal(personLabel("z", rows), "Z");
  assert.equal(personLabel("b", rows), "B"); // a blank name is no name
});

test("the signed-in identity finds its profile, ignoring case and a 0x prefix", () => {
  assert.equal(myProfile(rows, "0xabc123")?.handle, "a");
  assert.equal(myProfile(rows, "nobody"), undefined);
  assert.equal(myProfile(rows, ""), undefined);
});

test("normalizeMembers accepts SDK-like rows and skips bad ones", () => {
  const out = normalizeMembers([
    { identity: { toHexString: () => "0xAA" }, handle: "a", displayName: "Cat", createdAt: 5n },
    { identity: "bb", handle: "b", displayName: "Ben", createdAt: 7 },
    { handle: "x" },
    null,
  ]);
  assert.deepEqual(out.map((m) => [m.identity, m.handle, m.createdAt]), [["aa", "a", 5], ["bb", "b", 7]]);
});

test("upper() (used in every 'X's human' line) shows the name once the store has it", () => {
  setMembers([]);
  assert.equal(upper("a"), "A");
  setMembers(rows);
  assert.equal(upper("a"), "Catherine");
  setMembers([]);
});

test("the Team rows list named people first, mark me, and include unnamed agents", () => {
  const t = buildScene("working", 1_000_000);
  setIdentity("abc123");
  const list = teamRows(t, rows, "abc123");
  assert.equal(list[0]!.handle, "a");
  assert.equal(list[0]!.you, true);
  assert.equal(list[0]!.name, "Catherine");
  assert.ok(list.some((r) => r.handle === "c" && r.name === ""));
  assert.equal(new Set(list.map((r) => r.handle)).size, list.length);
  setIdentity("");
});

test("a draft needs no agent any more", () => {
  assert.equal(draftProblem({ text: "x", setup: { mode: "none" } }), "");
});
