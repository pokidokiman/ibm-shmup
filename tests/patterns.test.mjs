import test from 'node:test';
import assert from 'node:assert/strict';
import { PATTERNS } from '../src/game/patterns.mjs';
import { createBulletSystem } from '../src/game/bullets.mjs';

const specOk = (s) => {
  for (const k of ['x', 'y', 'vx', 'vy', 'r', 'kind', 'speed']) {
    assert.ok(k in s, `bullet spec missing ${k}`);
  }
  assert.equal(typeof s.vx, 'number');
  assert.equal(typeof s.vy, 'number');
  assert.ok(s.r > 0);
};

test('aimed fires directly at the target', () => {
  const out = PATTERNS.aimed({ x: 0, y: 0 }, { target: { x: 0, y: 100 }, speed: 5 });
  assert.equal(out.length, 1);
  specOk(out[0]);
  assert.ok(out[0].vy > 0, 'downward toward the target');
  assert.ok(Math.abs(out[0].vx) < 1e-6);
});

test('spread fans symmetrically around the aim line', () => {
  const out = PATTERNS.spread({ x: 0, y: 0 }, { target: { x: 0, y: 100 }, count: 5, arcDeg: 40, speed: 4 });
  assert.equal(out.length, 5);
  out.forEach(specOk);
  const angles = out.map((s) => Math.atan2(s.vy, s.vx));
  assert.ok(angles[2] > angles[0], 'ordered fan');
  assert.ok(Math.abs((angles[2] - angles[0]) - (40 * Math.PI / 180)) < 1e-6, 'outer bullets span arcDeg');
  assert.ok(Math.abs(angles[0] + angles[4] + Math.PI) < 1e-6, 'symmetric about the aim line');
});

test('ring distributes over the full circle', () => {
  const out = PATTERNS.ring({ x: 10, y: 20 }, { count: 12, speed: 3 });
  assert.equal(out.length, 12);
  out.forEach(specOk);
  const angles = out.map((s) => Math.atan2(s.vy, s.vx)).sort((a, b) => a - b);
  for (let i = 1; i < angles.length; i++) {
    assert.ok(Math.abs((angles[i] - angles[i - 1]) - (Math.PI * 2 / 12)) < 1e-6, 'even angular spacing');
  }
  assert.equal(out[0].x, 10);
});

test('spiralStep rotates deterministically with the index', () => {
  const a = PATTERNS.spiralStep({ x: 0, y: 0 }, { index: 0, count: 3, angleStepDeg: 17, speed: 4 });
  const b = PATTERNS.spiralStep({ x: 0, y: 0 }, { index: 1, count: 3, angleStepDeg: 17, speed: 4 });
  assert.equal(a.length, 3);
  const aa = Math.atan2(a[0].vy, a[0].vx);
  const ba = Math.atan2(b[0].vy, b[0].vx);
  assert.ok(Math.abs(Math.abs(ba - aa) - (17 * Math.PI / 180)) < 1e-6, 'advances by angleStepDeg per index');
});

test('sweep and arc emit usable streams', () => {
  const sw = PATTERNS.sweep({ x: 0, y: 0 }, { index: 4, count: 9, arcDeg: 60, speed: 3.5 });
  assert.ok(sw.length >= 1);
  sw.forEach(specOk);
  const arc = PATTERNS.arc({ x: 0, y: 50 }, { count: 7, radius: 60, speed: 4, facing: Math.PI });
  assert.equal(arc.length, 7);
  arc.forEach(specOk);
  const dist = Math.hypot(arc[0].x - 0, arc[0].y - 50);
  assert.ok(Math.abs(dist - 60) < 1e-6, 'arc positions sit on the requested radius');
});

test('bullet system pools, advances and retires offscreen', () => {
  const bs = createBulletSystem(64);
  const specs = PATTERNS.ring({ x: 512, y: 100 }, { count: 6, speed: 6 });
  for (const s of specs) bs.spawn(s);
  assert.equal(bs.active.length, 6);
  const before = bs.active[0].y;
  bs.update(1);
  assert.ok(bs.active[0].y > before, 'bullets travel');
  bs.update(200);
  assert.equal(bs.active.length, 0, 'offscreen bullets retire back into the pool');
});
