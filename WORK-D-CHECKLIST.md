# Work D — dashboard and presentation

Owner: D. Initial branch: `codex/work-d-dashboard-pitch`. Remaining core integration:
`codex/work-d-live-integration`, based on integrated commit `8092c4e`.

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
- [x] Coordinate the live adapter with C's actual generated SpacetimeDB bindings (real 2.13 module, seven views synchronized).
- [x] Wire the dashboard to this laptop's own CLI sign-in, refreshed on reconnect, without persistent browser credentials.
- [x] Reject remote/cross-origin credential-bridge requests and late session responses after teardown.
- [x] Provide an explicitly labeled local demo mode for independent UI development.
- [x] Show agent presence, intent, files, check state, snapshot age, and new activity.
- [x] Show conflicts, locations, matching diff snippets, fixer, and diagnosis.
- [x] Make escalated and needs-human conflicts prominent.
- [x] Render diagnosis updates, show source, and implement optional follow behavior.
- [x] Show verified facts, recent plans, and highlight new facts.
- [x] Show a unified timeline with relative timestamps and check result labels.
- [x] Implement big-screen, responsive, keyboard-accessible controls, and reduced-motion styles.
- [x] Verify nonmodal keyboard navigation, Escape dismissal/restoration, diagnosis-follow controls, and automatic local story playback.
- [x] Avoid reporting healthy checks while disconnected, loading, or without a check covering all contributing agents.
- [x] Typecheck seed reducer calls, validate fixture rows, and verify conflict/resolved dry runs.
- [x] Exercise conflict/resolved/needs_human seed writes against C's real module on an isolated temporary database.
- [x] Verify real four-identity presence, disconnect updates, three synchronized clients, updates/deletes, resubscription, and revocation.
- [x] Inspect real subscribed conflict/evidence, resolved memory, and human-review state in the browser (seeded content, real transport).

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
- [x] Verify the dashboard against the real module on a temporary local server: 11/11 checks.
- [ ] Verify the dashboard against the team Maincloud database after sign-in, owner approval, and deployment confirmation.
- [ ] Verify the same live state updates on three presentation screens, as required by plan.md.
- [ ] Rehearse on the actual venue network and verify offline backup playback on presentation hardware.
- [x] Document commands, external dependencies, and remaining team-owned prerequisites in ui/README.md and pitch/submission-checklist.md.
- [ ] Review final design and presentation with the user.

## Current dependencies

The user selected one CLI sign-in per laptop for rehearsal; D's local session
bridge is implemented. This laptop is signed in, but its authenticated read-only
query to shared `agent-cowork` returned HTTP 403. C owns publishing the shared
database module and granting each public identity Reader/Editor access. The
dashboard needs Reader access; an agent laptop needs Editor access. No external
OIDC client is needed for this local flow. Maincloud and the physical four-laptop
rehearsal remain unverified. See checklists/D-live.md for evidence and handoff.

The user will obtain
missing presentation inputs from teammates later. The local checkout and fetched
A/B/C branch documentation contain no actual interview notes, final team names,
demo repository URL, or recording URL; these remain pending rather than inferred
from GitHub usernames. The phone-panel question remains open.

The integrated checkout includes C's implementation and generated bindings, A's
hooks/MCP, B's watcher, and D's dashboard. The local real-server tests do not prove
paid diagnosis calls, autonomous agent repair, or real multi-laptop rehearsal.
No interview quotes, performance measurements, or submission status will be invented.

The preview server is running outside the sandbox at http://127.0.0.1:5173/?demo.
Browser access resumed with the user's authorization. Automatic story playback,
the diagnosis-follow toggle, and keyboard focus into the diagnosis feed were verified.
The user selected a quieter connected-agent map with side drawers. It is implemented,
with summary-to-evidence disclosure and refreshed screenshots. Final visual review
and remaining external inputs are pending. Automated checks do not establish live
integration on the team database or venue hardware. Interviews and pitch work
are excluded from the user's current core-dashboard request.
