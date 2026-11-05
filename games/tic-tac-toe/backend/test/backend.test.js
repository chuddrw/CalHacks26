import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard, evaluateBoard, placeMark } from '../game.js';
import { createGameService } from '../service.js';
import { createServer } from '../server.js';

function setup(options = {}) {
  let time = 1_000_000;
  return { service: createGameService({ now: () => time, ...options }), advance: ms => { time += ms; } };
}

test('board rules detect rows, columns, diagonals, draws and occupied squares', () => {
  for (const indexes of [[0, 1, 2], [0, 3, 6], [0, 4, 8], [2, 4, 6]]) {
    const board = createBoard();
    for (const index of indexes) board[index] = 'X';
    assert.deepEqual(evaluateBoard(board), { status: 'won', winner: 'X', winningLine: indexes });
  }
  assert.equal(evaluateBoard(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']).status, 'draw');
  const board = createBoard();
  placeMark(board, 1, 2, 'O');
  assert.equal(board[5], 'O');
  assert.throws(() => placeMark(board, 1, 2, 'X'), /occupied/);
  assert.throws(() => placeMark(board, 3, 0, 'X'), RangeError);
});

test('players create, join and play a winning game without exposing tokens in public state', () => {
  const { service } = setup();
  const x = service.createGame('Pumpkin');
  assert.equal(x.game.status, 'waiting');
  assert.equal(x.game.currentPlayer, null);
  assert.equal('tokens' in x.game, false);
  const o = service.joinGame(x.game.id, 'Ghost');
  assert.equal(o.game.status, 'playing');
  assert.notEqual(x.token, o.token);
  for (const [token, row, col] of [
    [x.token, 0, 0], [o.token, 1, 0], [x.token, 0, 1], [o.token, 1, 1], [x.token, 0, 2],
  ]) service.move(x.game.id, token, row, col);
  const game = service.getGame(x.game.id);
  assert.equal(game.status, 'won');
  assert.equal(game.winner, 'X');
  assert.deepEqual(game.winningLine, [0, 1, 2]);
});

test('invalid names, unauthorized actions, wrong turns and duplicate squares are rejected', () => {
  const { service } = setup();
  assert.throws(() => service.createGame('<script>'), { status: 400 });
  const x = service.createGame('X Player');
  assert.throws(() => service.move(x.game.id, x.token, 0, 0), { status: 409 });
  const o = service.joinGame(x.game.id, 'O Player');
  assert.throws(() => service.joinGame(x.game.id, 'Third'), { status: 409 });
  assert.throws(() => service.move(x.game.id, 'bad', 0, 0), { status: 401 });
  assert.throws(() => service.move(x.game.id, o.token, 0, 0), { status: 409 });
  service.move(x.game.id, x.token, 0, 0);
  assert.throws(() => service.move(x.game.id, o.token, 0, 0), { status: 409 });
  assert.throws(() => service.move(x.game.id, o.token, 3, 0), { status: 400 });
});

test('games expire, capacity is reclaimed, and authenticated cancellation removes a game', () => {
  const { service, advance } = setup({ lifetimeMs: 1000, maxGames: 1 });
  const game = service.createGame('Bat');
  assert.throws(() => service.createGame('Ghost'), { status: 503 });
  assert.throws(() => service.cancelGame(game.game.id, 'bad'), { status: 401 });
  advance(1000);
  assert.throws(() => service.getGame(game.game.id), { status: 410 });
  const replacement = service.createGame('Ghost');
  service.cancelGame(replacement.game.id, replacement.token);
  assert.throws(() => service.getGame(replacement.game.id), { status: 404 });
});

test('HTTP API supports create, join, moves, reads, cancellation, CORS and errors', async t => {
  const { service } = setup();
  const server = createServer(service, { allowedOrigins: ['http://localhost:5173'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/api/games', { method: 'POST' })).status, 415);
  const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };
  const createdResponse = await fetch(base + '/api/games', {
    method: 'POST', headers, body: JSON.stringify({ playerName: 'Pumpkin' }),
  });
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const x = await createdResponse.json();
  const joined = await (await fetch(`${base}/api/games/${x.game.id}/join`, {
    method: 'POST', headers, body: JSON.stringify({ playerName: 'Ghost' }),
  })).json();
  const moved = await fetch(`${base}/api/games/${x.game.id}/moves`, {
    method: 'POST', headers: { ...headers, Authorization: `Bearer ${x.token}` },
    body: JSON.stringify({ row: 1, col: 1 }),
  });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).game.board[4], 'X');
  assert.equal((await fetch(`${base}/api/games/${x.game.id}`)).status, 200);
  assert.equal((await fetch(`${base}/api/games/${x.game.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${joined.token}` },
  })).status, 204);
  assert.equal((await fetch(`${base}/api/games/${x.game.id}`)).status, 404);
  assert.equal((await fetch(base + '/health', { headers: { Origin: 'https://blocked.example' } })).status, 403);
});

test('HTTP mutation rate limiting resets after one minute', async t => {
  const { service } = setup();
  let time = 0;
  const server = createServer(service, { mutationLimit: 1, now: () => time });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = () => fetch(base + '/api/games', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"playerName":"Bat"}',
  });
  assert.equal((await request()).status, 201);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  time = 60_000;
  assert.equal((await request()).status, 201);
});
