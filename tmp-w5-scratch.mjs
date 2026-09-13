import { addKill, addGraze, addScore, tickScoring, chainMultiplier, killScore, initScoring, gainRank, dropRankOnDeath, updateRank, rankScale } from './src/game/scoring.mjs';
import { dropFor, createPickup, applyPickup, updatePickups, powerTierCount, shotsForPower, autoCollect, collectRadius, attractPickup, pickupCaught, dropChance } from './src/game/powerups.mjs';
import { createRng } from './src/core/rng.mjs';
import { BALANCE } from './src/game/config.mjs';
import assert from 'node:assert/strict';

const s = { score: 0, chain: 0, chainTimer: 0, lives: 3, bombs: 3, power: 1, rank: BALANCE.rank.start };
initScoring(s);
const ev = [];
addKill(s, { points: 500 }, ev);
assert.equal(s.chain, 1);
assert.equal(s.chainTimer, BALANCE.chainTimeout);
const first = s.score;
addKill(s, { points: 500 }, ev);
assert.equal(s.chain, 2);
assert.ok(s.score > first + 500, 'chain bonus applies');
for (let i = 0; i < BALANCE.chainTimeout + 2; i++) tickScoring(s, 1, ev);
assert.equal(s.chain, 0);
assert.equal(s.chainTimer, 0);

const s2 = { score: 0, graze: 0, chain: 0, chainTimer: 0, lives: 3, rank: BALANCE.rank.start };
initScoring(s2);
addGraze(s2, ev);
assert.equal(s2.graze, 1);
assert.equal(s2.score, BALANCE.grazeScore);
assert.ok(ev.some(e => e.type === 'graze'));

const s3 = { score: 0, lives: 3, extends: 0, nextExtend: BALANCE.extendScore, chain: 0, chainTimer: 0, rank: 0 };
initScoring(s3);
const e3 = [];
addScore(s3, BALANCE.extendScore, e3);
assert.equal(s3.lives, 4, 'extend awards life');
assert.ok(e3.some(e => e.type === 'extend'));
const s4 = { score: 0, lives: 3, extends: 0, nextExtend: BALANCE.extendScore, chain: 0, chainTimer: 0, rank: 0 };
initScoring(s4);
addScore(s4, BALANCE.extendScore * 3, []);
assert.equal(s4.lives, 6);

const s5 = { rank: 0.5 };
gainRank(s5, 5); assert.equal(s5.rank, BALANCE.rank.max);
dropRankOnDeath(s5); assert.equal(s5.rank, BALANCE.rank.max - BALANCE.rank.deathDrop);
updateRank(s5, 1);
assert.ok(s5.rank < BALANCE.rank.max - BALANCE.rank.deathDrop);
assert.ok(rankScale(s5) >= 1);

const rng = createRng(5);
let drops = 0, none = 0;
for (let i = 0; i < 400; i++) {
  const d = dropFor({ kind: 'popcorn', x: 3, y: 4 }, rng);
  if (d === null) none++; else { drops++; assert.ok(['power', 'life', 'bomb', 'score'].includes(d.kind)); assert.equal(d.x, 3); assert.equal(d.y, 4); }
}
assert.ok(drops > 0 && none > 0, `drops ${drops} none ${none}`);
assert.equal(dropFor({ kind: 'grunt' }, { chance: () => false, float: () => 0 }), null);

const st = { score: 0, lives: 3, bombs: 3, power: 1, chain: 0, chainTimer: 0, rank: 0 };
initScoring(st);
const e6 = [];
for (let i = 0; i < 20; i++) applyPickup(st, { kind: 'power', x: 1, y: 2 }, e6);
assert.equal(st.power, BALANCE.powerTiers);
applyPickup(st, { kind: 'life', x: 0, y: 0 }, e6);
assert.equal(st.lives, 4);
applyPickup(st, { kind: 'bomb', x: 0, y: 0 }, e6);
assert.equal(st.bombs, 4);
applyPickup(st, { kind: 'score', x: 0, y: 0 }, e6);
assert.equal(st.score, BALANCE.item.scoreValue);
assert.equal(applyPickup(st, { kind: 'nope' }, e6), false);
assert.ok(e6.some(e => e.type === 'powerup'));
assert.equal(powerTierCount(), BALANCE.powerTiers);
assert.equal(shotsForPower(2), 2);
assert.equal(shotsForPower(99), 4);

assert.equal(autoCollect({ y: 100, focus: false }), true);
assert.equal(autoCollect({ y: 500, focus: true }), true);
assert.equal(autoCollect({ y: 500, focus: false }), false);
assert.ok(collectRadius({ y: 100, focus: false }) > collectRadius({ y: 500, focus: false }));

const p = { x: 100, y: 200, hitR: 2 };
const item = createPickup({ kind: 'power', x: 105, y: 200 });
assert.ok(attractPickup(item, p, 1 / 60, 150));
assert.ok(item.x < 105, `magnet pulls toward player: ${item.x}`);
const caught = createPickup({ kind: 'score', x: 100, y: 200 });
assert.ok(pickupCaught(caught, p));
const list = [createPickup({ kind: 'power', x: 100, y: 200 })];
const got = updatePickups(st, list, p, 1 / 60, e6);
assert.equal(got, 1);
assert.equal(list.length, 0);
assert.ok(chainMultiplier(0) === 1);
assert.ok(killScore(100, 50) > 100);
assert.ok(dropChance({ kind: 'boss' }) === 1);
console.log('ALL SCORING/POWERUP SCRATCH CHECKS PASSED');
