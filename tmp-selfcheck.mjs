import * as P from './src/game/patterns.mjs';
import { createBulletSystem } from './src/game/bullets.mjs';

const degOf = (s) => Math.round((Math.atan2(s.vy, s.vx) * 180) / Math.PI);

const bs = createBulletSystem(8);
const specs = P.PATTERNS.ring({ x: 0, y: 0 }, { count: 8, speed: 6 });
console.log('ring count', specs.length, JSON.stringify(specs[0]));
console.log('spawnMany', bs.spawnMany(specs, { friendly: true }), bs.count, bs.playerCount, bs.enemyCount, bs.capacity, bs.free, bs.full);
console.log('over-capacity spawn ->', bs.spawn(specs[0]));

bs.clear();
const laser = bs.spawnLaser({ x: 10, y: 10, angle: Math.PI / 2, length: 200 }, { friendly: false });
console.log('laser phase', laser.phase, bs.laserActive(laser), laser.life);
bs.update(30);
console.log('laser @30', laser.phase, bs.laserActive(laser), JSON.stringify(bs.laserSegment(laser)));
bs.update(200);
console.log('live after long update', bs.count);

const bs2 = createBulletSystem(16);
const b = bs2.spawn(P.PATTERNS.homing({ x: 0, y: 0 }, { target: { x: 100, y: 0 }, count: 1, speed: 4, turnDeg: 4 })[0]);
const a0 = Math.atan2(b.vy, b.vx);
bs2.update(5);
console.log('homing turned', ((Math.atan2(b.vy, b.vx) - a0) * 180 / Math.PI).toFixed(3), 'deg; pos', b.x.toFixed(2), b.y.toFixed(2));
console.log('seconds form update ->', bs2.update(1 / 60), 'age', b.age);

const bs3 = createBulletSystem(8);
bs3.spawn({ x: 100, y: 100, r: 5 });
const near = { x: 100, y: 122, hitR: 2, grazeR: 18 };
console.log('near miss: hits', bs3.countEnemyHits(near), 'firstHit', !!bs3.firstEnemyHit(near), 'graze', bs3.graze(near, 18), 'again', bs3.graze(near, 18));
const touch = { x: 100, y: 100, hitR: 2, grazeR: 18 };
console.log('touch: hits', bs3.countEnemyHits(touch), 'firstHit', !!bs3.firstEnemyHit(touch), 'graze while touching', bs3.graze(touch, 18));
console.log('clearEnemy', bs3.clearEnemy(), 'count', bs3.count);

console.log('emitPattern unknown ->', P.emitPattern('nope', { x: 0, y: 0 }, { speed: 2 }).length);
console.log('spread no target:', P.PATTERNS.spread({ x: 0, y: 0 }, { count: 3, arcDeg: 20, speed: 3 }).map(degOf));
console.log('spread bearing down:', P.PATTERNS.spread({ x: 0, y: 0 }, { bearing: Math.PI / 2, count: 3, arcDeg: 20, speed: 3 }).map(degOf));
console.log('spread target down:', P.PATTERNS.spread({ x: 0, y: 0 }, { target: { x: 0, y: 100 }, count: 5, arcDeg: 40, speed: 4 }).map(degOf));
console.log('spread target right:', P.PATTERNS.spread({ x: 0, y: 0 }, { target: { x: 100, y: 0 }, count: 3, arcDeg: 30, speed: 4 }).map(degOf));
console.log('sweep walk:', [0, 2, 4, 6, 8].map((i) => degOf(P.PATTERNS.sweep({ x: 0, y: 0 }, { index: i, count: 9, arcDeg: 30, speed: 3 })[0])));
console.log('sweep burst:', P.PATTERNS.sweep({ x: 0, y: 0 }, { index: 4, count: 9, arcDeg: 30, speed: 3, burst: 3 }).map(degOf));
console.log('arc radii:', P.PATTERNS.arc({ x: 0, y: 50 }, { count: 3, radius: 60, speed: 4, facing: Math.PI }).map((s) => Math.hypot(s.x, s.y - 50).toFixed(4)));
console.log('arc headings:', P.PATTERNS.arc({ x: 0, y: 50 }, { count: 3, radius: 60, speed: 4, facing: Math.PI }).map(degOf));
console.log('arc outward:false:', P.PATTERNS.arc({ x: 0, y: 50 }, { count: 3, radius: 60, speed: 4, facing: 0, outward: false }).map(degOf));
console.log('spiral phases:', [0, 1, 2].map((i) => degOf(P.PATTERNS.spiralStep({ x: 0, y: 0 }, { index: i, count: 4, angleStepDeg: 11, speed: 4 })[0])));
console.log('ring phase 0 count 4:', P.PATTERNS.ring({ x: 0, y: 0 }, { count: 4, speed: 5, baseDeg: 0 }).map(degOf));
console.log('zero-count guards:', P.PATTERNS.ring({ x: 0, y: 0 }, { count: 0 }).length, P.PATTERNS.spread({ x: 0, y: 0 }, { count: 0 }).length, P.PATTERNS.arc({ x: 0, y: 0 }, { count: 0 }).length);
console.log('degenerate origin:', JSON.stringify(P.PATTERNS.aimed(null, {})));
console.log('determinism:', JSON.stringify(P.PATTERNS.spiralStep({ x: 3, y: 4 }, { index: 7, count: 5, speed: 4.5 })) === JSON.stringify(P.PATTERNS.spiralStep({ x: 3, y: 4 }, { index: 7, count: 5, speed: 4.5 })));
