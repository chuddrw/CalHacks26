# Presentation scaffold

Open http://127.0.0.1:5173/presentation/ with the existing UI dev server (`npm run dev -w ui`). Vite copies these static files into the production build. This page does not load the dashboard or connect to SpacetimeDB.

Seven sections: Summary, Problem, Solution, Benchmark, Demo, Technical details, Closing. Summary and Closing are one section each. Scroll, use header links, footer arrows, or arrow/Page Up/Page Down keys. Each slide fits inside a fixed stage. Content scales down when needed; the page cannot stop between slides. Wheel/trackpad gestures, vertical swipes, links, and keyboard controls move between slides with a 420ms vertical transition. Reduced-motion skips the animation.

Content is an editable structure draft based on plan.md. Benchmark metrics are proposed, not measured results. Replace placeholders and confirm wording before judging. Visual direction is provisional pending user approval.

## Add the demo video

Place a team-approved MP4 in this folder, set the video element's src to `./demo.mp4`, remove its `hidden` attribute, and remove the `.video-placeholder` element. Add captions using a `track` element when available. No autoplay; presenters control playback. A simulated-dashboard link is available as a backup and is labeled as simulated.

Edit index.html for content, presentation.css for appearance, and presentation.js for navigation. No new dependencies. No hosting/deployment configured; this is local work on codex/presentation-website-mvp.

## Content brief update

Copy follows the user-supplied agent_cowork_demo_script_brief.md. It is storytelling guidance, not runtime verification. Benchmark compares one agent, parallel agents with Git/CI, and the same team with Cowork. All results and demo footage remain pending. No formal consensus, verified session wake-up, automatic main publication, or numeric improvement is asserted.

Continued wheel or trackpad scrolling advances at most once every 520ms, so every slide can be reached without clicks or waiting for momentum to stop. Reversing direction responds immediately.
