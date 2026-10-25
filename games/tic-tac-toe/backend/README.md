# Tic-tac-toe backend

A dependency-free Node.js 24+ backend for private two-player tic-tac-toe rooms.

```sh
cd games/tic-tac-toe/backend
npm test
npm start
# http://127.0.0.1:3002
```

## Game flow

1. Player X creates a game and keeps the returned token in memory.
2. Share only the game ID with Player O.
3. Player O joins and keeps their returned token in memory.
4. Each player sends moves with their own bearer token.
5. Read the public game state after moves or poll it for the other player's turn.

Player tokens are never returned by public game reads. Games are stored in memory, expire after one hour, and are lost when the server restarts.

## API

- `GET /health` → `{ status: "ok", game: "tic-tac-toe" }`
- `POST /api/games` with `{ "playerName": "Pumpkin" }` → `{ game, player: "X", token }`
- `POST /api/games/:id/join` with `{ "playerName": "Ghost" }` → `{ game, player: "O", token }`
- `GET /api/games/:id` → `{ game }`
- `POST /api/games/:id/moves` with bearer token and `{ "row": 0, "col": 2 }` → `{ game }`
- `DELETE /api/games/:id` with either bearer token → `204`

Rows and columns are zero-based integers from 0 to 2. A public game has this shape:

```json
{
  "id": "uuid",
  "board": ["X", null, null, null, "O", null, null, null, null],
  "status": "playing",
  "currentPlayer": "X",
  "winner": null,
  "winningLine": [],
  "players": { "X": "Pumpkin", "O": "Ghost" },
  "createdAt": 1000000,
  "updatedAt": 1000500,
  "expiresAt": 4600000
}
```

`status` is `waiting`, `playing`, `won`, or `draw`. `currentPlayer` is null until the second player joins and after the game ends. `winningLine` contains three flattened board indexes when a player wins.

Example move:

```js
const response = await fetch(`${API}/api/games/${gameId}/moves`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${playerToken}`,
  },
  body: JSON.stringify({ row: 0, col: 2 }),
});
const body = await response.json();
if (!response.ok) throw new Error(body.error);
```

## Safety and configuration

The backend enforces turns, rejects occupied/out-of-range squares, detects all wins and draws, caps active games at 1,000, limits request bodies to 16 KiB, and rate-limits mutations by client address. Invalid actions do not alter game state.

- `PORT`: defaults to `3002`; binds to loopback only.
- `CORS_ORIGINS`: comma-separated allowed frontend origins; defaults to local Vite on port 5173.
- `MUTATION_RATE_LIMIT`: create, join, move, and cancel requests allowed per client per minute; defaults to 90.

Errors are JSON shaped as `{ "error": "message" }` and use appropriate 4xx/5xx status codes.
