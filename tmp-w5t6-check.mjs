import { createStage, countEvents } from './src/game/waves.mjs';
import { createEnemy, ENEMY_KINDS } from './src/game/enemies.mjs';

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
const quiet = [];
for (let f = 0; f < stage.durationFrames; f += 60) if (stage.at(f).length === 0) quiet.push(f);
console.log('enemies', enemies, 'midboss', midboss, 'boss', boss, 'quiet', quiet.length, 'countEvents', countEvents(stage));

const s2 = createStage(1);
let same = true;
for (let f = 0; f < stage.durationFrames; f++) {
  const a = stage.at(f);
  const b = s2.at(f);
  if (a.length !== b.length) { same = false; break; }
  for (let i = 0; i < a.length; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) { same = false; break; }
}
console.log('deterministic replay of schedule:', same);

const specs = [];
const ctx = { player: { x: 512, y: 600 }, rank: 0.3, fireBullets: (s) => specs.push(...s) };
const evs = [];
for (let f = 0; f < 900; f++) for (const ev of stage.at(f)) if (ev.kind === 'enemy') evs.push(ev);
console.log('enemies in first 15s:', evs.length, 'kinds:', ENEMY_KINDS.join(','));
const e = createEnemy(evs[0].type, evs[0].x, evs[0].y, evs[0].opts);
for (let f = 0; f < 600; f++) e.update(1 / 60, ctx);
console.log('enemy after 600f:', e.x.toFixed(1), e.y.toFixed(1), 'active', e.active, 'bullets', specs.length, 'hp', e.hp, 'offscreen', typeof e.offscreen());
