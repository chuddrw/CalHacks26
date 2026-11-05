# Live-run protocol (what is still needed for real evidence)

The offline bench cannot drive Claude Code. Do these by hand, or with a driver on a machine that has `claude`.

1. Conditions: `plain-git` and `orchestrated` (add `shared-context` if time allows).
2. Tasks (planned in `bench/recorded/tasks.json`): units-change, rename-field, independent-feature (a control with no real conflict).
3. Trials: 5 per task and condition. Same model, same starting repo, same prompt text. Alternate which condition goes first.
4. Per run, save `bench/recorded/<condition>/<task>/<trial>.json`:
   `{ "wallMs": 0, "humanPrompts": 0, "tokens": 0, "costUsd": 0, "hiddenTestPass": true }`
   hiddenTestPass = a test the agents never saw, run on the final integrated result.
5. Freeze the tasks and the hidden tests BEFORE the first run. Then `node bench/run-matrix.ts --trials 1 && node bench/report.ts bench/results/latest.json`.
6. Report n on every number. The README's Flappy Bird comparison (2 vs 9 prompts) has no run files in this repo; treat it as an anecdote until it is recorded here.
