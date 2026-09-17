import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addKill,
  advanceChain,
  basePoints,
  chainScore,
  gpsChainScore,
  gpsScore,
  initScoring,
} from '../src/game/scoring.mjs';
import { BALANCE } from '../src/game/config.mjs';
import { createEnemy } from '../src/game/enemies.mjs';

/** Fresh scoring bag with the chain economy at a cold start. */
const freshState = () => initScoring({ score: 0, lives: 3, bombs: 3, power: 1 });

test('GPS formula: 100/600/300 -> 1800', () => {
  assert.equal(chainScore([100, 600, 300]), 3 * 100 + 2 * 600 + 1 * 300);
  assert.equal(chainScore([100, 600, 300]), 1800);
});

test('GPS formula: 600/300/100 -> 2500', () => {
  assert.equal(chainScore([600, 300, 100]), 3 * 600 + 2 * 300 + 1 * 100);
  assert.equal(chainScore([600, 300, 100]), 2500);
});

test('the formula weights the earliest kill by the final chain length', () => {
  // A long chain makes the opening kill worth the most.
  assert.equal(chainScore([10]), 10);
  assert.equal(chainScore([10, 10]), 2 * 10 + 1 * 10);
  assert.equal(chainScore([10, 10, 10]), 3 * 10 + 2 * 10 + 1 * 10);
  // Order matters whenever the values differ.
  assert.notEqual(chainScore([100, 600, 300]), chainScore([600, 300, 100]));
  // An empty chain pays nothing.
  assert.equal(chainScore([]), 0);
});

test('the pure formula accepts array or variadic arguments and aliases agree', () => {
  assert.equal(chainScore([100, 600, 300]), chainScore(100, 600, 300));
  assert.equal(gpsChainScore([100, 600, 300]), 1800);
  assert.equal(gpsScore([600, 300, 100]), 2500);
});

test('addKill banks the GPS total for 100/600/300 -> 1800', () => {
  const state = freshState();
  addKill(state, { points: 100 });
  addKill(state, { points: 600 });
  addKill(state, { points: 300 });
  assert.equal(state.chain, 3);
  assert.equal(state.score, 1800, 'score must equal the GPS chain total');
});

test('addKill banks the GPS total for 600/300/100 -> 2500', () => {
  const state = freshState();
  addKill(state, { points: 600 });
  addKill(state, { points: 300 });
  addKill(state, { points: 100 });
  assert.equal(state.chain, 3);
  assert.equal(state.score, 2500, 'score must equal the GPS chain total');
});

test('the incremental payouts telescope to the pure formula', () => {
  const state = freshState();
  const paid = [100, 600, 300].map((points) => addKill(state, { points }));
  // Each kill re-pays the running sum of base values seen so far.
  assert.deepEqual(paid, [100, 700, 1000]);
  assert.equal(paid.reduce((a, b) => a + b, 0), chainScore([100, 600, 300]));
  assert.equal(state.score, 1800);
});

test('every enemy carries a mandatory positive base value', () => {
  for (const kind of ['popcorn', 'grunt', 'turret', 'heavy', 'midboss', 'boss', 'unknown-archetype']) {
    const e = createEnemy(kind, 100, 100);
    assert.ok(Number.isFinite(e.points), `${kind} must have a finite base value`);
    assert.ok(e.points >= 1, `${kind} base value must be positive (got ${e.points})`);
    assert.ok(basePoints(e) >= 1, `${kind} basePoints must be positive`);
  }
  // Explicit zero / garbage overrides are floored, never allowed to pay nothing.
  assert.equal(basePoints({ points: 0 }), 1);
  assert.equal(basePoints({ points: -50 }), 1);
  assert.equal(basePoints({ points: NaN }), BALANCE.enemy.basePoints);
  assert.ok(basePoints({}) >= 1, 'a missing base value still pays');
  assert.ok(basePoints(null) >= 1, 'a missing enemy still pays');
});

test('a chain that times out resets the GPS ledger', () => {
  const state = freshState();
  addKill(state, { points: 100 });
  addKill(state, { points: 600 });
  for (let i = 0; i <= BALANCE.chainTimeout + 2; i++) advanceChain(state, 1);
  assert.equal(state.chain, 0);
  assert.deepEqual(state.chainValues, []);
  // A fresh chain must not inherit the collapsed chain's running sum.
  assert.equal(addKill(state, { points: 300 }), 300);
  assert.equal(state.chain, 1);
});
