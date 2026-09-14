import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/core/rng.mjs';
import * as V from '../src/core/vec2.mjs';
import { createPool } from '../src/core/pool.mjs';
import { createClock } from '../src/core/clock.mjs';
import { createInput } from '../src/core/input.mjs';

test('rng is deterministic for a seed and stays in range', () => {
  const a = createRng(1234);
  const b = createRng(1234);
  const seqA = Array.from({ length: 8 }, () => a.next());
  const seqB = Array.from({ length: 8 }, () => b.next());
  assert.deepEqual(seqA, seqB, 'same seed must replay identically');
  assert.notDeepEqual(seqA, Array.from({ length: 8 }, () => createRng(99).next()));
  const r = createRng(7);
  for (let i = 0; i < 500; i++) {
    const f = r.float(-3, 5);
    assert.ok(f >= -3 && f <= 5, `float out of range: ${f}`);
    const n = r.int(2, 6);
    assert.ok(Number.isInteger(n) && n >= 2 && n <= 6, `int out of range: ${n}`);
  }
  assert.equal(r.pick(['x']), 'x');
  assert.equal(r.chance(0), false);
  assert.equal(r.chance(1), true);
});

test('vec2 math is correct and non-mutating', () => {
  const a = { x: 3, y: 4 };
  assert.equal(V.len(a), 5);
  assert.equal(V.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x, 4);
  assert.deepEqual(a, { x: 3, y: 4 }, 'inputs must not be mutated');
  const n = V.norm(a);
  assert.ok(Math.abs(V.len(n) - 1) < 1e-9);
  assert.equal(V.dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(V.lerp(0, 10, 0.25), 2.5);
  assert.equal(V.approach(0, 10, 3), 3);
  assert.equal(V.approach(0, 10, 99), 10);
  const v = V.fromAngle(0, 5);
  assert.ok(Math.abs(v.x - 5) < 1e-9 && Math.abs(v.y) < 1e-9);
  assert.ok(Math.abs(V.angle({ x: 0, y: -1 }) - -Math.PI / 2) < 1e-9);
});

test('pool reuses objects and never allocates past capacity', () => {
  let built = 0;
  const pool = createPool(3, () => ({ id: ++built, live: false }));
  const got = [pool.acquire(), pool.acquire(), pool.acquire()];
  assert.equal(pool.capacity, 3);
  assert.equal(pool.active.length, 3);
  assert.equal(pool.acquire(), null, 'over-capacity acquire returns null');
  pool.release(got[0]);
  assert.equal(pool.active.length, 2);
  const again = pool.acquire();
  assert.equal(built, 4, 'factory must not run again while a slot is free');
  assert.ok(again, 'released slot is reusable');
  for (const o of got.slice(1)) pool.release(o);
  pool.release(again);
  assert.equal(pool.active.length, 0);
});

test('clock advances in fixed steps and clamps catch-up', () => {
  const c = createClock(1 / 120, 8);
  assert.equal(c.tick(1 / 120), 1);
  assert.equal(c.tick(1 / 60), 2);
  assert.ok(c.tick(10) <= 8, 'a huge stall must be clamped, not simulated as thousands of steps');
  assert.equal(c.tick(0), 0);
});

test('input maps keys to actions with edge detection', () => {
  const inp = createInput();
  inp.key('ArrowLeft', true);
  assert.equal(inp.snapshot().left, true);
  assert.equal(inp.pressed('left'), true, 'first frame of a press is an edge');
  assert.equal(inp.pressed('left'), false, 'edge fires once');
  inp.key('ArrowLeft', false);
  assert.equal(inp.snapshot().left, false);
  inp.key('KeyZ', true);
  inp.key('ShiftLeft', true);
  inp.key('KeyX', true);
  const s = inp.snapshot();
  assert.equal(s.fire, true);
  assert.equal(s.focus, true);
  assert.equal(s.bomb, true);
  for (const a of ['up', 'down', 'left', 'right', 'fire', 'bomb', 'focus']) {
    assert.ok(a in s, `snapshot must carry action ${a}`);
  }
});
