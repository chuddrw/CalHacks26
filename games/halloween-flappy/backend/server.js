import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_CONFIG } from './game.js';
import { ApiError, createGameService } from './service.js';

const directory = path.dirname(fileURLToPath(import.meta.url));

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'Use Content-Type: application/json.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 128 * 1024) { req.resume(); throw new ApiError(413, 'Request body is too large.'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Invalid JSON body.'); }
}

export function createServer(service, {
  allowedOrigins = [], now = Date.now, mutationLimit = 60, mutationWindowMs = 60_000,
} = {}) {
  const clients = new Map();
  function rateLimit(req, res) {
    if (!Number.isSafeInteger(mutationLimit) || mutationLimit < 1
      || !Number.isSafeInteger(mutationWindowMs) || mutationWindowMs < 1) return;
    const key = req.socket.remoteAddress || 'unknown';
    const current = now();
    let bucket = clients.get(key);
    if (!bucket || current >= bucket.resetAt) {
      bucket = { count: 0, resetAt: current + mutationWindowMs };
      clients.set(key, bucket);
    }
    bucket.count++;
    res.setHeader('RateLimit-Limit', String(mutationLimit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, mutationLimit - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > mutationLimit) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - current) / 1000))));
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    // Keep the limiter bounded even if many transient clients connect.
    if (clients.size > 10_000) for (const [client, value] of clients) {
      if (current >= value.resetAt) clients.delete(client);
    }
  }
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    try {
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Vary', 'Origin');
        if (!allowedOrigins.includes(origin)) throw new ApiError(403, 'Origin is not allowed.');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok', game: 'halloween-flappy' });
      if (req.method === 'GET' && url.pathname === '/api/config') return send(200, GAME_CONFIG);
      if (req.method === 'GET' && url.pathname === '/api/game.js') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.writeHead(200); res.end(await readFile(new URL('./game.js', import.meta.url), 'utf8')); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
        return send(200, { entries: service.getLeaderboard(url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 10) });
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        rateLimit(req, res);
        return send(201, service.startRun());
      }
      const runMatch = /^\/api\/runs\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (req.method === 'DELETE' && runMatch) {
        rateLimit(req, res);
        const token = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization ?? '')?.[1];
        service.cancelRun(runMatch[1], token);
        res.writeHead(204); res.end(); return;
      }
      const match = /^\/api\/runs\/([a-f0-9-]{36})\/finish$/.exec(url.pathname);
      if (req.method === 'POST' && match) {
        rateLimit(req, res);
        const token = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization ?? '')?.[1];
        return send(200, await service.finishRun(match[1], token, await readJson(req)));
      }
      throw new ApiError(404, 'Endpoint not found.');
    } catch (error) {
      if (!res.headersSent) send(error instanceof ApiError ? error.status : 500,
        { error: error instanceof ApiError ? error.message : 'Could not complete the request. Try again.' });
      else res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const service = await createGameService({ dataFile: process.env.FLAPPY_DATA_FILE || path.join(directory, 'data', 'leaderboard.json') });
  const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(value => value.trim()).filter(Boolean);
  const mutationLimit = Number(process.env.MUTATION_RATE_LIMIT || 60);
  if (!Number.isSafeInteger(mutationLimit) || mutationLimit < 1) throw new Error('MUTATION_RATE_LIMIT must be a positive integer.');
  const server = createServer(service, { allowedOrigins, mutationLimit });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('error', error => { console.error(`Backend could not start (${error.code || 'server error'}).`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Halloween Flappy backend: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
