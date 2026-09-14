import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/game/game.mjs';
import { circlesHit, createGrid } from '../src/game/collision.mjs';
import { addKill, addGraze } from '../src/game/scoring.mjs';
import { dropFor } from '../src/game/powerups.mjs';
import { createStage } from '../src/game/waves.mjs';
import { createBoss } from '../src/game/boss.mjs';
import { BALANCE } from '../src/game/config.mjs';
import { createRng } from '../src/core/rng.mjs';

const drive = (frames, mutate) => {
  const g = createGame({ seed: 42, stage: 1 });
  for (let i = 0; i < frames; i++) {
    if (mutate) mutate(g, i);
    g.step(1 / 60);
  }
  return g;
};

test('the same seed and input trace replay identically', () => {
  const trace = (g, i) => {
    g.input.left = Math.sin(i / 20) > 0;
    g.input.right = Math.sin(i / 20) < 0;
    g.input.fire = true;
  };
  const a = drive(600, trace);
  const b = drive(600, trace);
  assert.equal(a.state.score, b.state.score, 'score must be deterministic');
  assert.equal(a.state.frame, b.state.frame);
  assert.equal(a.player.x.toFixed(6), b.player.x.toFixed(6), 'player path must be deterministic');
  assert.ok(a.state.score > 0, 'shooting enemies must score points');
});

test('firing produces shots and respects cadence', () => {
  const g = drive(60, (gg) => { gg.input.fire = true; });
  const shots = g.events.filter((e) => e.type === 'shot');
  assert.ok(shots.length > 0, 'held fire must emit shot events');
  assert.ok(shots.length <= 60, 'cadence must gate the fire rate');
});

test('the player never leaves the playfield and loses a life with invulnerability', () => {
  const g = drive(240, (gg, i) => { gg.input.left = i < 120; gg.input.right = i >= 120; });
  assert.ok(g.player.x >= 0 && g.player.x <= BALANCE.field.width, `x escaped: ${g.player.x}`);
  const before = g.state.lives;
  g.events.length = 0;
  g.hurt();
  assert.equal(g.state.lives, before - 1, 'taking a hit costs a life');
  assert.ok(g.player.invuln > 0, 'a hit grants invulnerability frames');
  const lost = g.state.lives;
  g.hurt();
  assert.equal(g.state.lives, lost, 'invulnerable player cannot be hit again');
});

test('kills build a chain that expires', () => {
  const g = createGame({ seed: 1, stage: 1 });
  g.spawnEnemy('grunt', 100, 100, { hp: 1 });
  const e = g.enemies[0];
  g.killEnemy(e);
  assert.equal(g.state.chain, 1);
  g.killEnemy(g.spawnEnemy('grunt', 120, 100, { hp: 1 }));
  assert.equal(g.state.chain, 2);
  for (let i = 0; i <= BALANCE.chainTimeout + 2; i++) g.step(1 / 60);
  assert.equal(g.state.chain, 0, 'chain must expire after chainTimeout frames');
});

test('powerups climb the tier ladder but never overflow', () => {
  const g = createGame({ seed: 1, stage: 1 });
  for (let i = 0; i < 20; i++) g.collectPowerup({ kind: 'power', x: 0, y: 0 });
  assert.equal(g.state.power, BALANCE.powerTiers, 'power caps at the top tier');
  const lives = g.state.lives;
  g.collectPowerup({ kind: 'life', x: 0, y: 0 });
  assert.equal(g.state.lives, lives + 1);
  const bombs = g.state.bombs;
  g.collectPowerup({ kind: 'bomb', x: 0, y: 0 });
  assert.equal(g.state.bombs, bombs + 1);
});

test('crossing the extend threshold awards a life', () => {
  const g = createGame({ seed: 1, stage: 1 });
  const before = g.state.lives;
  g.addScore(BALANCE.extendScore);
  assert.equal(g.state.lives, before + 1, 'extend at extendScore');
});

test('bosses have multiple phases and announce transitions', () => {
  const b = createBoss({ stage: 1 });
  assert.ok(b.phases.length >= 3, 'at least three attack phases');
  assert.equal(b.phase, 0);
  const g = createGame({ seed: 1, stage: 1 });
  g.spawnBoss(1);
  assert.equal(g.state.bossActive, true);
  const hp = g.boss.maxHp;
  g.events.length = 0;
  g.boss.damage(hp);           // total destruction must walk every phase, not teleport
  assert.ok(g.boss.phase > 0, 'damage advances phases');
  assert.ok(g.events.some((e) => e.type === 'bossPhase'), 'phase changes are announced');
});

test('collision primitives are exact', () => {
  assert.equal(circlesHit(0, 0, 2, 3, 0, 2), true);
  assert.equal(circlesHit(0, 0, 2, 5, 0, 2), false);
  const grid = createGrid(64);
  for (let i = 0; i < 50; i++) grid.insert({ x: i * 10, y: 0, r: 2, id: i });
  const hit = grid.query(100, 0, 10);
  assert.ok(hit.length >= 1 && hit.length < 50, 'broadphase narrows the candidate set');
  assert.ok(hit.some((o) => o.id === 10));
});

test('scoring helpers behave', () => {
  const g = createGame({ seed: 1, stage: 1 });
  const s0 = g.state.score;
  addGraze(g.state);
  assert.ok(g.state.score > s0);
  assert.equal(g.state.graze, 1);
  addKill(g.state, { x: 0, y: 0, points: 500 });
  assert.ok(g.state.score >= s0 + 500);
});

test('drops come from the table and can be empty', () => {
  const rng = createRng(5);
  let drops = 0;
  let none = 0;
  for (let i = 0; i < 400; i++) {
    const d = dropFor({ kind: 'popcorn', x: 0, y: 0 }, rng);
    if (d === null) none++;
    else {
      drops++;
      assert.ok(['power', 'life', 'bomb', 'score'].includes(d.kind));
      assert.equal(typeof d.x, 'number');
    }
  }
  assert.ok(drops > 0, 'some enemies must drop');
  assert.ok(none > 0, 'not every kill drops');
});

test('a stage schedules continuous pressure with a midboss and a boss', () => {
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
  assert.ok(enemies >= 40, `a stage must stay busy (got ${enemies} enemies)`);
  assert.equal(midboss, 1);
  assert.equal(boss, 1);
  const quiet = [];
  for (let f = 0; f < stage.durationFrames; f += 60) if (stage.at(f).length === 0) quiet.push(f);
  assert.ok(quiet.length < 30, 'no long dead air in a stage');
});

test('the simulation survives a long unattended run without exploding', () => {
  const g = createGame({ seed: 3, stage: 1 });
  for (let i = 0; i < 6000; i++) g.step(1 / 60);
  assert.ok(Number.isFinite(g.state.score));
  assert.ok(Number.isFinite(g.player.x) && Number.isFinite(g.player.y));
  assert.ok(g.state.time > 90, 'time advances');
});
