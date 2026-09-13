/**
 * patterns.mjs — deterministic danmaku generators (Cave-style bullet curtains).
 *
 * `PATTERNS.<name>(origin, opts)` returns a *fresh array* of bullet specs — plain
 * `{ x, y, vx, vy, r, kind, speed }` records that `bullets.mjs` pools verbatim,
 * plus the handful of optional fields (`damage`, `turn`, `seekX`/`seekY`, `life`)
 * that only the generators which need them fill in.
 *
 * Conventions shared by every generator:
 *   • positions  — playfield pixels, origin at the top-left corner, +y downwards.
 *   • velocities — pixels per 60 Hz frame, the unit `config.BALANCE` is authored
 *                  in, so a spec can be stepped straight into the simulation.
 *   • bearings   — radians in the playfield frame: 0 = +x (screen right),
 *                  +PI/2 = +y (straight down the screen). When a generator is not
 *                  pointed anywhere it fires straight down, which is what an
 *                  emitter above the player wants.
 *   • `arcDeg`   — always a HALF-angle: the outermost bullet of a fan sits
 *                  `arcDeg` either side of the fan's bisector, so a generator
 *                  covers `2 * arcDeg` degrees in total.
 *
 * The generators are pure and RNG-free: identical arguments always produce an
 * identical volley, which is what keeps seeded replays bit-exact.
 *
 * Pure ES module: no DOM, no three, no timers.
 */

import { BALANCE } from './config.mjs';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const EPS = 1e-9;

/** Straight down the screen — the default bearing for every generator. */
const DOWN = HALF_PI;

/** Fallbacks used when `config.BALANCE` omits a value (keeps the module import-safe). */
const DEFAULT_R = 5;
const DEFAULT_SPEED = 3;
const DEFAULT_KIND = 'pellet';

const DEFAULT_SPREAD_COUNT = 3;
const DEFAULT_SPREAD_ARC_DEG = 12;
const DEFAULT_RING_COUNT = 12;
const DEFAULT_SPIRAL_COUNT = 6;
const DEFAULT_SPIRAL_STEP_DEG = 13;
const DEFAULT_SWEEP_COUNT = 9;
const DEFAULT_SWEEP_ARC_DEG = 30;
const DEFAULT_ARC_COUNT = 7;
const DEFAULT_ARC_RADIUS = 60;
const DEFAULT_ARC_HALF_DEG = 45;
const DEFAULT_HOMING_TURN_DEG = 1.5;

/* ------------------------------------------------------------------ helpers */

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Clamp an option into an integer count (never negative). */
const count = (v, fallback) => Math.max(0, Math.floor(num(v, fallback)));

const deg = (v, fallback = 0) => num(v, fallback) * DEG;

const bulletCfg = () => (BALANCE && typeof BALANCE === 'object' && BALANCE.bullets ? BALANCE.bullets : {});

const defaultR = () => {
  const r = num(bulletCfg().enemyR, DEFAULT_R);
  return r > 0 ? r : DEFAULT_R;
};

const defaultSpeed = (opts) => {
  const s = num(opts.speed, num(bulletCfg().enemyMinSpeed, DEFAULT_SPEED));
  return s > 0 ? s : DEFAULT_SPEED;
};

/** Normalise a plain `{ x, y }` (or anything with numeric x/y) into a safe copy. */
function point(p) {
  const src = p && typeof p === 'object' ? p : {};
  return { x: num(src.x, 0), y: num(src.y, 0) };
}

/** Wrap an angle into (-PI, PI] so generators stay on one revolution. */
function wrapPi(a) {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
}

/** Degrees -> radians for a half-angle option, never negative. */
const halfAngle = (v, fallbackDeg) => Math.abs(deg(v, fallbackDeg));

/**
 * Bearing (radians, playfield frame) from `origin` towards `target`.
 * Without a usable target this is straight down, so `PATTERNS.aimed(origin)`
 * always produces a downward shot instead of a zero-length direction.
 */
export function bearingTo(origin, target) {
  const o = point(origin);
  const t = target && typeof target === 'object' ? target : {};
  const dx = num(t.x, o.x) - o.x;
  const dy = num(t.y, o.y) - o.y;
  if (Math.hypot(dx, dy) < EPS) return DOWN;
  return Math.atan2(dy, dx);
}

/** Explicit `bearing` option wins, then the target, then straight down. */
function bearingOf(o, opts) {
  const explicit = num(opts.bearing, NaN);
  if (Number.isFinite(explicit)) return wrapPi(explicit);
  const t = opts.target;
  if (t && typeof t === 'object' && Number.isFinite(num(t.x, NaN)) && Number.isFinite(num(t.y, NaN))) {
    return bearingTo(o, t);
  }
  return DOWN;
}

/** Normalised direction towards a target (used by the straight-line generators). */
function unitTowards(o, opts) {
  const a = bearingOf(o, opts);
  return { x: Math.cos(a), y: Math.sin(a) };
}

