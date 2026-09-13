import assert from 'node:assert/strict';
import { createBoss } from './src/game/boss.mjs';

// 1. shape
const b = createBoss({ stage: 1 });
assert.ok(b.phases.length >= 3, 'phases');
assert.equal(b.phase, 0);
assert.equal(b.active, true);
assert.equal(typeof b.update, 'function');
assert.equal(typeof b.damage, 'function');
assert.ok(b.maxHp > 0);
console.log('shape ok; phases', b.phases.length, 'maxHp', b.maxHp, 'names', b.phases.map((p) => p.name).join('/'));

// 2. damage via cfg.events sink (no update call first)
{
  const events = [];
  const boss = createBoss({ stage: 1, events });
  const hp = boss.maxHp;
  boss.damage(hp);
  assert.ok(boss.phase > 0, 'phase advanced');
  assert.ok(events.some((e) => e.type === 'bossPhase'), 'bossPhase emitted');
  const transitions = events.filter((e) => e.type === 'bossPhase' && e.reason === 'damage');
  assert.equal(transitions.length, boss.phases.length - 1, 'walked every phase');
  assert.ok(events.some((e) => e.type === 'enemyKilled'), 'death event');
  console.log('cfg.events ok; transitions', transitions.length, 'events', events.map((e) => e.type).join(','));
}

// 3. damage via assigned boss.events
{
  const events = [];
  const boss = createBoss({ stage: 1 });
  boss.events = events;
  boss.damage(boss.maxHp);
  assert.ok(events.some((e) => e.type === 'bossPhase'));
  console.log('boss.events ok');
}

// 4. damage via cfg.ctx.events
{
  const events = [];
  const boss = createBoss({ stage: 1, ctx: { events, player: { x: 512, y: 700 } } });
  boss.damage(boss.maxHp);
  assert.ok(events.some((e) => e.type === 'bossPhase'));
  console.log('cfg.ctx.events ok');
}

// 5. partial damage crosses exactly one gate
{
  const events = [];
  const boss = createBoss({ stage: 1, events });
  const gate = boss.phases[0].gate;
  boss.damage(boss.maxHp - gate + 1);
  assert.equal(boss.phase, 1, 'exactly one phase');
  assert.equal(events.filter((e) => e.type === 'bossPhase').length, 1);
  console.log('gate ok');
}

// 6. firing + death sequence over time
{
  const events = [];
  const bullets = [];
  const ctx = { player: { x: 512, y: 700 }, bullets, events };
  const boss = createBoss({ stage: 1, ctx, attackCooldown: 10, timeoutFrames: 600 });
  for (let i = 0; i < 900; i++) boss.update(1 / 60, ctx);
  assert.ok(bullets.length > 0, 'boss fires danmaku');
  assert.equal(boss.active, false, 'timeout ends the boss');
  assert.ok(boss.timedOut, 'timed out');
  assert.ok(events.some((e) => e.type === 'enemyHit' && e.explode), 'death explosions');
  console.log('combat ok; bullets', bullets.length, 'timedOut', boss.timedOut, 'active', boss.active);

  // every spec is finite and inside the speed band
  for (const s of bullets) {
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), 'finite spec pos');
    assert.ok(Number.isFinite(s.vx) && Number.isFinite(s.vy), 'finite spec vel');
    assert.ok(s.speed >= 3 && s.speed <= 9.5, `speed in band (${s.speed})`);
  }
  console.log('spec band ok');
}

// 7. kill sequence via time
{
  const events = [];
  const boss = createBoss({ stage: 2, events, deathFrames: 30 });
  console.log('stage2 phases', boss.phases.length, 'name', boss.name, boss.name && boss.name.length ? '' : '');
  const total = boss.maxHp;
  let dealt = 0;
  while (boss.hp > 0) dealt += boss.damage(500);
  assert.ok(boss.dying);
  for (let i = 0; i < 60; i++) boss.update(1 / 60);
  assert.equal(boss.active, false);
  assert.equal(boss.defeated, true);
  console.log('death ok; dealt', dealt, 'total', total);
}

// 8. deterministic across two identical creations
{
  const run = () => {
    const bullets = [];
    const boss = createBoss({ stage: 3, seed: 7, ctx: { player: { x: 400, y: 700 }, bullets } });
    for (let i = 0; i < 400; i++) boss.update(1 / 60);
    return bullets.map((s) => `${s.x.toFixed(3)},${s.y.toFixed(3)},${s.vx.toFixed(3)},${s.vy.toFixed(3)}`).join('|');
  };
  assert.equal(run(), run(), 'deterministic stream');
  console.log('determinism ok');
}

console.log('ALL BOSS CHECKS PASS');
