# Agent Cowork: final checklist

Deadline: **Sunday Oct 25, 9:00 AM PDT** (Devpost). Our own target is 8:30 AM. Judging is 10:30 to 12:30, with 3 minutes of demo and 2 minutes of questions.

The slides, the benchmark and the demo all need numbers and footage from a real run. So engineering has to finish first, and everything else builds on it.

Latest code: branch `integration` on github.com/chuddrw/CalHacks26 (A + B + C + D merged). `main` is still the skeleton.

## Timeline

| When | Gate | Done when |
|---|---|---|
| Sat 2:00 PM | Engineering done | A real Claude Code agent goes through the whole scenario: b is woken, fixes its own code, the check turns green, and the dashboard shows it live |
| Sat 2:00 to 7:00 PM | Benchmark and demo rehearsals | At least 5 full runs recorded |
| Sat 8:00 PM | Code freeze | Bug fixes only after this |
| Sat night | Backup video recorded; numbers go into the slides and Devpost | The video plays from its final link |
| Sun 7:00 AM | Final check | Every link and repo opens for someone outside the team |
| Sun 8:30 AM | Submit | |

## Engineering (A, with Claude Code)

- [x] Dashboard live mode: the browser signs in with the dashboard laptop's `spacetime login` and shows real data
- [x] Human review: when a fix changes tests, a person clicks Accept or Send back on the dashboard (or runs `npm run review`). Send back wakes the fixer with the note.
- [ ] Rehearsal script: one command sets up two demo clones (a and b) with hooks and starts the watcher. The local database part is done: `npm run local-db`
- [ ] **Real run with Claude Code**: two VS Code windows play a and b, following the scenario. b must fix its own code, keep the tests as they are, and turn the check green. This is our biggest risk.
- [ ] Factory API key in `.env` on the watcher laptop, and Droid writes a real explanation once (we need this for the Factory track)
- [x] The wake message includes the teammate's plan, so b knows why a changed the code

## Database (C, Catherine)

- [ ] Deploy the module from the `integration` branch to maincloud. It's missing `resolve_conflict_if_current`, `set_explanation_if_current` and `review_test_change`, so conflicts can't resolve on the team database yet.
- [ ] Grant editor to every teammate's identity, plus the watcher's
- [ ] Reset steps everyone can run between rehearsals

## Every teammate's laptop

- [ ] SpacetimeDB CLI 2.13 installed, `spacetime login` done
- [ ] Public identity (`spacetime login show`, never `--token`) sent to Catherine and granted
- [ ] Demo repo cloned (github.com/chuddrw/CalHacks26-Demo) and `npm run install-hooks -- --demo <clone> --name <your letter>` run
- [ ] `npm run doctor -- --demo <clone>` says "ready"

## Benchmark

- [ ] Decide what we measure. Suggested:
  - time to red: a's edit until the combined check fails
  - time to wake: a's edit until b's agent is woken (about 3.5 s in tests)
  - time to green: b's wake until the check passes again
  - success rate: out of N runs, how often b fixes it correctly without touching the tests
- [ ] Optional baseline: the same scenario without Agent Cowork. Each side is green alone, and the bug only shows up once both land on main.
- [ ] Results go in the Measurement log in `pitch/demo-runbook.md`
- Needs: the rehearsal script, so runs can be repeated quickly

## Demo

- [ ] Whose laptop plays a, whose plays b, and which screen shows the dashboard
- [ ] How we reset before each run
- [ ] The 3-minute script matches real timings
- [ ] Plan B if Wi-Fi or maincloud fails: run on the local database, or play the backup video
- [ ] Q&A practice (`pitch/qa.md`)

## Slides

- [ ] Only claims we've verified (tick through the Evidence gates in `pitch/submission-checklist.md`)
- [ ] Real numbers and screenshots from real runs, never the `?demo` data
- [ ] Architecture slide with the roles: the watcher detects and picks the fixer, b's own agent fixes its code, Droid explains why
- [ ] One slide each for SpacetimeDB and Factory Droid: what they do in our system

## Submission

- [ ] Team names, tagline, both repo links, video link, table number
- [ ] Both repos are visible to judges
- [ ] Decide which branch judges see. The finished code is on `integration`, and `main` is still the skeleton.
- [ ] No `.env` or tokens committed
- [ ] Open the submitted Devpost page and click every link
