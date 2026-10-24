# Work D — dashboard and presentation

Owner: D. Branch: `codex/work-d-dashboard-pitch`.

This checklist tracks implementation and evidence. Unchecked items remain open;
interviews, measured results, recordings, and submissions require real evidence.

## Alignment

- [x] Read the plan, source, shared schema, and presentation materials.
- [x] Create a dedicated work branch.
- [x] Agree with the user on visual direction and demo information hierarchy: spatial navy, luminous agent connections; plan.md's demo story.
- [ ] Review the initial rendered dashboard with the user before further visual polish.
- [x] Keep the name Agent Cowork and plan.md's direct technical pitch tone (user confirmed).
- [ ] Agree on optional stretch work if the core integration is complete.
- [x] Replace the text-heavy overview with a connected-agent map, central health symbol, and side drawers (user-selected direction).
- [x] Reveal conflict summaries before changes and diagnosis; keep the map visible beside wider-screen drawers.
- [x] Make the inspector nonmodal, allowing map selection and keyboard navigation while details remain open (user requested).
- [ ] Confirm the phone inspector interaction with the user.

## Dashboard

- [x] Implement connection state, subscriptions, reconnect behavior, and cleanup; validate lifecycle with an injected transport.
- [ ] Coordinate the live adapter with C's actual generated SpacetimeDB bindings.
- [x] Provide an explicitly labeled local demo mode for independent UI development.
- [x] Show agent presence, intent, files, check state, snapshot age, and new activity.
- [x] Show conflicts, locations, matching diff snippets, fixer, and diagnosis.
- [x] Make escalated and needs-human conflicts prominent.
- [x] Render diagnosis updates, show source, and implement optional follow behavior.
- [x] Show verified facts, recent plans, and highlight new facts.
- [x] Show a unified timeline with relative timestamps and check result labels.
- [x] Implement big-screen, responsive, keyboard-accessible controls, and reduced-motion styles.
- [x] Verify keyboard focus trapping, Escape dismissal/restoration, diagnosis-follow controls, and automatic local story playback.
- [x] Avoid reporting healthy checks while disconnected, loading, or without a check covering all contributing agents.
- [x] Typecheck seed reducer calls, validate fixture rows, and verify conflict/resolved dry runs.
- [ ] Exercise seed writes against C's actual development module.

## Pitch and demo

- [x] Draft a cohesive two-minute script with a one-minute technical extension and a truthful simulated walkthrough.
- [x] Draft Devpost copy and judge answers distinguishing built vs planned features.
- [x] Prepare interview questions and quote-permission instructions.
- [ ] Capture three actual interviews with quote permission.
- [ ] Add actual measured results from end-to-end rehearsals.
- [x] Prepare recording steps, backup-video checklist, and hardware checklist.
- [x] Capture screenshots of the implemented dashboard using labeled simulated data.
- [ ] Record a real end-to-end backup video when A/B/C's integration is available.
- [x] Verify the official submission deadline and general presentation requirements; see pitch/event-requirements.md.
- [ ] Obtain actual team/table/demo-repo/video information and confirm remaining track requirements.
- [ ] Submit Devpost only with explicit authorization and verified final assets.

## Verification and handoff

- [x] Install only the dependencies needed for D's workspace.
- [x] Pass dashboard typecheck, automated tests, formatting check, and production build (rerun after final changes).
- [x] Inspect working, conflict, fixing, resolved, escalated, and human-review scenes in the browser; verify filtering, big-screen toggle, and mobile page width.
- [ ] Verify live integration against the actual database when available.
- [ ] Verify the same live state updates on three presentation screens, as required by plan.md.
- [ ] Rehearse on the actual venue network and verify offline backup playback on presentation hardware.
- [x] Document commands, external dependencies, and remaining team-owned prerequisites in ui/README.md and pitch/submission-checklist.md.
- [ ] Review final design and presentation with the user.

## Current dependencies

User confirmed browser authentication is not configured. The user will obtain
missing presentation inputs from teammates later. The local checkout and fetched
A/B/C branch documentation contain no actual interview notes, final team names,
demo repository URL, or recording URL; these remain pending rather than inferred
from GitHub usernames. The phone-panel question remains open.

The current checkout has no database implementation or generated client bindings yet.
C's `catherine_part_c` branch contains an implementation and generated bindings,
but the user reports integration is not ready. Publication, reader access, and an
authenticated browser connection still need team confirmation before live testing.
Live integration and a genuine end-to-end video depend on A/B/C's working services.
No interview quotes, performance measurements, or submission status will be invented.

The preview server is running outside the sandbox at http://127.0.0.1:5173/?demo.
Browser access resumed with the user's authorization. Automatic story playback,
the diagnosis-follow toggle, and keyboard focus into the diagnosis feed were verified.
The user selected a quieter connected-agent map with side drawers. It is implemented,
with summary-to-evidence disclosure and refreshed screenshots. Final visual review
and remaining external inputs are pending. Automated checks do not establish live
integration. Remote main still has C's module stub and blank database settings;
C's separate branch must not be mistaken for a verified live connection.
