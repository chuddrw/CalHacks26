# Planner cost vs accuracy (one run, 23 labeled cases, 2026-11-05)

Real planner via OpenRouter on `bench/planner-golden/cases.json`, `node bench/planner-golden/run-planner.ts`.
`strong` = anthropic/claude-sonnet-5.5 only. `tiered` = anthropic/claude-haiku-5.5 first, sonnet-5.5 when the cheap plan
has a major task, a predicted conflict, or work for two or more agents.

| | strong | tiered |
|---|---|---|
| Plans produced | 23/23 | 23/23 |
| Dollars | $0.833 | **$0.474** (-43%) |
| Tokens | **416K** | 665K (+60%: escalated plans pay for both attempts) |
| Escalated to the strong model | n/a | 11 of 23 |
| Owners precision / recall | 96.9% / 77.5% | 96.8% / 75.0% |
| Reviewers precision / recall | 75.0% / 42.9% | 80.0% / 42.9% |
| Major-change accuracy | 15/23 | 15/23 |
| Conflicts recall | 0/4 | 0/4 |

## How to read this
- On these cases the two setups are indistinguishable in accuracy. Differences are one or two items, which is within run-to-run noise (one run each).
- Tiered costs fewer dollars but MORE tokens, because half the requests are planned twice. If the goal is tokens, use strong only; if it is dollars, tiered.
- These are the model's raw plans. In production rules.ts adds the contract rule (major flag, reviewers) afterwards, so the low reviewer and major scores here are not the end result.
- The planner saw a static "nothing in flight" state, so it cannot find conflicts that depend on other agents' work. Compare setups against each other, not against the absolute conflict score.
- Latency: tiered is slower on requests that escalate.
