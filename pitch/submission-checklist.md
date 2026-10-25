# Submission and evidence checklist

WHAT IT'S FOR: D's final handoff for a truthful, reviewable Devpost submission.
No submission has been made by this branch.

## Confirm with the team

- [x] Project name Agent Cowork approved by the user.
- [ ] Final short tagline approved by the user.
- [ ] Team member names and contribution attribution.
- [ ] Actual demo-app repository URL (this is a separate repository).
- [ ] Final dashboard screenshot selection approved by the user.
- [ ] Real video recorded, reviewed, uploaded, and playable from its final URL.
- [ ] All required repositories and the video are accessible to judges.
- [ ] Table number and current event instructions verified with organizers.
- [x] Official submission deadline verified; see event-requirements.md.
- [ ] Allowed edit window and table assignment confirmed with organizers.
- [ ] Sponsor track names/requirements verified from current official pages.
- [ ] User authorizes submission of the final reviewed materials.

## Known links

The user will obtain missing inputs from teammates later. The local checkout and
fetched `catherine_part_c`, `feat/a-hooks-mcp`, and `watcher` documentation were
checked; they do not supply final team attribution, actual interviews, or final
demo/video URLs. Do not infer team names from repository contributors.

- Tool repository: https://github.com/chuddrw/CalHacks26
- Demo repository: not supplied.
- Video URL: not supplied.
- Local backup video: not recorded.
- Submission URL/status: not supplied / not submitted.

## Evidence gates

| Claim                                | Required evidence                                        | Current status                  |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------- |
| Dashboard shows team state           | Browser inspection and screenshots                       | Local simulated scenes verified, including the orchestrator drawer, threads and decisions (Oct 24) |
| Dashboard uses live SpacetimeDB data | Published module, generated bindings, real table changes | Pending C (deploy from `feat/orchestrator`) |
| Every edit produces a snapshot       | Observe A's hook and pushed wip branch                   | Verified on a local server (`npm run test:live`); pending the team database |
| Droid plans a request                | Actual SDK steps and the published plan from a real run  | One real run, Oct 24: 52 s, tasks for a and b, reviews by b and d, conflict a x b. Not yet shown on the dashboard |
| Major change waits for a review      | Approve on the dashboard releasing the held tasks        | Verified on a local server and in the simulated dashboard |
| Combined check detects the pair      | check_with_team output and matching conflict/check rows  | Verified with real tsc and vitest on a local server |
| Agents settle a conflict themselves  | Two real Claude Code sessions messaging and agreeing     | Verified with scripted agents on a local server; pending real sessions |
| Idle agent wakes with its task       | Recording of actual agent terminal                       | Hooks verified (wake 0.2-0.7 s after approval, local server); pending real sessions |
| Fact reaches a fresh agent           | New session output and matching verified fact row        | Pending A/C                     |
| Test edits trigger human review      | Actual modified-test snapshot and guard result           | Guard runs inside agree; not yet exercised end to end |
| Conflict goes to both humans         | escalate or timer, then the dashboard decision           | Verified on the mock database and in module tests; pending a live run |
| Rehearsals pass consistently         | Five recorded outcomes with revisions and timings        | Not measured                    |
| Real team pain point                 | Three interviews, one usable quote with permission       | Not collected                   |

## Asset list

- `artifacts/work-d/overview-conflict.jpg`: symbolic conflict overview.
- `artifacts/work-d/overview-green.jpg`: symbolic passing-check overview.
- `artifacts/work-d/conflict-summary-drawer.jpg`: initial conflict disclosure.
- `artifacts/work-d/conflict-evidence-drawer.jpg`: source, failure, and diagnosis details.
- `artifacts/work-d/mobile-overview.jpg`: responsive symbolic map.
- `artifacts/work-d/mobile-inspector.jpg`: full-width mobile detail view.
- `artifacts/work-d/nonmodal-inspector.jpg`: current interactive map beside the inspector.
- `artifacts/work-d/unconfigured.jpg`: earlier configuration / offline-state check; refresh before final use.

Earlier `desktop-*.jpg` and `mobile-conflict.jpg` captures are design history from
the denser iteration. They are not the current screenshot selection.

Refresh screenshots after the final design review. They demonstrate the UI; they
are not recordings or evidence that the underlying agents and checks ran.

## Before final submission

1. Update `pitch/devpost.md` to reflect only capabilities verified in the final build.
2. Replace any internal evidence notes with actual links and measurements.
3. Include screenshots, the actual demo video, both repo links, and team/table details.
4. Review text and assets with the user, then perform the specifically authorized submission.
5. Open the saved submission and every external link to verify the published result.
