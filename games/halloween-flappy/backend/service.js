import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GAME_CONFIG, replayGame } from './game.js';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function createGameService({ dataFile, now = Date.now } = {}) {
  const runs = new Map();
  const lifetimeMs = 30 * 60 * 1000;
  let leaderboard = [];
  let writes = Promise.resolve();

  function validEntry(row) {
    return row && typeof row === 'object' && !Array.isArray(row)
      && typeof row.id === 'string' && /^[a-f0-9-]{36}$/.test(row.id)
      && typeof row.playerName === 'string'
      && /^[\p{L}\p{N} _-]{1,24}$/u.test(row.playerName)
      && row.playerName === row.playerName.trim()
      && Number.isSafeInteger(row.score) && row.score >= 0
      && Number.isSafeInteger(row.durationTicks)
      && row.durationTicks >= 1 && row.durationTicks <= GAME_CONFIG.maxTicks
      && Number.isSafeInteger(row.completedAt) && row.completedAt >= 0;
  }

  if (dataFile) {
    try {
      leaderboard = JSON.parse(await readFile(dataFile, 'utf8'));
      if (!Array.isArray(leaderboard) || leaderboard.length > 100
        || leaderboard.some(row => !validEntry(row))
        || new Set(leaderboard.map(row => row.id)).size !== leaderboard.length) {
        throw new Error('Invalid leaderboard file.');
      }
      leaderboard = rank(leaderboard);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function rank(rows) {
    return [...rows].sort((a, b) => b.score - a.score || a.completedAt - b.completedAt || a.id.localeCompare(b.id));
  }

  function save(entry) {
    const operation = writes.then(async () => {
      const next = rank([...leaderboard, entry]).slice(0, 100);
      if (dataFile) {
        await mkdir(path.dirname(dataFile), { recursive: true });
        const temporary = `${dataFile}.tmp`;
        await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
        await rename(temporary, dataFile);
      }
      leaderboard = next;
      return next.findIndex(row => row.id === entry.id) + 1 || null;
    });
    writes = operation.catch(() => {});
    return operation;
  }

  function authorize(id, token) {
    const run = runs.get(id);
    if (!run) throw new ApiError(404, 'Run not found. Start a new game.');
    if (typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(run.token)
      || !timingSafeEqual(Buffer.from(token), Buffer.from(run.token))) {
      throw new ApiError(401, 'Invalid run token.');
    }
    if (now() >= run.expiresAt) throw new ApiError(410, 'Run expired. Start a new game.');
    if (run.status !== 'playing') throw new ApiError(409, 'This run is already being submitted or has finished.');
    return run;
  }

  return {
    startRun() {
      for (const [id, run] of runs) if (now() >= run.expiresAt) runs.delete(id);
      if (runs.size >= 1000) throw new ApiError(503, 'Too many active runs. Try again later.');
      const startedAt = now();
      const run = {
        id: randomUUID(), token: randomBytes(24).toString('hex'),
        seed: randomBytes(4).readUInt32LE(), startedAt,
        expiresAt: startedAt + lifetimeMs, status: 'playing',
      };
      runs.set(run.id, run);
      return { runId: run.id, token: run.token, seed: run.seed, startedAt,
        expiresAt: run.expiresAt, config: GAME_CONFIG };
    },
    async finishRun(id, token, body) {
      const run = authorize(id, token);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Expected a JSON object.');
      const { playerName, flaps, ticks } = body;
      if (typeof playerName !== 'string' || !/^[\p{L}\p{N} _-]{1,24}$/u.test(playerName.trim())) {
        throw new ApiError(400, 'Player name must be 1–24 letters, numbers, spaces, underscores or hyphens.');
      }
      if (!Number.isInteger(ticks) || ticks < 1 || ticks > GAME_CONFIG.maxTicks) {
        throw new ApiError(400, `ticks must be an integer between 1 and ${GAME_CONFIG.maxTicks}.`);
      }
      if (!Array.isArray(flaps) || flaps.length > 10000 || flaps.some((tick, index) =>
        !Number.isInteger(tick) || tick < 0 || tick >= ticks || (index > 0 && tick <= flaps[index - 1]))) {
        throw new ApiError(400, 'flaps must contain strictly increasing, zero-based tick numbers before ticks.');
      }
      if (ticks > Math.floor((now() - run.startedAt) * GAME_CONFIG.tickRate / 1000) + 120) {
        throw new ApiError(422, 'Replay runs ahead of elapsed real time.');
      }
      const result = replayGame(run.seed, flaps, ticks);
      if (!result.over || result.tick !== ticks) throw new ApiError(422, 'Replay must stop at the exact game-over tick.');
      run.status = 'submitting';
      try {
        const entry = { id: run.id, playerName: playerName.trim(), score: result.score,
          durationTicks: ticks, completedAt: now() };
        const rank = await save(entry);
        run.status = 'finished';
        return { ...entry, rank };
      } catch (error) {
        run.status = 'playing';
        throw error;
      }
    },
    cancelRun(id, token) {
      authorize(id, token);
      runs.delete(id);
    },
    getLeaderboard(limit = 10) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'limit must be between 1 and 100.');
      return rank(leaderboard).slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
    },
  };
}
