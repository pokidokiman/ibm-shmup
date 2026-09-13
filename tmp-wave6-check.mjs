import { createStage } from './src/game/waves.mjs';
import { createEnemy } from './src/game/enemies.mjs';
import { ENEMY_TABLE } from './src/game/config.mjs';

const stage = createStage(1);
let enemies = 0;
let midboss = 0;
let boss = 0;
for (let f = 0; f < stage.durationFrames; f++) {
  for (const ev of stage.at(f)) {
    if (ev.kind === 'enemy') enemies++;
    else if (ev.kind === 'midboss') midboss++;
    else if (ev.kind === 'boss') boss++;
  }
}
console.log('enemies', enemies, 'midboss', midboss, 'boss', boss, 'duration', stage.durationFrames);
const quiet = [];
for (let f = 0; f < stage.durationFrames; f += 60) if (stage.at(f).length === 0) quiet.push(f);
console.log('quiet seconds', quiet.length, quiet.slice(0, 12));

// determinism
const a = createStage(1, { seed: 42 });
const b = createStage(1, { seed: 42 });
let same = true;
for (let f = 0; f < a.durationFrames; f++) {
  const ea = a.at(f);
  const eb = b.at(f);
  if (ea.length !== eb.length) { same = false; break; }
  for (let i = 0; i < ea.length; i++) {
    if (ea[i].type !== eb[i].type || ea[i].x !== eb[i].x || ea[i].y !== eb[i].y) { same = false; break; }
  }
}
console.log('deterministic same seed:', same);
const c = createStage(1, { seed: 43 });
let diff = false;
for (let f = 0; f < c.durationFrames; f++) if (c.at(f).length !== a.at(f).length) { diff = true; break; }
console.log('different seed differs:', diff);

// drive every scheduled enemy event through createEnemy for a while, with a fake ctx
for (const stageNo of [1, 2, 3]) {
  const s = createStage(stageNo, { seed: 7 });
  const ctx = { player: { x: 512, y: 700 }, rank: 0.5, bullets: [], onKill() {}, onHit() {} };
  let live = 0;
  let fired = 0;
  const spawned = [];
  for (let f = 0; f < s.durationFrames; f++) {
    for (const ev of s.at(f)) {
      if (ev.kind === 'boss') continue;
      const e = createEnemy(ev.type, ev.x, ev.y, ev.opts);
      spawned.push(e);
      live++;
    }
    for (const e of spawned) {
      if (!e.active) continue;
      ctx.bullets.length = 0;
      e.update(1 / 60, ctx);
      if (ctx.bullets.length) fired += ctx.bullets.length;
    }
  }
  const alive = spawned.filter((e) => e.active).length;
  console.log(`stage ${stageNo}: spawned ${spawned.length}, still active ${alive}, bullets fired ${fired}`);
}

// unknown kind fallback + pool-ish reuse
const e = createEnemy('nope', 10, 20, {});
console.log('unknown kind ->', e.kind, e.hp, e.r, e.script, e.active);
e.reset('turret', 100, 30);
console.log('reset ->', e.kind, e.hp, e.script, e.active, e.x, e.y);

// damage / kill semantics
const g = createEnemy('grunt', 10, 20, { hp: 3 });
console.log('damage 1 ->', g.damage(1), 'hp', g.hp, 'flash', g.flash);
console.log('damage 5 ->', g.damage(5), 'active', g.active, 'dead', g.dead, 'alive', g.alive);

// ENEMY_TABLE coverage: every kind is buildable
for (const k of Object.keys(ENEMY_TABLE)) {
  const x = createEnemy(k, 512, -48, {});
  console.log('kind', k, x.hp, x.r, x.script, x.pattern, x.points);
}
