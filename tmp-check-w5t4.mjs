import { createPlayer } from './src/game/player.mjs';
import { circlesHit, createGrid, grazeBand } from './src/game/collision.mjs';

const p = createPlayer();
console.log('spawn', p.x, p.y, 'field', p.field.width, p.field.height, 'hitR', p.hitR, 'grazeR', p.grazeR, 'invuln', p.invuln, 'lives', p.lives, 'bombs', p.bombs, 'power', p.power);
let x0 = p.x;
p.update(1 / 60, { right: true });
console.log('dx normal', p.x - x0, 'speed', p.speed);
x0 = p.x;
p.update(1 / 60, { right: true, focus: true });
console.log('dx focus', p.x - x0, 'speed', p.speed, 'focus', p.focus);
x0 = p.x;
p.update(1 / 60, {});
console.log('dx idle', p.x - x0, 'focus', p.focus);
let shots = 0;
const sigs = [];
for (let i = 0; i < 60; i++) {
  const s = p.fire();
  if (s) { shots++; sigs.push(i + ':' + s.streams + ':' + s.muzzles.length); }
  p.update(1 / 60, { fire: true });
}
console.log('shots/60f', shots, sigs.slice(0, 6).join(' '));
p.addPower(3);
console.log('power', p.power, 'muzzles tier4', JSON.stringify(p.muzzles()));
console.log('hurt1', p.hurt(), 'lives', p.lives, 'invuln', p.invuln, 'power', p.power, 'pos', p.x.toFixed(1), p.y.toFixed(1));
console.log('hurt2 (invuln)', p.hurt(), 'lives', p.lives);
console.log('bomb', p.useBomb(), 'bombs', p.bombs, 'invuln', p.invuln);
console.log('hitbox', p.hitbox(), 'touches-self', p.touches(p.x, p.y, 1), 'grazes@19', p.grazes(p.x + 19, p.y, 1), 'grazes@5', p.grazes(p.x + 5, p.y, 1));

// game over path
const q = createPlayer({ lives: 0, bombs: 0 });
console.log('lives0 hurt', q.hurt(), 'lives', q.lives, 'alive', q.alive, 'respawnTimer', q.respawnTimer);
q.update(1 / 60, {});
console.log('after update alive', q.alive, 'lives', q.lives);
q.addLives(1);
q.update(1 / 60, {});
console.log('after revive', q.lives, q.alive, q.invuln);

// clamp
const c = createPlayer();
c.moveTo(-500, -500);
console.log('clamped min', c.x, c.y);
c.moveTo(99999, 99999);
console.log('clamped max', c.x, c.y);

// grid
const g = createGrid(64);
for (let i = 0; i < 50; i++) g.insert({ x: i * 10, y: 0, r: 2, id: i });
const q1 = g.query(100, 0, 10);
console.log('grid query', q1.length, q1.map((o) => o.id).join(','), 'size', g.size, 'cell', g.cell);
console.log('grid hits', g.hits(100, 0, 10).map((o) => o.id).join(','));
const ob = { x: 100, y: 0, r: 2, id: 'rm' };
g.insert(ob);
console.log('insert rm size', g.size, 'remove', g.remove(ob), 'size', g.size, 'remove again', g.remove(ob));
g.insert(ob);
g.insert(ob);
console.log('double insert size', g.size, 'query has rm', g.query(100, 0, 1).some((o) => o.id === 'rm'));
g.clear();
console.log('cleared size', g.size, 'query', g.query(100, 0, 10).length);

console.log('circlesHit touching', circlesHit(0, 0, 2, 3, 0, 2), 'apart', circlesHit(0, 0, 2, 5, 0, 2), 'nan', circlesHit(0, 0, NaN, 0, 0, NaN));
console.log('grazeBand inside-band', grazeBand({ x: 0, y: 0, hitR: 2 }, 18, 15, 0, 1), 'touching', grazeBand({ x: 0, y: 0, hitR: 2 }, 18, 2, 0, 1), 'far', grazeBand({ x: 0, y: 0, hitR: 2 }, 18, 100, 0, 1));

// perf sanity
const t0 = process.hrtime.bigint();
const big = createGrid(64);
for (let i = 0; i < 2000; i++) big.insert({ x: (i * 13) % 1024, y: (i * 29) % 768, r: 5 });
let n = 0;
for (let i = 0; i < 5000; i++) n += big.query((i * 7) % 1024, (i * 11) % 768, 40).length;
console.log('grid perf queries', n, Number(process.hrtime.bigint() - t0) / 1e6, 'ms');
