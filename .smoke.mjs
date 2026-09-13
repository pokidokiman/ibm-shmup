import { createPool } from './src/core/pool.mjs';
import { createClock } from './src/core/clock.mjs';
import { createRng } from './src/core/rng.mjs';
import * as V from './src/core/vec2.mjs';
import { createInput } from './src/core/input.mjs';

let built = 0;
const p = createPool(64, () => ({ id: ++built }));
for (let i = 0; i < 5000; i++) p.acquire();
console.log('overflow storm: built=', built, 'active=', p.active.length, 'free=', p.free);
const live = [];
for (let i = 0; i < 64; i++) live.push(p.acquire());
console.log('full: built=', built, 'active=', p.active.length, 'overflow=', p.acquire(), 'cap=', p.capacity);
for (const o of live) p.release(o);
console.log('released: active=', p.active.length, 'built=', built, 'free=', p.free);
for (let i = 0; i < 200000; i++) { const o = p.acquire(); p.release(o); }
console.log('hot loop built=', built);
const z = createPool(0, () => ({}));
console.log('cap0:', z.acquire(), z.capacity, z.full);

const c = createClock();
let steps = 0;
for (let i = 0; i < 600; i++) steps += c.tick(1 / 60);
console.log('600 frames: steps=', steps, 'fps=', c.fps.toFixed(2), 'dropped=', c.dropped, 'alpha=', c.alpha.toFixed(6));
const c2 = createClock();
console.log('weird: NaN=', c2.tick(NaN), 'neg=', c2.tick(-5), 'half=', c2.tick(0.5), 'alpha=', c2.alpha.toFixed(6), 'elapsed=', c2.elapsed.toFixed(3), 'total=', c2.steps, 'maxSteps=', c2.maxSteps);
const c3 = createClock(1 / 60, 8);
let sum = 0;
for (let i = 0; i < 100; i++) sum += c3.tick(3.7);
console.log('stall stress: steps=', sum, 'frames=', c3.frames, 'dropped=', c3.dropped, 'alpha in [0,1)=', c3.alpha >= 0 && c3.alpha < 1);

const r = createRng(1234);
console.log('fork deterministic:', r.fork(7).next() === createRng(1234).fork(7).next());
let mn = 1, mx = 0;
for (let i = 0; i < 200000; i++) { const v = r.next(); if (v < mn) mn = v; if (v > mx) mx = v; }
console.log('range', mn.toFixed(8), mx.toFixed(8), 'calls', r.calls);
console.log('gauss', [0, 1, 2, 3, 4].map(() => r.gaussian().toFixed(4)).join(' '));
console.log('shuffle', r.shuffle([1, 2, 3, 4, 5]).join(''), 'reset', r.reset(1).next().toFixed(6));
console.log('bounds', r.int(5, 5), r.int(-3, -3), r.int(0, 0), 'pick', r.pick([]), r.pick([9]), r.int(2, 6), 'sign', r.sign());
console.log('chance edges', createRng(3).chance(0), createRng(3).chance(1), createRng(3).bool(0), createRng(3).chance(0.5));

const a = { x: 3, y: 4 };
console.log('vec', V.len(a), V.dist(a, { x: 0, y: 0 }), V.dot(a, a), V.cross(a, { x: 1, y: 0 }), V.angle(V.fromAngle(Math.PI / 2, 2)) - Math.PI / 2, a.x, a.y);
console.log('vec extras', V.limit({ x: 10, y: 0 }, 4).x, V.rotateAround({ x: 2, y: 0 }, { x: 0, y: 0 }, Math.PI).x.toFixed(6), V.wrapAngle(-1).toFixed(4), V.angleDiff(3, -3).toFixed(4), V.lerpVec({ x: 0, y: 0 }, { x: 2, y: 2 }, 0.5).x, V.clamp(9, 0, 1), V.isZero({ x: 0, y: 0 }), V.equals(a, { x: 3, y: 4 }), V.norm({ x: 0, y: 0 }).x);

const inp = createInput();
inp.key('ShiftRight', true);
inp.key('a', true);
inp.key('ArrowUp', true);
console.log('input state', JSON.stringify(inp.snapshot()), 'edges', inp.pressed('focus'), inp.pressed('left'), inp.pressed('up'), inp.pressed('up'));
inp.key('a', false);
console.log('axis', JSON.stringify(inp.axis()), 'released', inp.released('left'), inp.released('left'));
inp.pointerDown(0, 11, 22);
console.log('pointer fire', inp.snapshot().fire, 'ptr', inp.pointer.x, inp.pointer.y, 'bomb edge', inp.pressed('bomb'));
inp.pointerDown(2);
console.log('bomb edge', inp.pressed('bomb'), 'up', inp.pointerUp(2), 'bomb released', inp.released('bomb'));
inp.set('down', true);
console.log('override', inp.snapshot().down, 'anyHeld', inp.anyHeld());
inp.clear();
console.log('cleared', JSON.stringify(inp.snapshot()), 'axis', JSON.stringify(inp.axis()));
const detached = inp.attach(null);
detached();
console.log('attach(null) safe');
