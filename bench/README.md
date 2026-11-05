# bench/

Offline evals for Orkio. Run from the repo root (Node 24, no build step). Nothing here edits files
outside `bench/`.

| What | Command |
|---|---|
| Score the contract rule (no LLM) against 23 labeled requests | `node bench/planner-golden/run-rules.ts` |
| Score plans a real planner produced | `node bench/planner-golden/score-plans.ts plans.json` |
| Seeded integration bugs: merge + tsc + vitest per scenario | `node bench/seeded-bugs/run.ts [--json] [--only id,id]` (~20 s, needs `demo-app/node_modules`) |
| Full matrix (conditions x tasks x trials) to JSON | `node bench/run-matrix.ts --trials 5 [--out bench/results/latest.json]` |
| Medians/spread as markdown | `node bench/report.ts bench/results/latest.json` |
| All tests | `node --test bench/planner-golden/planner-golden.test.ts bench/matrix.test.ts bench/seeded-bugs/seeded-bugs.test.ts` |

## What each part measures
- **planner-golden**: owner, reviewer and conflict precision/recall (micro-averaged) and major-change accuracy. `run-rules.ts` feeds a naive file-ownership draft through `orchestrator/src/rules.ts` using the real import graph of `demo-app/`; it scores only major and reviewers, because owners and conflicts come from the model.
- **seeded-bugs**: 8 scenarios (units, renamed field, changed return behavior, changed default, renamed export, a latent bug only a hidden test finds, a real merge conflict, a benign control). Each agent's edits are green alone. A hidden test, invisible to the checks, is the ground truth for "the integrated result works".
- **run-matrix / report**: the three conditions (plain-git, shared-context, orchestrated) over the seeded scenarios, plus any recorded live runs (`recorded/README.md`) with wall time, prompts, tokens, cost and hidden-test pass.

## Honest limits
- The golden labels were written by hand from the contract rule's own policy (any shared-contract or foreign-file edit is major). 100% on `run-rules.ts` is a regression test, not independent validation. Owner and conflict labels are meant for scoring an LLM planner, which this repo does not run automatically.
- The seeded-bug conditions are **verification-layer proxies**, not live agents: plain-git = merge conflicts only; shared-context = plus tsc on the combined tree; orchestrated = plus the visible tests. Scenarios were written knowing which layer would catch them, and in most of them agent B ships a test, so "orchestrated" depends on the tests existing. Eight scenarios on one small app say little about real repos.
- Offline rows have no wall time, prompts, tokens or cost. Those fields come only from recorded runs, and none are recorded here.
- Results are deterministic, so extra `--trials` mainly show harness-time noise.
