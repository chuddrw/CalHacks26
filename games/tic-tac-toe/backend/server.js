import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, createGameService } from './service.js';

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'Use Content-Type: application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16 * 1024) { req.resume(); throw new ApiError(413, 'Request body is too large.'); }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new ApiError(400, 'Expected a valid JSON object.'); }
}

export function createServer(service, { allowedOrigins = [], mutationLimit = 90, now = Date.now } = {}) {
  const clients = new Map();
  function limit(req, res) {
    const time = now();
    const key = req.socket.remoteAddress || 'unknown';
    let bucket = clients.get(key);
    if (!bucket || time >= bucket.resetAt) {
      bucket = { count: 0, resetAt: time + 60_000 };
      clients.set(key, bucket);
    }
    bucket.count++;
    res.setHeader('RateLimit-Limit', String(mutationLimit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, mutationLimit - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > mutationLimit) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - time) / 1000))));
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    if (clients.size > 10_000) for (const [client, value] of clients) {
      if (time >= value.resetAt) clients.delete(client);
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
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, { status: 'ok', game: 'tic-tac-toe' });
      }
      if (req.method === 'POST' && url.pathname === '/api/games') {
        limit(req, res);
        return send(201, service.createGame((await readJson(req)).playerName));
      }
      const gameMatch = /^\/api\/games\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && gameMatch) return send(200, { game: service.getGame(gameMatch[1]) });
      if (req.method === 'DELETE' && gameMatch) {
        limit(req, res);
        service.cancelGame(gameMatch[1], bearer(req));
        res.writeHead(204); res.end(); return;
      }
      const joinMatch = /^\/api\/games\/([a-f0-9-]{36})\/join$/.exec(url.pathname);
      if (req.method === 'POST' && joinMatch) {
        limit(req, res);
        return send(200, service.joinGame(joinMatch[1], (await readJson(req)).playerName));
      }
      const moveMatch = /^\/api\/games\/([a-f0-9-]{36})\/moves$/.exec(url.pathname);
      if (req.method === 'POST' && moveMatch) {
        limit(req, res);
        const body = await readJson(req);
        return send(200, { game: service.move(moveMatch[1], bearer(req), body.row, body.col) });
      }
      throw new ApiError(404, 'Endpoint not found.');
    } catch (error) {
      if (!res.headersSent) send(error instanceof ApiError ? error.status : 500,
        { error: error instanceof ApiError ? error.message : 'Could not complete the request.' });
      else res.end();
    }
  });
}

function bearer(req) {
  return /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization ?? '')?.[1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const mutationLimit = Number(process.env.MUTATION_RATE_LIMIT || 90);
  if (!Number.isSafeInteger(mutationLimit) || mutationLimit < 1) throw new Error('MUTATION_RATE_LIMIT must be positive.');
  const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(value => value.trim()).filter(Boolean);
  const server = createServer(createGameService(), { allowedOrigins, mutationLimit });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on('error', error => { console.error(`Backend could not start (${error.code || 'server error'}).`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Tic-tac-toe backend: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
