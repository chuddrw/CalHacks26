import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GAME_CONFIG, createGame, stepGame, replayGame } from '../game.js';
import { createGameService } from '../service.js';
import { createServer } from '../server.js';

function flight(seed, until = 400) {
  const state = createGame(seed);
  const flaps = [];
  while (!state.over) {
    const obstacle = state.obstacles.find(item => item.x + GAME_CONFIG.obstacleWidth >= GAME_CONFIG.birdX - GAME_CONFIG.birdRadius);
    const target = obstacle?.gapY ?? 280;
    const flap = state.tick < until && state.y > target + 12 && state.velocity >= 0;
    if (flap) flaps.push(state.tick);
    stepGame(state, flap);
  }
  return { state, flaps, ticks: state.tick };
}

async function setup(options = {}) {
  let time = 1000000;
  const service = await createGameService({ now: () => time, ...options });
  return { service, advance: ms => { time += ms; } };
}

test('seeded gameplay replays deterministically and awards one point per passed pillar', () => {
  const first = flight(42);
  assert.ok(first.state.score >= 2);
  assert.deepEqual(replayGame(42, first.flaps, first.ticks), first.state);
  assert.notDeepEqual(createGame(1), createGame(2));
  const score = first.state.score;
  stepGame(first.state, true);
  assert.equal(first.state.score, score);
  assert.equal(first.state.tick, first.ticks);
});

test('ground, ceiling and pillars end games', () => {
  assert.equal(replayGame(1, [], 500).over, true);
  const ceiling = createGame(1);
  while (!ceiling.over) stepGame(ceiling, true);
  assert.ok(ceiling.y < GAME_CONFIG.birdRadius);
  const pillar = createGame(1);
  pillar.obstacles.push({ x: 85, gapY: 450, passed: false });
  stepGame(pillar);
  assert.equal(pillar.over, true);
  assert.equal(pillar.score, 0);
});

test('new runs expose Halloween configuration and unique private submission tokens', async () => {
  const { service } = await setup();
  const a = service.startRun();
  const b = service.startRun();
  assert.equal(a.config.theme, 'halloween');
  assert.equal(a.config.character, 'bat');
  assert.notEqual(a.runId, b.runId);
  assert.notEqual(a.token, b.token);
  assert.equal(service.getLeaderboard().length, 0);
});

test('scores come from replay rather than a claimed client score, and persist across restarts', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flappy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'leaderboard.json');
  const { service, advance } = await setup({ dataFile });
  const run = service.startRun();
  const replay = flight(run.seed);
  advance(Math.ceil(replay.ticks / 60 * 1000) + 100);
  const result = await service.finishRun(run.runId, run.token, {
    playerName: 'Pumpkin', flaps: replay.flaps, ticks: replay.ticks, score: 999999,
  });
  assert.equal(result.score, replay.state.score);
  assert.equal(result.rank, 1);
  const restarted = await createGameService({ dataFile });
  assert.equal(restarted.getLeaderboard()[0].score, result.score);
  const persisted = await readFile(dataFile, 'utf8');
  assert.ok(!persisted.includes(run.token));
});

test('wrong tokens, unknown runs, expired runs and duplicate submissions are rejected', async () => {
  const { service, advance } = await setup();
  const run = service.startRun();
  const ticks = replayGame(run.seed, [], 500).tick;
  const body = { playerName: 'Ghost', flaps: [], ticks };
  await assert.rejects(service.finishRun(run.runId, 'bad', body), { status: 401 });
  await assert.rejects(service.finishRun('unknown', run.token, body), { status: 404 });
  const first = service.finishRun(run.runId, run.token, body);
  await assert.rejects(service.finishRun(run.runId, run.token, body), { status: 409 });
  await first;
  assert.equal(service.getLeaderboard().length, 1);
  const expired = service.startRun();
  advance(30 * 60 * 1000);
  await assert.rejects(service.finishRun(expired.runId, expired.token, body), { status: 410 });
});

test('authenticated cancellation removes abandoned runs without creating a score', async () => {
  const { service } = await setup();
  const run = service.startRun();
  assert.throws(() => service.cancelRun(run.runId, 'bad'), { status: 401 });
  service.cancelRun(run.runId, run.token);
  assert.equal(service.getLeaderboard().length, 0);
  assert.throws(() => service.cancelRun(run.runId, run.token), { status: 404 });
});

test('invalid names, malformed replay and unfinished or accelerated games preserve the run for retry', async () => {
  const { service } = await setup();
  const run = service.startRun();
  const ticks = replayGame(run.seed, [], 500).tick;
  const valid = { playerName: 'Bat', flaps: [], ticks };
  for (const body of [null, [], { ...valid, playerName: '<script>' }, { ...valid, playerName: ' ' },
    { ...valid, ticks: 0 }, { ...valid, ticks: 1.5 }, { ...valid, flaps: [1, 1] },
    { ...valid, flaps: [-1] }, { ...valid, flaps: [ticks] }, { ...valid, flaps: '1' }]) {
    await assert.rejects(service.finishRun(run.runId, run.token, body), { status: 400 });
  }
  await assert.rejects(service.finishRun(run.runId, run.token, { ...valid, ticks: 1 }), { status: 422 });
  await assert.rejects(service.finishRun(run.runId, run.token, { ...valid, ticks: ticks + 1 }), { status: 422 });
  await assert.rejects(service.finishRun(run.runId, run.token, { ...valid, ticks: 1000 }), /real time/);
  await service.finishRun(run.runId, run.token, valid);
  assert.equal(service.getLeaderboard().length, 1);
});

