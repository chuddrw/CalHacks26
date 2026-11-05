# Recorded live runs (stubs)

The harness cannot drive Claude Code sessions. To include live results, run a task by hand (or with
your own driver) under each condition and save one file per run:

    bench/recorded/<condition>/<task>/<trial>.json     condition: plain-git | shared-context | orchestrated

    { "wallMs": 0, "humanPrompts": 0, "tokens": 0, "costUsd": 0, "hiddenTestPass": true }

List the planned runs in `bench/recorded/tasks.json` as `{ "tasks": ["flappy-bird"], "trials": 5 }`.
Planned runs without a file show up as "missing" and are excluded from medians. There is no recorded
data in this repo; the README's Flappy Bird numbers have no run files here.
