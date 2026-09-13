import { createStage, countEvents, BAR_FRAMES, EMPTY_EVENTS } from './src/game/waves.mjs';
import { createEnemy, enemySpec, ENEMY_SCRIPTS, scriptFor, framesOf, enemyFire } from './src/game/enemies.mjs';
import { BALANCE, ENEMY_TABLE } from './src/game/config.mjs';

// object form + out-of-range clamping
for (const arg of [1, 2, 3, 9, 0, -3, { stage: 2 }, { stage: 1, durationFrames: 600, density: 2 }]) {
  const s = createStage(arg);
  console.log('stage arg', JSON.stringify(arg), '->', s.stage, s.name, s.durationFrames, 'events', countEvents(s), 'bossFrame', s.bossFrame, 'midbossFrame', s.midbossFrame);
}

const s = createStage(1, { seed: 5 });
console.log('same frame identity:', s.at(120) === s.at(120), 'empty identity:', s.at(-1) === EMPTY_EVENTS, s.at(999999) === EMPTY_EVENTS);
console.log('progress/marks:', s.progress(0), s.progress(s.durationFrames), s.bossDue(s.bossFrame), s.midbossActive(s.midbossFrame), s.remaining(s.durationFrames - 10));
console.log('frameAt:', s.frameAt(0), s.frameAt(1), s.frameAt(0.5), 'barFrames', BAR_FRAMES, 'bars', s.bars, 'spawnInterval', s.spawnInterval);
console.log('marks', JSON.stringify(s.marks));
console.log('first waves', JSON.stringify(s.waves.slice(0, 3)));

// stress: run every event through createEnemy across several stages, watch for NaN
for (const stageNo of [1, 2, 3]) {
  const st = createStage(stageNo, { seed: 11 });
  const ctx = { player: { x: 512, y: 704 }, rank: 1, bullets: [], onKill() {}, onHit() {}, onEnemyShot() {} };
  const live = [];
  let bad = 0;
  let fired = 0;
  for (let f = 0; f < st.durationFrames; f++) {
    for (const ev of st.at(f)) {
      const e = createEnemy(ev.type, ev.x, ev.y, ev.opts);
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.hp)) bad++;
      live.push(e);
    }
    for (const e of live) {
      if (!e.active) continue;
      ctx.bullets.length = 0;
      ctx.rank = (f % 600) / 600;
      e.update(1 / 60, ctx);
      for (const b of ctx.bullets) if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.vx) || !Number.isFinite(b.vy)) bad++;
      fired += ctx.bullets.length;
    }
  }
  const alive = live.filter((e) => e.active).length;
  console.log(`stage ${stageNo}: events ${live.length} alive ${alive} bad ${bad} bullets ${fired}`);
}

// framesOf / script fallbacks / spec fallbacks
console.log('framesOf:', framesOf(1 / 60), framesOf(1), framesOf(0.5), framesOf(2), framesOf(-1), framesOf(undefined));
console.log('scriptFor unknown === dive:', scriptFor('zzz') === ENEMY_SCRIPTS.dive, Object.keys(ENEMY_SCRIPTS).length);
console.log('enemySpec unknown === grunt row:', enemySpec('zzz') === ENEMY_TABLE.grunt);
console.log('fire with no pattern:', enemyFire(createEnemy('popcorn', 10, 10, {}), {}));
const t = createEnemy('turret', 512, 100, {});
console.log('turret fire specs:', enemyFire(t, { player: { x: 512, y: 700 }, rank: 0 }));
const t2 = createEnemy('turret', 512, 100, {});
t2.bullets = [];
console.log('fire into ctx.bullets:', enemyFire(t2, { player: { x: 100, y: 700 }, bullets: [] }), t2.volley);

// pooling reuse: no allocation semantics preserved by reset
const reused = createEnemy('grunt', 0, 0, {});
const id = reused;
reused.reset('heavy', 200, -48, { hp: 7 });
console.log('reuse identity', reused === id, reused.kind, reused.hp, reused.maxHp, reused.scriptFn === ENEMY_SCRIPTS.crossHold, reused.active, reused.volley, reused.t);

// hitbox + advance guards
const g = createEnemy('grunt', 5, 6, {});
console.log('hitbox', JSON.stringify(g.hitbox()), 'advance(0) t', g.advance(0).t, 'update(0.5) t', g.update(0.5).t);

// despawn is not a scoring kill
const d = createEnemy('popcorn', 10, 10, {});
let kills = 0; let despawns = 0;
d.kill({ onKill: () => kills++ });
d.despawn({ onDespawn: () => despawns++ });
console.log('kill then despawn:', kills, despawns, d.dead, d.removed, d.active);

// offscreen retire
const off = createEnemy('popcorn', 10, BALANCE.field.despawnY + 10, {});
off.update(1 / 60, {});
console.log('offscreen retired:', off.active, off.removed, off.dead);
