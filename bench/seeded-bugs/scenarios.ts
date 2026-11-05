/**
 * bench/seeded-bugs/scenarios.ts
 *
 * WHAT IT'S FOR: seeded integration bugs on a copy of demo-app/. Each scenario is two agents'
 * independent edits (each green alone) plus a hidden test that is the ground truth for "the
 * integrated result works". A scenario is a real bug when the hidden test fails on the merged tree.
 * The hidden test is never visible to the checks; only the oracle step adds it.
 *
 * An edit is { file, from, to } (replace one exact string, which must occur once) or
 * { file, create } (write a new file). Baseline: lastLogin is epoch seconds, default timeout 30 min.
 */
export type Edit = { file: string; from: string; to: string } | { file: string; create: string };

export interface Scenario {
  id: string;
  kind: string;
  description: string;
  agentA: Edit[];
  agentB: Edit[];
  /** Vitest file added only for the oracle run. */
  hidden: { file: string; content: string };
  /** What the scenario is designed to show (checked by the tests, so a drift is noticed). */
  expect: { mergeClean: boolean; bug: boolean; visibleChecksCatch: boolean };
}

const HEAD = `import { expect, it } from "vitest";\n`;

export const scenarios: Scenario[] = [
  {
    id: "units-ms",
    kind: "units change",
    description: "A moves lastLogin to milliseconds and updates every caller it can see; B adds idle.ts that still assumes seconds.",
    agentA: [
      { file: "src/users/user.ts", from: "lastLogin: Math.floor(at.getTime() / 1000) }", to: "lastLogin: at.getTime() }" },
      { file: "src/users/user.ts", from: "user.lastLogin = Math.floor(at.getTime() / 1000);", to: "user.lastLogin = at.getTime();" },
      { file: "src/users/user.test.ts", from: "creates users with epoch seconds", to: "creates users with epoch milliseconds" },
      { file: "src/users/user.test.ts", from: "createUser(\"1\", \"Ada\", new Date(1_800_000_000_000)).lastLogin).toBe(1_800_000_000)", to: "createUser(\"1\", \"Ada\", new Date(1_800_000_000_000)).lastLogin).toBe(1_800_000_000_000)" },
      { file: "src/users/user.test.ts", from: "expect(user.lastLogin).toBe(1_800_000_000);\n  });\n});", to: "expect(user.lastLogin).toBe(1_800_000_000_000);\n  });\n});" },
      { file: "src/sessions/session.ts", from: "(now.getTime() / 1000 - user.lastLogin) / 60", to: "(now.getTime() - user.lastLogin) / 60_000" },
      { file: "src/analytics/activity.ts", from: "user.lastLogin >= since.getTime() / 1000", to: "user.lastLogin >= since.getTime()" },
      { file: "src/api/routes.ts", from: "user.lastLogin * 1000", to: "user.lastLogin" },
    ],
    agentB: [
      { file: "src/sessions/idle.ts", create: `import type { User } from "../contracts/user";\n\nexport function idleSeconds(user: User, now: Date): number {\n  return Math.floor(now.getTime() / 1000) - user.lastLogin;\n}\n` },
      { file: "src/sessions/idle.test.ts", create: `${HEAD}import { createUser } from "../users/user";\nimport { idleSeconds } from "./idle";\n\nit("measures idle seconds", () => {\n  const at = new Date("2026-10-24T12:00:00Z");\n  expect(idleSeconds(createUser("1", "Ada", at), new Date(at.getTime() + 31_000))).toBe(31);\n});\n` },
    ],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { createUser } from "./users/user";\nimport { idleSeconds } from "./sessions/idle";\n\nit("idle time is right after the unit change", () => {\n  const at = new Date("2026-10-24T12:00:00Z");\n  expect(idleSeconds(createUser("1", "Ada", at), new Date(at.getTime() + 31_000))).toBe(31);\n});\n` },
    expect: { mergeClean: true, bug: true, visibleChecksCatch: true },
  },
  {
    id: "rename-field",
    kind: "renamed field",
    description: "A renames User.lastLogin to lastLoginAt everywhere it can see; B adds a new file that reads user.lastLogin.",
    agentA: [
      { file: "src/contracts/user.ts", from: "lastLogin: number;", to: "lastLoginAt: number;" },
      { file: "src/users/user.ts", from: "return { id, name, lastLogin:", to: "return { id, name, lastLoginAt:" },
      { file: "src/users/user.ts", from: "user.lastLogin = ", to: "user.lastLoginAt = " },
      { file: "src/users/user.test.ts", from: "createUser(\"1\", \"Ada\", new Date(1_800_000_000_000)).lastLogin", to: "createUser(\"1\", \"Ada\", new Date(1_800_000_000_000)).lastLoginAt" },
      { file: "src/users/user.test.ts", from: "expect(user.lastLogin)", to: "expect(user.lastLoginAt)" },
      { file: "src/sessions/session.ts", from: "user.lastLogin", to: "user.lastLoginAt" },
      { file: "src/analytics/activity.ts", from: "user.lastLogin >=", to: "user.lastLoginAt >=" },
      { file: "src/api/routes.ts", from: "user.lastLogin * 1000", to: "user.lastLoginAt * 1000" },
    ],
    agentB: [
      { file: "src/sessions/last-seen.ts", create: `import type { User } from "../contracts/user";\n\nexport function lastSeen(user: User): number {\n  return user.lastLogin;\n}\n` },
    ],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { createUser } from "./users/user";\nimport { lastSeen } from "./sessions/last-seen";\n\nit("lastSeen returns the login time", () => {\n  const at = new Date("2026-10-24T12:00:00Z");\n  expect(lastSeen(createUser("1", "Ada", at))).toBe(Math.floor(at.getTime() / 1000));\n});\n` },
    expect: { mergeClean: true, bug: true, visibleChecksCatch: true },
  },
  {
    id: "return-shape",
    kind: "changed return behavior",
    description: "A makes recordLogin return a new User instead of mutating (types still compile for callers); B adds touch() that relies on the mutation.",
    agentA: [
      { file: "src/users/user.ts", from: "export function recordLogin(user: User, at: Date): void {\n  user.lastLogin = Math.floor(at.getTime() / 1000);\n}", to: "export function recordLogin(user: User, at: Date): User {\n  return { ...user, lastLogin: Math.floor(at.getTime() / 1000) };\n}" },
      { file: "src/users/user.test.ts", from: "recordLogin(user, new Date(1_800_000_000_000));\n    expect(user.lastLogin)", to: "expect(recordLogin(user, new Date(1_800_000_000_000)).lastLogin)" },
    ],
    agentB: [
      { file: "src/sessions/touch.ts", create: `import type { User } from "../contracts/user";\nimport { recordLogin } from "../users/user";\n\nexport function touch(user: User, at: Date): number {\n  recordLogin(user, at);\n  return user.lastLogin;\n}\n` },
      { file: "src/sessions/touch.test.ts", create: `${HEAD}import { createUser } from "../users/user";\nimport { touch } from "./touch";\n\nit("touch updates the login time", () => {\n  const user = createUser("1", "Ada", new Date(0));\n  expect(touch(user, new Date(5_000_000))).toBe(5000);\n});\n` },
    ],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { createUser } from "./users/user";\nimport { touch } from "./sessions/touch";\n\nit("touch updates the login time", () => {\n  const user = createUser("1", "Ada", new Date(0));\n  expect(touch(user, new Date(5_000_000))).toBe(5000);\n});\n` },
    expect: { mergeClean: true, bug: true, visibleChecksCatch: true },
  },
  {
    id: "changed-default",
    kind: "changed default",
    description: "A lowers the default session timeout to 15 minutes (and its test); B adds a stale-user counter that assumes the 30 minute default.",
    agentA: [
      { file: "src/sessions/session.ts", from: "timeoutMinutes = 30", to: "timeoutMinutes = 15" },
      { file: "src/sessions/session.test.ts", from: "expires at thirty minutes", to: "expires at fifteen minutes" },
      { file: "src/sessions/session.test.ts", from: "29 * 60_000))).toBe(false)", to: "14 * 60_000))).toBe(false)" },
      { file: "src/sessions/session.test.ts", from: "30 * 60_000))).toBe(true)", to: "15 * 60_000))).toBe(true)" },
    ],
    agentB: [
      { file: "src/analytics/stale.ts", create: `import type { User } from "../contracts/user";\nimport { sessionExpired } from "../sessions/session";\n\nexport function countStale(users: User[], now: Date): number {\n  return users.filter((user) => sessionExpired(user, now)).length;\n}\n` },
      { file: "src/analytics/stale.test.ts", create: `${HEAD}import { createUser } from "../users/user";\nimport { countStale } from "./stale";\n\nit("a user 20 minutes in is not stale (30 minute default)", () => {\n  const at = new Date("2026-10-24T12:00:00Z");\n  expect(countStale([createUser("1", "Ada", at)], new Date(at.getTime() + 20 * 60_000))).toBe(0);\n});\n` },
    ],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { createUser } from "./users/user";\nimport { countStale } from "./analytics/stale";\n\nit("a user 20 minutes in is not stale", () => {\n  const at = new Date("2026-10-24T12:00:00Z");\n  expect(countStale([createUser("1", "Ada", at)], new Date(at.getTime() + 20 * 60_000))).toBe(0);\n});\n` },
    expect: { mergeClean: true, bug: true, visibleChecksCatch: true },
  },
  {
    id: "removed-export",
    kind: "renamed export",
    description: "A renames recordLogin to touchLogin (updating callers it sees); B adds a new caller of recordLogin.",
    agentA: [
      { file: "src/users/user.ts", from: "export function recordLogin", to: "export function touchLogin" },
      { file: "src/users/user.test.ts", from: "import { createUser, recordLogin } from \"./user\";", to: "import { createUser, touchLogin } from \"./user\";" },
      { file: "src/users/user.test.ts", from: "    recordLogin(user,", to: "    touchLogin(user," },
    ],
    agentB: [
      { file: "src/sessions/login-hook.ts", create: `import type { User } from "../contracts/user";\nimport { recordLogin } from "../users/user";\n\nexport function onLogin(user: User, at: Date): void {\n  recordLogin(user, at);\n}\n` },
    ],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { createUser } from "./users/user";\nimport { onLogin } from "./sessions/login-hook";\n\nit("onLogin records the login", () => {\n  const user = createUser("1", "Ada", new Date(0));\n  onLogin(user, new Date(9_000_000));\n  expect(user.lastLogin).toBe(9000);\n});\n` },
    expect: { mergeClean: true, bug: true, visibleChecksCatch: true },
  },
  {
    id: "latent-rounding",
    kind: "latent semantic change",
    description: "A rounds stored login times down to the minute (its tests use minute-aligned times); B's timeout tests are minute-aligned too. Only a user created mid-minute shows the bug.",
    agentA: [
      { file: "src/users/user.ts", from: "return { id, name, lastLogin: Math.floor(at.getTime() / 1000) };", to: "return { id, name, lastLogin: Math.floor(at.getTime() / 60_000) * 60 };" },
    ],
    agentB: [
      { file: "src/sessions/session.test.ts", from: "expect(sessionExpired(user, new Date(at.getTime() + 30 * 60_000))).toBe(true);", to: "expect(sessionExpired(user, new Date(at.getTime() + 30 * 60_000))).toBe(true);\n  expect(sessionExpired(user, new Date(at.getTime() + 45 * 60_000))).toBe(true);" },
    ],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { createUser } from "./users/user";\nimport { sessionExpired } from "./sessions/session";\n\nit("a user created mid-minute is not expired at 29m40s", () => {\n  const at = new Date("2026-10-24T12:00:30Z");\n  expect(sessionExpired(createUser("1", "Ada", at), new Date(at.getTime() + 29 * 60_000 + 40_000))).toBe(false);\n});\n` },
    expect: { mergeClean: true, bug: true, visibleChecksCatch: false },
  },
  {
    id: "textual-conflict",
    kind: "merge conflict",
    description: "A and B add different optional fields on the same line of the shared User contract. Git itself reports a conflict.",
    agentA: [{ file: "src/contracts/user.ts", from: "lastLogin: number;", to: "lastLogin: number;\n  email?: string;" }],
    agentB: [{ file: "src/contracts/user.ts", from: "lastLogin: number;", to: "lastLogin: number;\n  timezone?: string;" }],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}it("placeholder", () => { expect(true).toBe(true); });\n` },
    expect: { mergeClean: false, bug: true, visibleChecksCatch: true },
  },
  {
    id: "benign",
    kind: "no bug (false-positive control)",
    description: "A adds a helper to users/user.ts; B adds an unrelated helper in sessions. Nothing interacts; a good checker stays green.",
    agentA: [{ file: "src/users/user.ts", from: "export function recordLogin", to: "export const isNewUser = (user: User): boolean => user.lastLogin === 0;\n\nexport function recordLogin" }],
    agentB: [{ file: "src/sessions/limits.ts", create: `export const MAX_SESSIONS_PER_USER = 5;\n` }],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { createUser, isNewUser } from "./users/user";\nimport { MAX_SESSIONS_PER_USER } from "./sessions/limits";\n\nit("both helpers work", () => {\n  expect(isNewUser(createUser("1", "Ada", new Date(0)))).toBe(true);\n  expect(MAX_SESSIONS_PER_USER).toBe(5);\n});\n` },
    expect: { mergeClean: true, bug: false, visibleChecksCatch: false },
  },
  // ---- Added to widen the benchmark: bugs the visible checks are EXPECTED TO MISS, one more type-level
  // bug, and extra clean controls. Honest reporting needs scenarios the system fails, not only ones it passes.
  {
    id: "sentinel-meaning",
    kind: "semantic mismatch (expected miss)",
    description: "A makes createUser(id, name) without a date mean 'never logged in' (lastLogin -1). B's neverLoggedIn() still tests for 0, and B's own test builds its user as a literal, so nothing visible exercises both together.",
    agentA: [
      { file: "src/users/user.ts", from: "export function createUser(id: string, name: string, at: Date): User {\n  return { id, name, lastLogin: Math.floor(at.getTime() / 1000) };\n}", to: "export function createUser(id: string, name: string, at?: Date): User {\n  return { id, name, lastLogin: at ? Math.floor(at.getTime() / 1000) : -1 };\n}" },
    ],
    agentB: [
      { file: "src/analytics/never.ts", create: `import type { User } from "../contracts/user";\n\nexport function neverLoggedIn(user: User): boolean {\n  return user.lastLogin === 0;\n}\n` },
      { file: "src/analytics/never.test.ts", create: `${HEAD}import { neverLoggedIn } from "./never";\n\nit("a zero login time means never logged in", () => {\n  expect(neverLoggedIn({ id: "1", name: "Ada", lastLogin: 0 })).toBe(true);\n});\n` },
    ],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { createUser } from "./users/user";\nimport { neverLoggedIn } from "./analytics/never";\n\nit("a user created without a date has never logged in", () => {\n  expect(neverLoggedIn(createUser("1", "Ada"))).toBe(true);\n});\n` },
    expect: { mergeClean: true, bug: true, visibleChecksCatch: false },
  },
  {
    id: "boundary-disagree",
    kind: "inconsistent boundary (expected miss)",
    description: "A adds isActive() that treats exactly 30 minutes as still active; B adds sessionStatus() built on sessionExpired(), which treats 30 minutes as expired. Each is tested only away from the boundary.",
    agentA: [
      { file: "src/users/active.ts", create: `import type { User } from "../contracts/user";\n\nexport function isActive(user: User, now: Date, timeoutMinutes = 30): boolean {\n  return (now.getTime() / 1000 - user.lastLogin) / 60 <= timeoutMinutes;\n}\n` },
      { file: "src/users/active.test.ts", create: `${HEAD}import { createUser } from "./user";\nimport { isActive } from "./active";\n\nit("is active ten minutes after login", () => {\n  const at = new Date("2026-10-24T12:00:00Z");\n  expect(isActive(createUser("1", "Ada", at), new Date(at.getTime() + 10 * 60_000))).toBe(true);\n});\n` },
    ],
    agentB: [
      { file: "src/sessions/status.ts", create: `import type { User } from "../contracts/user";\nimport { sessionExpired } from "./session";\n\nexport function sessionStatus(user: User, now: Date): "active" | "expired" {\n  return sessionExpired(user, now) ? "expired" : "active";\n}\n` },
      { file: "src/sessions/status.test.ts", create: `${HEAD}import { createUser } from "../users/user";\nimport { sessionStatus } from "./status";\n\nit("is expired after forty minutes", () => {\n  const at = new Date("2026-10-24T12:00:00Z");\n  expect(sessionStatus(createUser("1", "Ada", at), new Date(at.getTime() + 40 * 60_000))).toBe("expired");\n});\n` },
    ],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { createUser } from "./users/user";\nimport { isActive } from "./users/active";\nimport { sessionStatus } from "./sessions/status";\n\nit("the two modules agree at exactly thirty minutes", () => {\n  const at = new Date("2026-10-24T12:00:00Z");\n  const user = createUser("1", "Ada", at);\n  const now = new Date(at.getTime() + 30 * 60_000);\n  expect(isActive(user, now)).toBe(sessionStatus(user, now) === "active");\n});\n` },
    expect: { mergeClean: true, bug: true, visibleChecksCatch: false },
  },
  {
    id: "swapped-params",
    kind: "swapped same-typed parameters (expected miss)",
    description: "A swaps createUser's id and name parameters (both strings, so the types still match). B's new guest helper calls createUser(id, name, ...) and its test only checks the login time.",
    agentA: [
      { file: "src/users/user.ts", from: "export function createUser(id: string, name: string, at: Date): User {", to: "export function createUser(name: string, id: string, at: Date): User {" },
    ],
    agentB: [
      { file: "src/sessions/guest.ts", create: `import type { User } from "../contracts/user";\nimport { createUser } from "../users/user";\n\nexport function guestUser(at: Date): User {\n  return createUser("guest-1", "Guest", at);\n}\n` },
      { file: "src/sessions/guest.test.ts", create: `${HEAD}import { guestUser } from "./guest";\n\nit("stamps the guest with the login time", () => {\n  expect(guestUser(new Date(1_800_000_000_000)).lastLogin).toBe(1_800_000_000);\n});\n` },
    ],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { guestUser } from "./sessions/guest";\n\nit("the guest has the id and name B intended", () => {\n  const guest = guestUser(new Date(0));\n  expect(guest.id).toBe("guest-1");\n  expect(guest.name).toBe("Guest");\n});\n` },
    expect: { mergeClean: true, bug: true, visibleChecksCatch: false },
  },
  {
    id: "required-field",
    kind: "added required field",
    description: "A adds a required User.email and sets it in createUser. B adds a guest helper that builds a User literal without it. The type checker sees the missing field.",
    agentA: [
      { file: "src/contracts/user.ts", from: "lastLogin: number;", to: "lastLogin: number;\n  email: string;" },
      { file: "src/users/user.ts", from: "return { id, name, lastLogin:", to: "return { id, name, email: \"\", lastLogin:" },
    ],
    agentB: [
      { file: "src/sessions/guest.ts", create: `import type { User } from "../contracts/user";\n\nexport function guestUser(): User {\n  return { id: "guest", name: "Guest", lastLogin: 0 };\n}\n` },
    ],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { guestUser } from "./sessions/guest";\n\nit("the guest has an email string", () => {\n  expect(typeof guestUser().email).toBe("string");\n});\n` },
    expect: { mergeClean: true, bug: true, visibleChecksCatch: true },
  },
  {
    id: "benign-same-file",
    kind: "no bug (false-positive control)",
    description: "A and B both edit src/users/user.ts in different places. Git merges them and everything still works.",
    agentA: [{ file: "src/users/user.ts", from: "export function createUser", to: "export function isoLogin(user: User): string {\n  return new Date(user.lastLogin * 1000).toISOString();\n}\n\nexport function createUser" }],
    agentB: [{ file: "src/users/user.ts", from: "user.lastLogin = Math.floor(at.getTime() / 1000);\n}", to: "user.lastLogin = Math.floor(at.getTime() / 1000);\n}\n\nexport const countUsers = (users: User[]): number => users.length;" }],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { createUser, isoLogin, countUsers } from "./users/user";\n\nit("both additions work together", () => {\n  const user = createUser("1", "Ada", new Date("2026-10-24T12:00:00Z"));\n  expect(isoLogin(user)).toBe("2026-10-24T12:00:00.000Z");\n  expect(countUsers([user])).toBe(1);\n});\n` },
    expect: { mergeClean: true, bug: false, visibleChecksCatch: false },
  },
  {
    id: "benign-optional-field",
    kind: "no bug (false-positive control)",
    description: "A adds an optional User.email to the shared contract. B adds an unrelated sessions helper. An optional field breaks no caller.",
    agentA: [{ file: "src/contracts/user.ts", from: "lastLogin: number;", to: "lastLogin: number;\n  email?: string;" }],
    agentB: [{ file: "src/sessions/limits.ts", create: `export const MAX_SESSIONS_PER_USER = 5;\n` }],
    hidden: { file: "src/hidden.test.ts", content: `${HEAD}import { createUser } from "./users/user";\nimport { MAX_SESSIONS_PER_USER } from "./sessions/limits";\n\nit("existing users still work and the limit is set", () => {\n  expect(createUser("1", "Ada", new Date(0)).email).toBeUndefined();\n  expect(MAX_SESSIONS_PER_USER).toBe(5);\n});\n` },
    expect: { mergeClean: true, bug: false, visibleChecksCatch: false },
  },
];