/** Build one spec record with every field the bullet pool expects. */
function makeSpec(x, y, vx, vy, speed, opts) {
  const r = num(opts.r, defaultR());
  const spec = {
    x,
    y,
    vx,
    vy,
    r: r > 0 ? r : defaultR(),
    kind: typeof opts.kind === 'string' && opts.kind ? opts.kind : DEFAULT_KIND,
    speed,
    damage: num(opts.damage, 1),
  };
  const life = num(opts.life, NaN);
  if (Number.isFinite(life) && life > 0) spec.life = life;
  return spec;
}

/** Spec travelling along `angle` at `speed`, spawned exactly on `o`. */
const specAtAngle = (o, angle, speed, opts) =>
  makeSpec(o.x, o.y, Math.cos(angle) * speed, Math.sin(angle) * speed, speed, opts);

/** Spec travelling along the vector `(vx, vy)` at `speed`, spawned exactly on `o`. */
const specAtVelocity = (o, vx, vy, speed, opts) => makeSpec(o.x, o.y, vx, vy, speed, opts);

/* --------------------------------------------------------------- generators */

/**
 * One bullet fired straight at `target` (or along `bearing`, or straight down).
 * The workhorse enemy shot: it goes exactly where it is pointed.
 */
export function aimed(origin, opts = {}) {
  const o = point(origin);
  const speed = defaultSpeed(opts);
  const dir = unitTowards(o, opts);
  return [specAtVelocity(o, dir.x * speed, dir.y * speed, speed, opts)];
}

/**
 * An even fan of `count` bullets about a bisector, `arcDeg` either side of it.
 *
 * With a `target` the fan is laid out about the aim *line* through `origin` and
 * `target`, so a muzzle pointing straight down sweeps its fan symmetrically
 * across that line. Pass `bearing` (radians, playfield frame) to point the fan
 * somewhere explicit — `PATTERNS.bearingTo(origin, player)` fires it at the
 * player; without either option the fan hangs straight down.
 */
export function spread(origin, opts = {}) {
  const o = point(origin);
  const speed = defaultSpeed(opts);
  const n = count(opts.count, DEFAULT_SPREAD_COUNT);
  const out = [];
  if (n <= 0) return out;

  const explicit = num(opts.bearing, NaN);
  let bisector;
  if (Number.isFinite(explicit)) {
    bisector = wrapPi(explicit);
  } else if (opts.target && typeof opts.target === 'object' && Number.isFinite(num(opts.target.x, NaN)) && Number.isFinite(num(opts.target.y, NaN))) {
    bisector = wrapPi(bearingTo(o, opts.target) + Math.PI);
  } else {
    bisector = DOWN;
  }

  if (n === 1) {
    out.push(specAtAngle(o, bisector, speed, opts));
    return out;
  }
  const half = halfAngle(opts.arcDeg, DEFAULT_SPREAD_ARC_DEG);
  const step = (2 * half) / (n - 1);
  const middle = (n - 1) / 2;
  for (let i = 0; i < n; i++) out.push(specAtAngle(o, bisector + (i - middle) * step, speed, opts));
  return out;
}

/**
 * A full circle of `count` bullets, evenly spaced and starting straight down.
 * The classic Cave opener: nothing on the field is safe.
 */
export function ring(origin, opts = {}) {
  const o = point(origin);
  const speed = defaultSpeed(opts);
  const n = count(opts.count, DEFAULT_RING_COUNT);
  const out = [];
  if (n <= 0) return out;
  const base = Number.isFinite(num(opts.baseDeg, NaN)) ? deg(opts.baseDeg) : num(opts.base, DOWN);
  const step = TAU / n;
  for (let i = 0; i < n; i++) out.push(specAtAngle(o, base + i * step, speed, opts));
  return out;
}

/**
 * One *step* of a rotating spiral: `count` bullets evenly spaced over the whole
 * circle, with the ring's phase advanced by `angleStepDeg` for every `index`.
 * Stepping `index` each volley therefore sweeps a continuous spiral curtain; the
 * result is fully determined by `index`, so replays stay identical.
 */
export function spiralStep(origin, opts = {}) {
  const o = point(origin);
  const speed = defaultSpeed(opts);
  const n = count(opts.count, DEFAULT_SPIRAL_COUNT);
  const out = [];
  if (n <= 0) return out;
  const index = Math.max(0, Math.floor(num(opts.index, 0)));
  const stepDeg = num(opts.angleStepDeg, DEFAULT_SPIRAL_STEP_DEG);
  const base = wrapPi(deg(opts.baseDeg, 90) + index * stepDeg * DEG);
  const step = TAU / n;
  for (let i = 0; i < n; i++) out.push(specAtAngle(o, base + i * step, speed, opts));
  return out;
}

