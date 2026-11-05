/** WHAT IT'S FOR: the rows of the Team drawer. Pure, so tests can check them. */
import type { Tables } from "./dashboard";
import { normalizeIdentity, type MemberProfileRow } from "./members";

export interface TeamRow {
  handle: string;
  name: string;
  online: boolean;
  you: boolean;
  /** The agent's newest open task, or "". */
  working: string;
}

/** Every named member plus every agent seen in the database, named people first. */
export function teamRows(tables: Tables, members: MemberProfileRow[], identity: string): TeamRow[] {
  const me = normalizeIdentity(identity);
  const handles = new Set<string>([...members.map((m) => m.handle), ...tables.agent.map((a) => a.name)]);
  const rows = [...handles].map((handle): TeamRow => {
    const profile = members.find((m) => m.handle === handle);
    const open = tables.task
      .filter((t) => t.agent === handle && (t.status === "assigned" || t.status === "waiting_review"))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return {
      handle,
      name: profile?.displayName.trim() ?? "",
      online: tables.agent.find((a) => a.name === handle)?.online ?? false,
      you: !!me && !!profile && normalizeIdentity(profile.identity) === me,
      working: open?.title ?? "",
    };
  });
  return rows.sort((a, b) => Number(!!b.name) - Number(!!a.name) || a.handle.localeCompare(b.handle));
}
