/**
 * WHAT IT'S FOR: who is who. The module's `member_profile` rows tie a SpacetimeDB identity to an
 * agent handle and a display name ("Catherine"). This keeps them in a tiny store of their own
 * (the table may not exist yet, so it stays out of the schema-driven tables), plus the signed-in
 * identity, so the dashboard can say "Catherine's agent" and know who is asking.
 * Pure TypeScript, no React: useMembers.ts is the hook.
 */
import type { MemberProfileRow } from "../../shared/src/schema.ts";
export type { MemberProfileRow };

let members: MemberProfileRow[] = [];
let identity = "";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const getMembers = (): MemberProfileRow[] => members;
export const getIdentity = (): string => identity;
export function subscribeMembers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setMembers(rows: MemberProfileRow[]): void {
  members = rows;
  emit();
}
export function setIdentity(value: string): void {
  identity = normalizeIdentity(value);
  emit();
}

/** Identities compare as lowercase hex without a 0x prefix. */
export const normalizeIdentity = (value: string): string => value.trim().toLowerCase().replace(/^0x/, "");

/** Rows from the SDK (bigint timestamps, any extra fields) into MemberProfileRow[]; bad rows are skipped. */
export function normalizeMembers(rows: Iterable<unknown>): MemberProfileRow[] {
  const out: MemberProfileRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.identity === "string" ? r.identity : (r.identity as { toHexString?: () => string } | undefined)?.toHexString?.();
    if (!id || typeof r.handle !== "string" || typeof r.displayName !== "string") continue;
    const created = typeof r.createdAt === "bigint" ? Number(r.createdAt) : typeof r.createdAt === "number" ? r.createdAt : 0;
    out.push({ identity: normalizeIdentity(id), handle: r.handle, displayName: r.displayName, createdAt: created });
  }
  return out;
}

/** The person's name for an agent handle, or "" when no profile names it. */
export function displayNameOf(handle: string, rows: MemberProfileRow[] = members): string {
  return rows.find((m) => m.handle === handle)?.displayName.trim() ?? "";
}
/** "Catherine" for a known handle, otherwise the handle in capitals ("A"), as before. */
export function personLabel(handle: string, rows: MemberProfileRow[] = members): string {
  return displayNameOf(handle, rows) || handle.toUpperCase();
}
/** "Catherine's agent" for a known handle, otherwise the plain handle ("a"). */
export function agentLabel(handle: string, rows: MemberProfileRow[] = members): string {
  const name = displayNameOf(handle, rows);
  return name ? `${name}'s agent` : handle;
}
/** The chip/heading text: "Catherine's agent" for a known handle, otherwise "Agent A", as before. */
export function agentChip(handle: string, rows: MemberProfileRow[] = members): string {
  const name = displayNameOf(handle, rows);
  return name ? `${name}'s agent` : `Agent ${handle.toUpperCase()}`;
}
/** The profile of the signed-in identity, if the owner approved it with a name. */
export function myProfile(rows: MemberProfileRow[] = members, id: string = identity): MemberProfileRow | undefined {
  const mine = normalizeIdentity(id);
  return mine ? rows.find((m) => normalizeIdentity(m.identity) === mine) : undefined;
}
