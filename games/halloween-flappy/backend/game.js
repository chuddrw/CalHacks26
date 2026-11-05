// Browser-compatible deterministic physics. Render however you like; advance exactly 60 ticks/s.
export const GAME_CONFIG = Object.freeze({
  version: 1,
  theme: 'halloween',
  character: 'bat',
  obstacle: 'haunted-pillars',
  collectible: 'candy',
  tickRate: 60,
  width: 360,
  height: 640,
  groundY: 600,
  birdX: 90,
  birdRadius: 12,
  gravity: 0.36,
  flapVelocity: -6.5,
  obstacleSpeed: 2.5,
  obstacleWidth: 60,
  obstacleGap: 180,
  spawnEveryTicks: 100,
  maxTicks: 18000,
});

function random(state) {
  state.rng = (state.rng + 0x6D2B79F5) >>> 0;
  let value = state.rng;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

export function createGame(seed) {
  return { tick: 0, y: 280, velocity: 0, score: 0, over: false, rng: seed >>> 0, obstacles: [] };
}

export function stepGame(state, flap = false) {
  if (state.over) return state;
  const c = GAME_CONFIG;
  if (state.tick % c.spawnEveryTicks === 0) {
    state.obstacles.push({ x: c.width + 40, gapY: 150 + Math.floor(random(state) * 300), passed: false });
  }
  if (flap) state.velocity = c.flapVelocity;
  state.velocity += c.gravity;
  state.y += state.velocity;
  for (const obstacle of state.obstacles) obstacle.x -= c.obstacleSpeed;

  const hitBoundary = state.y - c.birdRadius <= 0 || state.y + c.birdRadius >= c.groundY;
  const hitObstacle = state.obstacles.some(obstacle => {
    // Circle against either rectangular pillar, including corner collisions.
    const closestX = Math.max(obstacle.x, Math.min(c.birdX, obstacle.x + c.obstacleWidth));
    const gapTop = obstacle.gapY - c.obstacleGap / 2;
    const gapBottom = obstacle.gapY + c.obstacleGap / 2;
    const topY = Math.max(0, Math.min(state.y, gapTop));
    const bottomY = Math.max(gapBottom, Math.min(state.y, c.groundY));
    return (c.birdX - closestX) ** 2 + (state.y - topY) ** 2 <= c.birdRadius ** 2
      || (c.birdX - closestX) ** 2 + (state.y - bottomY) ** 2 <= c.birdRadius ** 2;
  });
  state.tick++;
  state.over = hitBoundary || hitObstacle || state.tick >= c.maxTicks;
  if (!hitBoundary && !hitObstacle) {
    for (const obstacle of state.obstacles) {
      if (!obstacle.passed && obstacle.x + c.obstacleWidth < c.birdX - c.birdRadius) {
        obstacle.passed = true;
        state.score++;
      }
    }
  }
  state.obstacles = state.obstacles.filter(obstacle => obstacle.x + c.obstacleWidth >= 0);
  return state;
}

export function replayGame(seed, flaps, ticks) {
  const state = createGame(seed);
  let next = 0;
  while (state.tick < ticks && !state.over) {
    const flap = flaps[next] === state.tick;
    if (flap) next++;
    stepGame(state, flap);
  }
  return state;
}
