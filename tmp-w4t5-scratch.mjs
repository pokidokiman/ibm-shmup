import { initScoring, addKill, addGraze, addScore, tickScoring, chainMultiplier, rankScale, dropRankOnDeath } from './src/game/scoring.mjs';
import { dropFor, createPickup, applyPickup, collectRadius, updatePickups, shotsForPower, powerTierCount } from './src/game/powerups.mjs';
import { createRng } from './src/core/rng.mjs';
import { BALANCE } from './src/game/config.mjs';

const s = { lives: 3, bombs: 3, power: 1, score: 0, events: [] };
initScoring(s);
console.log('init', JSON.stringify(s));
console.log('mult', chainMultiplier(0).toFixed(3), chainMultiplier(50).toFixed(3), chainMultiplier(9999).toFixed(3));
addGraze(s);
console.log('graze ->', s.graze, s.score, 'rank', s.rank.toFixed(5));
addKill(s, { kind: 'grunt', points: 500, x: 1, y: 2 });
console.log('kill -> chain', s.chain, 'timer', s.chainTimer, 'score', s.score, 'rank', s.rank.toFixed(5));
for (let i = 0; i < BALANCE.chainTimeout + 2; i++) tickScoring(s, 1);
console.log('timeout -> chain', s.chain, 'rank', s.rank.toFixed(5), 'events', s.events.map((e) => e.type).join(','));
const before = s.lives;
s.score = 0;
s.nextExtend = BALANCE.extendScore;
addScore(s, BALANCE.extendScore * 3.5);
console.log('extends -> lives', s.lives, 'was', before, 'extends', s.extends, 'nextExtend', s.nextExtend, 'extendEvents', s.events.filter((e) => e.type === 'extend').length);
addScore(s, BALANCE.extendScore * 20);
console.log('extend cap -> lives', s.lives, 'extends', s.extends);
console.log('rankScale', rankScale(s).toFixed(4), 'dropDeath', dropRankOnDeath(s).toFixed(4));

const rng = createRng(5);
let drops = 0;
let none = 0;
const kinds = {};
for (let i = 0; i < 400; i++) {
  const d = dropFor({ kind: 'popcorn', x: 0, y: 0 }, rng);
  if (d === null) none++;
  else { drops++; kinds[d.kind] = (kinds[d.kind] || 0) + 1; }
}
console.log('drops', drops, 'none', none, JSON.stringify(kinds));
console.log('boss drop', JSON.stringify(dropFor({ kind: 'boss', x: 9, y: 8 }, createRng(1))));
console.log('zero chance', dropFor({ kind: 'popcorn', drop: 0, x: 0, y: 0 }, createRng(1)));
console.log('no-rng drop', JSON.stringify(dropFor({ kind: 'turret', x: 3, y: 4 })));

const g = { lives: 3, bombs: 3, power: 1, score: 0, events: [] };
initScoring(g);
for (let i = 0; i < 20; i++) applyPickup(g, { kind: 'power', x: 0, y: 0 });
console.log('power cap', g.power, 'tiers', powerTierCount(), 'shots@4', shotsForPower(g.power));
applyPickup(g, { kind: 'life', x: 0, y: 0 });
for (let i = 0; i < 30; i++) applyPickup(g, { kind: 'bomb', x: 0, y: 0 });
applyPickup(g, { kind: 'score', x: 0, y: 0 });
console.log('lives', g.lives, 'bombs', g.bombs, 'score', g.score, 'events', g.events.map((e) => e.type + ':' + (e.kind || '')).join(','));
console.log('unknown kind ->', applyPickup(g, { kind: 'wat', x: 0, y: 0 }));

const player = { x: 500, y: 400, hitR: 2, focus: false };
const list = [createPickup({ kind: 'power', x: 505, y: 400 })];
updatePickups(g, list, player, 1 / 60, null);
console.log('caught at once -> remaining', list.length);
const far = [createPickup({ kind: 'score', x: 500, y: 100 })];
console.log('collectRadius normal/focus/top', collectRadius(player), collectRadius({ ...player, focus: true }), collectRadius({ ...player, y: 100 }));
for (let i = 0; i < 600; i++) updatePickups(g, far, { ...player, y: 700 }, 1 / 60, null);
console.log('expired away ->', far.length);
const pull = [createPickup({ kind: 'score', x: 640, y: 400 })];
let collected = 0;
for (let i = 0; i < 400; i++) collected += updatePickups(g, pull, player, 1 / 60, null);
console.log('magnet -> remaining', pull.length, 'collected', collected);