test('concurrent finishes do not lose leaderboard entries; higher scores rank first', async () => {
  const { service, advance } = await setup();
  const run = service.startRun();
  const other = service.startRun();
  const replay = flight(run.seed);
  advance(100000);
  await Promise.all([
    service.finishRun(run.runId, run.token, { playerName: 'Winner', flaps: replay.flaps, ticks: replay.ticks }),
    service.finishRun(other.runId, other.token, { playerName: 'Ghost', flaps: [], ticks: replayGame(other.seed, [], 500).tick }),
  ]);
  assert.equal(service.getLeaderboard().length, 2);
  assert.equal(service.getLeaderboard(1)[0].playerName, 'Winner');
  assert.throws(() => service.getLeaderboard(101), { status: 400 });
});

test('corrupt or inconsistent saved scores fail startup instead of serving invalid leaderboard data', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flappy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'scores.json');
  const entry = {
    id: '00000000-0000-4000-8000-000000000001', playerName: 'Pumpkin', score: 3,
    durationTicks: 240, completedAt: 1_000_000,
  };
  for (const invalid of [
    {},
    [{ ...entry, durationTicks: 0 }],
    [{ ...entry, playerName: ' <script>' }],
    [entry, { ...entry, playerName: 'Duplicate' }],
    Array.from({ length: 101 }, (_, index) => ({
      ...entry, id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    })),
  ]) {
    await writeFile(dataFile, JSON.stringify(invalid));
    await assert.rejects(createGameService({ dataFile }), /Invalid leaderboard/);
  }
});

test('a storage failure preserves the run so a corrected submission can be retried', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flappy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parent = path.join(dir, 'data');
  const { service } = await setup({ dataFile: path.join(parent, 'scores.json') });
  const run = service.startRun();
  const body = { playerName: 'Bat', flaps: [], ticks: replayGame(run.seed, [], 500).tick };
  await writeFile(parent, 'Blocks directory creation');
  await assert.rejects(service.finishRun(run.runId, run.token, body));
  assert.equal(service.getLeaderboard().length, 0);
  await rm(parent);
  await service.finishRun(run.runId, run.token, body);
  assert.equal(service.getLeaderboard().length, 1);
});

test('HTTP API supports the full game flow, CORS, errors and payload limits', async t => {
  const { service } = await setup();
  const server = createServer(service, { allowedOrigins: ['http://localhost:5173'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await (await fetch(base + '/api/config')).json()).theme, 'halloween');
  const engine = await fetch(base + '/api/game.js');
  assert.match(engine.headers.get('content-type'), /javascript/);
  assert.ok((await engine.text()).includes('stepGame'));
  const preflight = await fetch(base + '/api/runs', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal((await fetch(base + '/health', { headers: { Origin: 'https://unapproved.example' } })).status, 403);
  const created = await fetch(base + '/api/runs', { method: 'POST' });
  assert.equal(created.status, 201);
  const run = await created.json();
  const finish = base + `/api/runs/${run.runId}/finish`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${run.token}` };
  assert.equal((await fetch(finish, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(finish, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(finish, { method: 'POST', headers, body: JSON.stringify({ padding: 'x'.repeat(140000) }) })).status, 413);
  const completed = await fetch(finish, { method: 'POST', headers,
    body: JSON.stringify({ playerName: 'Ghost', flaps: [], ticks: replayGame(run.seed, [], 500).tick }) });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).score, 0);
  const entries = await (await fetch(base + '/api/leaderboard')).json();
  assert.equal(entries.entries[0].playerName, 'Ghost');
  assert.equal((await fetch(base + '/api/leaderboard?limit=0')).status, 400);
  assert.equal((await fetch(base + '/missing')).status, 404);
});

test('HTTP cancellation and mutation rate limits are enforced per client and reset', async t => {
  const { service } = await setup();
  let time = 1_000_000;
  const server = createServer(service, {
    mutationLimit: 2, mutationWindowMs: 1000, now: () => time,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(base + '/api/runs', { method: 'POST' });
  const run = await created.json();
  const cancelled = await fetch(base + `/api/runs/${run.runId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${run.token}` },
  });
  assert.equal(cancelled.status, 204);
  assert.equal(cancelled.headers.get('ratelimit-remaining'), '0');
  const limited = await fetch(base + '/api/runs', { method: 'POST' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '1');
  assert.match((await limited.json()).error, /Too many/);
  time += 1000;
  assert.equal((await fetch(base + '/api/runs', { method: 'POST' })).status, 201);
});
