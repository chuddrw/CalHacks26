/** WHAT IT'S FOR: shared, deterministic timestamp labels for D's dashboard. */
export function relativeTime(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return "Never";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function absoluteTime(at: number): string {
  return Number.isFinite(at) && at > 0
    ? new Date(at).toLocaleString()
    : "No timestamp";
}
