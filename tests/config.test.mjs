import test from 'node:test';
import assert from 'node:assert/strict';
import { BALANCE, POWERUP_TABLE, STAGE_TABLE } from '../src/game/config.mjs';

test('player balance is tight and fast', () => {
  assert.ok(Math.abs(BALANCE.player.speed - 4.2) <= 0.3, `speed ${BALANCE.player.speed}`);
  assert.ok(Math.abs(BALANCE.player.focusSpeed - 1.9) <= 0.3, `focusSpeed ${BALANCE.player.focusSpeed}`);
  assert.equal(BALANCE.player.hitR, 2);
  assert.ok(BALANCE.player.lives >= 2 && BALANCE.player.lives <= 5);
  assert.ok(BALANCE.player.bombs >= 1);
});

test('danmaku speeds span a readable range', () => {
  assert.ok(BALANCE.bullets.enemyMinSpeed >= 2.5);
  assert.ok(BALANCE.bullets.enemyMaxSpeed <= 10);
  assert.ok(BALANCE.bullets.playerSpeed > BALANCE.bullets.enemyMinSpeed);
});

test('scoring constants match the design', () => {
  assert.equal(BALANCE.chainTimeout, 120);
  assert.equal(BALANCE.extendScore, 2000000);
  assert.ok(BALANCE.grazeScore > 0);
  assert.ok(BALANCE.scorePerHit > 0);
});

test('powerup tiers and stage table are complete', () => {
  assert.equal(BALANCE.powerTiers, 4);
  assert.equal(POWERUP_TABLE.length, 4);
  for (const t of POWERUP_TABLE) {
    assert.equal(typeof t.tier, 'number');
    assert.equal(typeof t.shots, 'number');
    assert.ok(t.shots >= 1, 'each tier fires at least one stream');
  }
  assert.ok(STAGE_TABLE.length >= 3);
  for (const s of STAGE_TABLE) {
    assert.ok(s.midbossAt > 0.3 && s.midbossAt < 0.8, `stage midboss at ${s.midbossAt}`);
    assert.ok(s.bossAt === 1 || s.bossAt > 0.85);
    assert.ok(s.durationFrames > 3000);
  }
});

test('boss has at least three phases', () => {
  assert.ok(BALANCE.bossPhases >= 3);
});
