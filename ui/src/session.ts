/** WHAT IT'S FOR: obtain this dashboard laptop's CLI session in memory; never persist credentials. */
export async function getLocalSessionToken(): Promise<string | undefined> {
  const response = await fetch("/__cowork/session", {
    method: "POST",
    mode: "same-origin",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "X-Cowork-Session": "1" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return undefined;
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("token" in body) ||
    typeof body.token !== "string"
  )
    return undefined;
  return body.token;
}
