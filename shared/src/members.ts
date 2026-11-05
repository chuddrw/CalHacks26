/**
 * shared/src/members.ts
 *
 * WHAT IT'S FOR
 *   Who is who: the database owner binds each approved SpacetimeDB identity to a handle (the agent
 *   name) and a display name in the `member_profile` view. This file reads that view over HTTP and
 *   finds this laptop's public identity, so join.ts, doctor.ts and the MCP `whoami` tool can say
 *   "you are catherine (Catherine)" and tell people exactly what to fix when the two disagree.
 *
 * NOTES
 *   - The view is added by the module separately and isn't in shared/src/schema.ts, so rows are
 *     mapped by the column names the server sends back, not by position.
 *   - Everything here fails soft: no view, no access, no network -> null. Only public identities
 *     are read or printed, never a token.
 */
import { spawnSync } from "node:child_process";
import { config, TEAM_DB } from "./config.ts";
import { spacetimeCli, sessionToken } from "./session-token.ts";

export interface MemberProfile {
  identity: string;
  handle: string;
  displayName: string;
  createdAt: number;
}

/** "0xAB.." / {__identity__: "ab.."} / ["ab.."] all become lowercase hex. */
export function normalizeIdentity(value: unknown): string {
  if (Array.isArray(value)) return normalizeIdentity(value[0]);
  if (value && typeof value === "object") return normalizeIdentity(Object.values(value)[0]);
  return String(value ?? "").replace(/^0x/i, "").toLowerCase();
}

/** Lowercase slug usable as an agent name: "Catherine Zheng" -> "catherine-zheng". "" if nothing is left. */
export function slugHandle(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "");
}

/** First free handle: "sam", then "sam-2", "sam-3"... */
export function freeHandle(wanted: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(wanted)) return wanted;
  for (let n = 2; ; n++) if (!used.has(`${wanted}-${n}`)) return `${wanted}-${n}`;
}

/** This laptop's public identity from `spacetime login show`, or "" (never a token). */
export function publicIdentity(): string {
  const shown = spawnSync(spacetimeCli(), ["login", "show"], { encoding: "utf8" });
  return /\b[0-9a-f]{64}\b/i.exec(`${shown.stdout}${shown.stderr}`)?.[0]?.toLowerCase() ?? "";
}

/** Every member_profile row, or null when the view doesn't exist yet / this user can't read it. */
export async function memberProfiles(timeoutMs = 3000): Promise<MemberProfile[] | null> {
  if (!config.stdbDb) return null;
  try {
    const token = await sessionToken();
    const host = config.stdbHost.replace(/\/+$/, "");
    const res = await fetch(`${host}/v1/database/${encodeURIComponent(config.stdbDb)}/sql`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: "SELECT * FROM member_profile",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const first = ((await res.json()) as Array<{ schema?: { elements?: Array<{ name?: unknown }> }; rows?: unknown[][] }>)[0];
    const names = (first?.schema?.elements ?? []).map((element) => {
      const name = element.name;
      return typeof name === "string" ? name : String((name as { some?: string } | undefined)?.some ?? "");
    });
    return (first?.rows ?? []).map((row) => {
      const get = (key: string) => row[names.indexOf(key)];
      return {
        identity: normalizeIdentity(get("identity")),
        handle: String(get("handle") ?? ""),
        displayName: String(get("displayName") ?? get("display_name") ?? ""),
        createdAt: Number(get("createdAt") ?? get("created_at") ?? 0),
      };
    });
  } catch {
    return null;
  }
}

/** The owner's one-line approval command for this person. Public identity only. */
/** `db` is the database this laptop is joining; the default is the team database. (.env may still hold an older name on a first run.) */
export function grantCommand(identity: string, handle: string, displayName: string, db: string = TEAM_DB): string {
  return `npm run access --prefix module -- grant ${db} ${identity} editor --name ${handle} --display "${displayName.replace(/"/g, "")}"`;
}
