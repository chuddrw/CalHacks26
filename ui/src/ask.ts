/**
 * WHAT IT'S FOR: the "Ask the orchestrator" box. Turns what a person typed (a plain request, or the
 * first-time setup answers) into the one text the orchestrator's submit_request takes, and sends it
 * through the signed-in dashboard connection (stdb.ts submitRequest). Pure except sendRequest.
 */
export interface RoleRow {
  person: string;
  feature: string;
  paths: string;
}
export type Setup =
  | { mode: "none" }
  | { mode: "roles"; roles: RoleRow[] }
  | { mode: "goal"; goal: string; constraints: string };

export const MAX_REQUEST_CHARS = 4000;

export interface Draft {
  text: string;
  setup: Setup;
}

/** A readable problem with the draft, or "" when it can be sent. */
export function draftProblem(draft: Draft): string {
  const body = requestBody(draft);
  if (draft.setup.mode === "goal" && !draft.setup.goal.trim()) return "Describe the goal.";
  if (draft.setup.mode === "roles" && filledRoles(draft.setup.roles).length === 0)
    return "Add at least one person with a feature, or switch to the goal option.";
  if (draft.setup.mode === "none" && !draft.text.trim()) return "Write what you want done.";
  if (body.length > MAX_REQUEST_CHARS) return `Too long: ${body.length} of ${MAX_REQUEST_CHARS} characters.`;
  return "";
}

const filledRoles = (roles: RoleRow[]): RoleRow[] => roles.filter((r) => r.person.trim() && r.feature.trim());

export function requestBody(draft: Draft): string {
  const text = draft.text.trim();
  const { setup } = draft;
  if (setup.mode === "roles") {
    const lines = filledRoles(setup.roles).map(
      (r) => `- ${r.person.trim()}: ${r.feature.trim()}${r.paths.trim() ? ` (${r.paths.trim()})` : ""}`,
    );
    return ["Team setup: responsibilities already decided.", ...lines, text && `Request: ${text}`].filter(Boolean).join("\n");
  }
  if (setup.mode === "goal") {
    return [
      "Team setup: no responsibilities yet. Propose who owns what, the shared contracts and a first task each.",
      `Goal: ${setup.goal.trim()}`,
      setup.constraints.trim() && `Constraints: ${setup.constraints.trim()}`,
      text && `Request: ${text}`,
    ].filter(Boolean).join("\n");
  }
  return text;
}