/**
 * One *step* of a sweeping fan: the volley walks from one end of a
 * `2 * arcDeg` arc to the other as `index` runs 0..count-1 and then repeats, so a
 * turret laying down a moving curtain only has to increment `index`.
 *
 * `burst` bullets may be emitted per step (spread over `burstArcDeg`), which
 * turns the sweep into a thicker curtain without changing its geometry.
 */
export function sweep(origin, opts = {}) {
  const o = point(origin);
  const speed = defaultSpeed(opts);
  const n = Math.max(1, count(opts.count, DEFAULT_SWEEP_COUNT));
  const half = halfAngle(opts.arcDeg, DEFAULT_SWEEP_ARC_DEG);
  const bearing = bearingOf(o, opts);
  const index = Math.max(0, Math.floor(num(opts.index, 0)));
  const burst = Math.max(1, Math.floor(num(opts.burst, 1)));

  const t = n > 1 ? (index % n) / (n - 1) : 0.5;
  const angle = bearing + (t - 0.5) * 2 * half;

  const out = [];
  const defaultBurstDeg = n > 1 ? (2 * half) / DEG / (n - 1) : 0;
  const burstStep = burst > 1 ? halfAngle(opts.burstArcDeg, defaultBurstDeg) / (burst - 1) : 0;
  for (let i = 0; i < burst; i++) out.push(specAtAngle(o, angle + (i - (burst - 1) / 2) * burstStep, speed, opts));
  return out;
}

/**
 * A wall of `count` bullets placed on a circle of `radius` around `origin`,
 * centred on `facing` and spanning `2 * arcDeg` degrees.
 *
 * By default each bullet leaves the arc radially outwards from `origin`, which
 * is what a ring-shaped emitter wants; pass `outward: false` to have the whole
 * wall travel along `facing` instead.
 */
export function arc(origin, opts = {}) {
  const o = point(origin);
  const speed = defaultSpeed(opts);
  const n = count(opts.count, DEFAULT_ARC_COUNT);
  const out = [];
  if (n <= 0) return out;
  const radius = Math.abs(num(opts.radius, DEFAULT_ARC_RADIUS));
  const facing = wrapPi(num(opts.facing, DOWN));
  const half = halfAngle(opts.arcDeg, DEFAULT_ARC_HALF_DEG);
  const outward = opts.outward !== false;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) - 0.5 : 0;
    const a = facing + t * 2 * half;
    const x = o.x + Math.cos(a) * radius;
    const y = o.y + Math.sin(a) * radius;
    const dir = outward ? a : facing;
    out.push(makeSpec(x, y, Math.cos(dir) * speed, Math.sin(dir) * speed, speed, opts));
  }
  return out;
}

/**
 * A fan of `count` seekers: they launch towards `target` (spread `arcDeg` either
 * side of the bearing) and then steer towards `seekX`/`seekY` at `turnDeg` per
 * frame. `bullets.mjs` applies the steering, so a game that keeps the seek point
 * on the player has to refresh `seekX`/`seekY` on the live bullets.
 */
export function homing(origin, opts = {}) {
  const o = point(origin);
  const speed = defaultSpeed(opts);
  const n = Math.max(1, count(opts.count, 1));
  const bearing = bearingOf(o, opts);
  const half = halfAngle(opts.arcDeg, DEFAULT_ARC_HALF_DEG);
  const turn = Math.max(0, num(opts.turn, deg(opts.turnDeg, DEFAULT_HOMING_TURN_DEG)));
  const seek = opts.seek && typeof opts.seek === 'object' ? opts.seek : opts.target;
  const seekX = num(seek && seek.x, NaN);
  const seekY = num(seek && seek.y, NaN);

  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) - 0.5 : 0;
    const spec = specAtAngle(o, bearing + t * 2 * half, speed, opts);
    spec.turn = turn;
    spec.homing = true;
    if (Number.isFinite(seekX) && Number.isFinite(seekY)) {
      spec.seekX = seekX;
      spec.seekY = seekY;
    }
    out.push(spec);
  }
  return out;
}

/* ----------------------------------------------------------------- exports */

/** Every generator, addressable by name for data-driven enemy tables. */
export const PATTERNS = Object.freeze({
  aimed,
  spread,
  ring,
  spiralStep,
  sweep,
  arc,
  homing,
  bearingTo,
});

/** Names `config.ENEMY_TABLE[*].pattern` may reference. */
export const PATTERN_NAMES = Object.freeze([
  'aimed',
  'spread',
  'ring',
  'spiralStep',
  'sweep',
  'arc',
  'homing',
]);

/**
 * Look a generator up by name and run it. Unknown names fall back to `aimed`, so
 * a data-driven emitter never throws mid-stage.
 */
export function emitPattern(name, origin, opts = {}) {
  const fn = PATTERNS[name];
  return typeof fn === 'function' && name !== 'bearingTo' ? fn(origin, opts) : aimed(origin, opts);
}

export default PATTERNS;
