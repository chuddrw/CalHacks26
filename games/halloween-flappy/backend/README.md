# Halloween Flappy backend

Standalone Node.js 24+ backend, with no dependencies and no changes to the Orkio app or its database. Fly a bat through haunted pillars; each passed pillar awards one candy point.

```sh
cd games/halloween-flappy/backend
npm start
# http://127.0.0.1:3001
npm test
npm run check
```

The root URL is not a game page. This is the backend; use `/health` to check it is running.

## Frontend contract

- `GET /health`: server status.
- `GET /api/config`: immutable Halloween theme and physics settings.
- `POST /api/runs`: returns `{ runId, token, seed, startedAt, expiresAt, config }`. Start a new run for each attempt. Keep its bearer token in memory.
- `GET /api/game.js`: browser-compatible exports `GAME_CONFIG`, `createGame(seed)`, `stepGame(state, flap)`, and `replayGame(seed, flaps, ticks)`.
- `POST /api/runs/:runId/finish`: authenticated submission. Send `Authorization: Bearer <token>` and `Content-Type: application/json`, with `{ playerName, flaps, ticks }`.
- `DELETE /api/runs/:runId`: authenticated cancellation for an abandoned attempt. Returns 204 and never creates a leaderboard entry.
- `GET /api/leaderboard?limit=10`: `{ entries: [{ id, playerName, score, durationTicks, completedAt, rank }] }`. Limit is 1–100, default 10. Higher scores rank first; older completion timestamps break ties. One entry per run; player names are display names, not accounts.

For gameplay, use a fixed-step accumulator at 60 ticks per second, independent of rendering frame rate. Call `createGame(seed)` once, then `stepGame(state, flap)` for each tick. `stepGame` mutates the state. Before each flap, append the current `state.tick` to `flaps`. When `state.over` is true, submit `ticks: state.tick`. Render `state.y`, `state.obstacles`, and `state.score`. Flaps are zero-based, strictly increasing tick numbers. Runs also end at the five-minute limit. Pause the simulation when the page is paused; elapsed wall time is only an upper bound.

```js
const API = 'http://127.0.0.1:3001';
const run = await fetch(`${API}/api/runs`, { method: 'POST' }).then(r => r.json());
// Play using run.seed and the shared game.js engine, collecting flap ticks.
async function submitGame(playerName, flaps, ticks) {
  const response = await fetch(`${API}/api/runs/${run.runId}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${run.token}` },
    body: JSON.stringify({ playerName, flaps, ticks }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}
```

Scores are computed by server replay; client-supplied scores are ignored. Games must end at the exact collision/final tick. Replays cannot run more than two seconds ahead of elapsed real time. Invalid submissions leave the run available for correction. Concurrent/repeated submissions of the same run are rejected. This validates physics, not human input: automated players can still generate valid replays.

## Storage and configuration

The top 100 runs persist in `data/leaderboard.json` using serialized atomic file replacement. In-progress runs and their tokens live in memory, expire after 30 minutes, and are lost on server restart. This implementation supports one backend process per data file; multiple instances need a shared transactional database. Storage errors leave submissions retryable. Every persisted row, the 100-entry bound, and unique run IDs are validated at startup; corrupt data fails startup rather than being served or overwritten.

- `PORT`: defaults to `3001`; the server binds to loopback.
- `FLAPPY_DATA_FILE`: optional path to a leaderboard file.
- `CORS_ORIGINS`: comma-separated frontend origins. Defaults to `http://localhost:5173,http://127.0.0.1:5173`. For another local frontend port, include its exact origin.
- `MUTATION_RATE_LIMIT`: maximum run starts, finishes, and cancellations per client per minute. Defaults to 60. Rate-limited responses include `RateLimit-*` and `Retry-After` headers.

Responses use JSON, with errors shaped as `{ error: string }`. Status codes include 400 for invalid values/JSON, 401 for a bad run token, 403 for a disallowed origin, 404 for unknown endpoints/runs, 409 for duplicate submissions, 410 for expired runs, 413 for bodies over 128 KiB, 415 for missing JSON content type, 422 for invalid game timelines, 429 for mutation throttling, and 503 when the bounded run store is full.
