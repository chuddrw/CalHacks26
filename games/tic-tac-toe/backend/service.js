import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createBoard, placeMark } from './game.js';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function token() { return randomBytes(24).toString('hex'); }

export function createGameService({ now = Date.now, lifetimeMs = 60 * 60 * 1000, maxGames = 1000 } = {}) {
  const games = new Map();

  function cleanExpired() {
    const time = now();
    for (const [id, game] of games) if (time >= game.expiresAt) games.delete(id);
  }

  function find(id) {
    const game = games.get(id);
    if (!game) throw new ApiError(404, 'Game not found.');
    if (now() >= game.expiresAt) { games.delete(id); throw new ApiError(410, 'Game expired.'); }
    return game;
  }

  function authenticate(game, supplied) {
    if (typeof supplied !== 'string') throw new ApiError(401, 'A player token is required.');
    for (const mark of ['X', 'O']) {
      const expected = game.tokens[mark];
      if (expected && Buffer.byteLength(supplied) === Buffer.byteLength(expected)
        && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return mark;
    }
    throw new ApiError(401, 'Invalid player token.');
  }

  function publicGame(game) {
    return {
      id: game.id, board: [...game.board], status: game.status,
      currentPlayer: game.status === 'playing' && game.players.O ? game.currentPlayer : null,
      winner: game.winner, winningLine: [...game.winningLine], players: { ...game.players },
      createdAt: game.createdAt, updatedAt: game.updatedAt, expiresAt: game.expiresAt,
    };
  }

  return {
    createGame(playerName) {
      cleanExpired();
      if (games.size >= maxGames) throw new ApiError(503, 'Too many active games. Try again later.');
      const name = validateName(playerName);
      const createdAt = now();
      const game = {
        id: randomUUID(), board: createBoard(), status: 'waiting', currentPlayer: 'X',
        winner: null, winningLine: [], players: { X: name, O: null },
        tokens: { X: token(), O: null }, createdAt, updatedAt: createdAt,
        expiresAt: createdAt + lifetimeMs,
      };
      games.set(game.id, game);
      return { game: publicGame(game), player: 'X', token: game.tokens.X };
    },

    joinGame(id, playerName) {
      const game = find(id);
      if (game.players.O) throw new ApiError(409, 'Game already has two players.');
      if (game.status !== 'waiting') throw new ApiError(409, 'Game cannot be joined.');
      game.players.O = validateName(playerName);
      game.tokens.O = token();
      game.status = 'playing';
      game.updatedAt = now();
      return { game: publicGame(game), player: 'O', token: game.tokens.O };
    },

    getGame(id) { return publicGame(find(id)); },

    move(id, suppliedToken, row, col) {
      const game = find(id);
      const mark = authenticate(game, suppliedToken);
      if (game.status !== 'playing') throw new ApiError(409, 'Game is not accepting moves.');
      if (mark !== game.currentPlayer) throw new ApiError(409, `It is ${game.currentPlayer}'s turn.`);
      let result;
      try { result = placeMark(game.board, row, col, mark); }
      catch (error) {
        throw new ApiError(error instanceof RangeError ? 400 : 409, error.message);
      }
      game.status = result.status;
      game.winner = result.winner;
      game.winningLine = result.winningLine;
      if (game.status === 'playing') game.currentPlayer = mark === 'X' ? 'O' : 'X';
      game.updatedAt = now();
      return publicGame(game);
    },

    cancelGame(id, suppliedToken) {
      const game = find(id);
      authenticate(game, suppliedToken);
      games.delete(id);
    },
  };
}

function validateName(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N} _-]{1,24}$/u.test(value.trim())) {
    throw new ApiError(400, 'Player name must be 1–24 letters, numbers, spaces, underscores or hyphens.');
  }
  return value.trim();
}
