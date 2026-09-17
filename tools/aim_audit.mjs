// Measure how "aimed at the ship" the danmaku is, headlessly.
import { createGame } from '../src/game/game.mjs';

const g = createGame({ seed: 0x1badb002, stage: 1 });
const B = g.bullets;
console.log('bullets api:', B && typeof B === 'object' ? Object.keys(B).slice(0, 14).join(',') : String(B));

function liveBullets() {
  for (const k of ['items', 'active', 'list', 'all', 'pool', 'bullets']) {
    const v = B && B[k];
    if (Array.isArray(v)) return v.filter(b => b && b.alive !== false);
    if (v && Array.isArray(v.items)) return v.items.filter(b => b && b.alive !== false);
  }
  return [];
}

const DEG = 180 / Math.PI;
let frames = 0, seen = 0, aimed = 0, maxAlive = 0, deathFrame = -1;
const p = g.player;
for (let f = 0; f < 60 * 120; f++) {          // 120 s of play at the sim cadence
  g.step(1 / 60);
  frames++;
  const list = liveBullets();
  maxAlive = Math.max(maxAlive, list.length);
  for (const b of list) {
    const vx = Number.isFinite(b.vx) ? b.vx : 0, vy = Number.isFinite(b.vy) ? b.vy : 0;
    if (vx === 0 && vy === 0) continue;
    const toShip = Math.atan2(p.y - b.y, p.x - b.x) * DEG;
    const heading = Math.atan2(vy, vx) * DEG;
    let d = Math.abs(((toShip - heading + 540) % 360) - 180);
    seen++;
    if (d < 15) aimed++;
  }
  if (g.state.gameOver && deathFrame < 0) deathFrame = f;
  if (deathFrame > 0) break;
}
console.log(`bullets sampled        : ${seen}`);
console.log(`aimed at the ship (<15°): ${seen ? (100 * aimed / seen).toFixed(1) : '0'}%`);
console.log(`peak bullets on screen : ${maxAlive}`);
console.log(`survived (no input)    : ${deathFrame < 0 ? frames + ' frames (still alive)' : (deathFrame / 60).toFixed(1) + 's'}   score ${g.state.score}`);
