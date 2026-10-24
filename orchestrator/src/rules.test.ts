/**
 * WHAT IT'S FOR: the contract rule and the import scan it relies on (npm run test:orchestrator).
 * Pure functions plus a throwaway folder; no database, git or model.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseOwners } from "../../shared/src/owners.ts";
import { importIndex, scanDiff } from "./imports.ts";
import { applyContractRule, type DraftPlan } from "./rules.ts";

const owners = parseOwners(JSON.stringify({
  shared: ["src/contracts/"],
  owners: [
    { agent: "a", human: "Ana", feature: "Users and logins", paths: ["src/users/"] },
    { agent: "b", human: "Ben", feature: "Session timeout", paths: ["src/sessions/"] },
    { agent: "c", human: "Cat", feature: "Login statistics", paths: ["src/analytics/"] },
  ],
}));
const plan = (tasks: DraftPlan["tasks"], reviews: DraftPlan["reviews"] = []): DraftPlan => ({ summary: "s", tasks, reviews, conflicts: [] });
const contract = { agent: "a", title: "lastLogin in ms", details: "", files: ["src/contracts/user.ts", "src/users/user.ts"], major: false };

test("a shared contract change is major, and the owners of its importers review it (not the requester)", () => {
  const importers = (file: string) => (file === "src/contracts/user.ts" ? ["src/users/user.ts", "src/sessions/session.ts", "src/sessions/idle.ts"] : []);
  const { plan: result, notes } = applyContractRule({ plan: plan([contract]), owners, requester: "a", importers });
  assert.equal(result.tasks[0]!.major, true);
  assert.deepEqual(result.reviews.map((review) => review.reviewer), ["b"]);
  assert.match(result.reviews[0]!.summary, /src\/sessions\/session\.ts imports src\/contracts\/user\.ts/);
  assert.ok(notes.some((note) => note.includes("major change")));
  assert.ok(notes.some((note) => note.startsWith("Rule: Ben (b) reviews first")));
});

test("editing another owner's file is major and that owner reviews; own files alone are not", () => {
  const foreign = { agent: "a", title: "patch sessions", details: "", files: ["src/sessions/session.ts"], major: false };
  const own = { agent: "c", title: "stats", details: "", files: ["src/analytics/activity.ts"], major: false };
  const { plan: result } = applyContractRule({ plan: plan([foreign, own]), owners, requester: "c", importers: () => [] });
  assert.deepEqual(result.tasks.map((task) => task.major), [true, false]);
  assert.deepEqual(result.reviews.map((review) => review.reviewer), ["b"]);
});

test("Droid's own reviews are kept, except the requester's, unknown agents and duplicates", () => {
  const reviews = [
    { reviewer: "a", summary: "the requester" },
    { reviewer: "c", summary: "stats read lastLogin" },
    { reviewer: "zed", summary: "not an owner" },
    { reviewer: "c", summary: "duplicate" },
  ];
  const { plan: result } = applyContractRule({ plan: plan([contract], reviews), owners, requester: "a", importers: () => [] });
  assert.deepEqual(result.reviews, [{ reviewer: "c", summary: "stats read lastLogin" }]);
  assert.equal(result.tasks[0]!.major, true);
});

test("the import scan finds importers on main and in a snapshot's added lines", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cowork-imports-"));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    };
    write("src/contracts/user.ts", "export interface User { lastLogin: number }\n");
    write("src/users/user.ts", 'import type { User } from "../contracts/user";\n');
    write("src/sessions/session.ts", "import type { User } from '../contracts/user.ts';\n");
    write("src/api/routes.ts", 'import { getUser } from "../users/user";\n');
    write("node_modules/x/index.ts", 'import "../../src/contracts/user";\n');
    const diff = [
      "diff --git a/src/sessions/idle.ts b/src/sessions/idle.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/sessions/idle.ts",
      "@@ -0,0 +1,2 @@",
      '+import type { User } from "../contracts/user";',
      "+export const x = 1;",
    ].join("\n");
    assert.deepEqual([...scanDiff(diff).keys()], ["src/sessions/idle.ts"]);
    const importers = importIndex(root, [diff]);
    assert.deepEqual(importers("src/contracts/user.ts"), ["src/sessions/idle.ts", "src/sessions/session.ts", "src/users/user.ts"]);
    assert.deepEqual(importers("src/users/user.ts"), ["src/api/routes.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
