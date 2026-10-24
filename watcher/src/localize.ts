/**
 * watcher/src/localize.ts
 *
 * WHAT IT'S FOR
 *   When the full check (main + everyone's snapshot) is red, this finds out WHO clashes with WHOM.
 *   It tests each snapshot alone and then in pairs, and returns one failure per culprit set.
 *   This is the technical core of the project: speculative merging of uncommitted work.
 *
 * OWNER: B. WHEN: Sat 14:00-19:00.
 * DONE WHEN: on the demo scenario it returns exactly one failure, { kind: "pair", agents: [a, b] },
 *            in under 15 s, with 1-2 new check runs thanks to the cache.
 *
 * ALGORITHM
 *   input: main sha, latest snapshots S = { agent: sha }, and the red full-check outcome
 *   1. Singles: for each agent, check main + S[agent]. Red means { kind: "self", agents: [agent] }.
 *   2. Candidates = agents that are green alone.
 *   3. Pairs: for each pair of candidates, check main + S[a] + S[b]. If mergeInto() fails, that's
 *      { kind: "merge", agents: [a, b], files }. If the check is red, that's { kind: "pair", agents: [a, b] }.
 *   4. If nothing so far explains the red full check (it takes 3 or more snapshots together):
 *      report the two most recent pushers as a pair, with the full check's error and the note
 *      "needs 3+ changes together". Rare; don't spend time on it.
 *
 * CACHE
 *   Key every result by runKey(shas) from shared/src/schema.ts. A sha never changes content, so
 *   cached results never expire while the watcher runs. With 4 agents that's at most 4 singles plus
 *   6 pairs, and usually only 1-3 new runs per snapshot.
 *
 * SPEED
 *   Run up to 3 checks at once, one per pooled worktree (git.ts). Report each check_run row as it
 *   finishes, so the UI timeline moves.
 */

// TODO (B): the algorithm above.
export {};
