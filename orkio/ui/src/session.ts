/**
 * WHAT IT'S FOR: how the dashboard signs in. The Vite dev server (ui/dev-session.ts) reads this
 * laptop's `spacetime login` session and hands the token to a page on the same laptop, so no token
 * sits in .env, in the bundle, or in dashboard state. Owner: A (written for D's live mode).
 */
export const SESSION_PATH = "/__cowork/session";
/** A custom header: a page from another site can't send it without a CORS preflight, which we never grant. */
export const SESSION_HEADER = "x-cowork-dashboard";

/** This laptop's session token, or "" when the dev server can't provide one (not signed in, or a production build). */
export async function fetchSessionToken(): Promise<string> {
  try {
    const res = await fetch(SESSION_PATH, { headers: { [SESSION_HEADER]: "1" }, cache: "no-store" });
    if (!res.ok) return "";
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === "string" ? body.token : "";
  } catch {
    return "";
  }
}
