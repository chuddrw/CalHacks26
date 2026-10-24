/** WHAT IT'S FOR: small, consistent SVG symbols for the dashboard. Owner: D. */
import type { CSSProperties } from "react";
const paths = {
  sidebar: "M3 4h18v16H3zM9 4v16M5.5 8h1M5.5 12h1M5.5 16h1",
  agent:
    "M8 5h8a4 4 0 0 1 4 4v9H4V9a4 4 0 0 1 4-4ZM12 2v3M2 10v5m20-5v5M8 11v2m8-2v2M8 18v3m8-3v3",
  close: "m6 6 12 12M18 6 6 18",
  branch:
    "M6 3v10a5 5 0 0 0 5 5h5M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0-13a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 12h5a5 5 0 0 0 5-5",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  activity: "M2 12h5l3-8 4 16 3-8h5",
  check: "m5 12 4 4L19 6",
  alert: "m12 3 10 18H2L12 3Zm0 6v5m0 3v.1",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  play: "m8 4 12 8-12 8V4Z",
  pause: "M8 5v14M16 5v14",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18",
  sparkle: "m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z",
  link: "m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  chevron: "m9 5 7 7-7 7",
  memory: "M9 3h6v4h4v10h-4v4H9v-4H5V7h4V3Zm0 7h6v4H9z",
  signal: "M5 17v3m5-8v8m5-13v13m5-18v18",
  info: "M12 11v6m0-10v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
} as const;
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: keyof typeof paths;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
