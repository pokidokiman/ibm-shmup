/**
 * patterns.mjs — deterministic danmaku generators (Cave-style bullet curtains).
 *
 * `PATTERNS.<name>(origin, opts)` returns a *fresh array* of bullet specs — plain
 * `{ x, y, vx, vy, r, kind, speed }` records that `bullets.mjs` pools verbatim,
 * plus the handful of optional fields (`damage`, `turn`, `seekX`/`seekY`, `life`)
 * that only the generators which need them fill in.
 *
 * The authored vocabulary (every generator name is addressable through
 * `PATTERN_NAMES`, so `config.ENEMY_TABLE[*].pattern` may name any of them):
 *
 *   aimed       aimed burst — `count` shots down one line of fire, staggered
 *               `burstGap` frames apart and optionally fanned over `arcDeg`
 *   aimedBurst  the same burst with an authored default of three shots
 *   nway        symmetric n-way spread laid *exactly* on the aim line, with an
 *               honest per-bullet angular delta (`deltaDeg`) or `arcDeg`
 *   spread      the legacy fan; it centres on the mirror of the aim line unless
 *               an explicit `bearing`/`facing` (or `aimLine: true`) says where
 *               it points
 *   ring        full `count`-bullet ring, plus `rows` concentric rows with their
 *               own phase stagger and speed step for a two-tone curtain
 *   spiralStep  rotating curtain: one ring per volley, phase advancing by
 *               `angleStepDeg` and *accelerating* by `accelDeg` per volley,
 *               with optional `arms` and a per-volley `speedStep`
 *   sweep       index-driven curtain that walks a `2 * arcDeg` fan; with a
 *               `target` that carries a velocity it leads the player
 *   arc         bullets placed on a circle of `radius` and fired outwards
 *   homing      seekers that steer towards a (optionally led) seek point
 *   beam        a single telegraphing laser
 *   mixed       one volley carrying slow *and* fast bullets: a slow curtain of
 *               big orbs plus small fast darts that lead the player
 *   volley      a composite: runs a list of descriptors back to back
 *
 * Aiming at a moving player: pass `lead`/`leadFrames` (frames) or `leadPx`
 * (pixels) together with a `target` that has `vx`/`vy` (or a `targetVel`) and
 * every aiming generator fires at where the ship *will be*.
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
 * Aiming: every generator that takes a `target` derives its bearing from
 * `origin -> target` (`bearingTo`), with two conventions worth knowing:
 *   • `spread` centres its fan on the *aim line* mirrored through the origin, so
 *     `angles[0] + angles[last] === -PI` for a target below the emitter — the
 *     contract `tests/patterns.test.mjs` pins. Pass `bearing` (or use
 *     `sweep`/`homing`, which aim straight at the target) when a fan must be
 *     laid down exactly along the line of fire.
 *   • `beam` returns a single `laser` spec shaped for `bullets.mjs#spawnLaser`;
 *     it telegraphs for `warn` frames and then burns along `angle`.
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
const DEFAULT_NWAY_COUNT = 5;
const DEFAULT_NWAY_ARC_DEG = 22;
const DEFAULT_BURST_COUNT = 3;
/** Frames between the shots of an aimed burst (turned into a muzzle offset). */
const DEFAULT_BURST_GAP = 4;
const DEFAULT_RING_COUNT = 12;
const DEFAULT_SPIRAL_COUNT = 6;
const DEFAULT_SPIRAL_STEP_DEG = 13;
/** Per-volley increase of the spiral's rotation step (deg) and its cap. */
const DEFAULT_SPIRAL_ACCEL_DEG = 2;
const DEFAULT_SPIRAL_ACCEL_CAP = 24;
const DEFAULT_SPIRAL_SPEED_STEP = 0.05;
const DEFAULT_SWEEP_COUNT = 9;
const DEFAULT_SWEEP_ARC_DEG = 30;
const DEFAULT_ARC_COUNT = 7;
const DEFAULT_ARC_RADIUS = 60;
const DEFAULT_ARC_HALF_DEG = 45;
const DEFAULT_HOMING_TURN_DEG = 1.5;
/** Slow/fast mix: half-angle, speed multipliers and radius multipliers. */
const DEFAULT_MIXED_COUNT = 8;
const DEFAULT_MIXED_HALF_DEG = 24;
const DEFAULT_MIXED_SLOW_MUL = 0.55;
const DEFAULT_MIXED_FAST_MUL = 1.45;
const DEFAULT_MIXED_SLOW_R_MUL = 1.2;
const DEFAULT_MIXED_FAST_R_MUL = 0.85;
/** Bullets below this crawl would read as an unfair wall, so speeds clamp here. */
const DEFAULT_SLOW_SPEED = 1.2;

/** Beam fallbacks, mirroring the ones `bullets.mjs` uses for `spawnLaser`. */
const DEFAULT_LASER_LENGTH = 320;
const DEFAULT_LASER_DAMAGE = 2;
const DEFAULT_LASER_WARN = 24;
const DEFAULT_LASER_ACTIVE = 90;

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

/* ------------------------------------------------------------------ aiming */

/**
 * Optional authored tuning block: `config.BALANCE.patterns.<group>.<key>`. The
 * generators ship with real fallback numbers, so the config layer may override
 * any of them — or omit the block entirely.
 */
const patternCfg = () => {
  const b = BALANCE && typeof BALANCE === 'object' ? BALANCE.patterns : null;
  return b && typeof b === 'object' ? b : {};
};

/** `BALANCE.patterns.<group>.<key>` when the config layer supplies one. */
function tuned(group, key, fallback) {
  const g = patternCfg()[group];
  const v = g && typeof g === 'object' ? num(g[key], NaN) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

/** Velocity of the aim point, from `targetVel` or the target's own vx/vy. */
function targetVelocity(opts) {
  const explicit = opts.targetVel && typeof opts.targetVel === 'object' ? opts.targetVel : {};
  const t = opts.target && typeof opts.target === 'object' ? opts.target : {};
  return {
    vx: num(explicit.vx, num(t.vx, num(opts.targetVx, 0))) || 0,
    vy: num(explicit.vy, num(t.vy, num(opts.targetVy, 0))) || 0,
  };
}

/** Frames of lead requested by `lead`/`leadFrames` (0 when absent). */
function leadFrames(opts) {
  const v = num(opts.lead, num(opts.leadFrames, NaN));
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}

/** True when `opts.target` is a usable point. */
function hasTarget(opts) {
  const t = opts.target;
  return !!(t && typeof t === 'object' && Number.isFinite(num(t.x, NaN)) && Number.isFinite(num(t.y, NaN)));
}

/**
 * The point an aiming generator should shoot at: the target pushed along its own
 * velocity by `lead` frames, or `leadPx` pixels along that velocity. Without a
 * moving target this is just the target (or straight below the emitter), so an
 * unleaded volley behaves exactly as it always did.
 */
export function leadPoint(origin, opts = {}) {
  const o = point(origin);
  const t = opts.target && typeof opts.target === 'object' ? opts.target : {};
  const base = { x: num(t.x, o.x), y: num(t.y, o.y + 100) };
  const v = targetVelocity(opts);
  const px = num(opts.leadPx, NaN);
  if (Number.isFinite(px) && px > 0) {
    const m = Math.hypot(v.vx, v.vy);
    if (m < EPS) return base;
    return { x: base.x + (v.vx / m) * px, y: base.y + (v.vy / m) * px };
  }
  const frames = leadFrames(opts);
  if (!(frames > 0)) return base;
  return { x: base.x + v.vx * frames, y: base.y + v.vy * frames };
}

/** True when the caller asked for a leading shot. */
const leading = (opts) => leadFrames(opts) > 0 || num(opts.leadPx, NaN) > 0;

/**
 * Bearing for an aimed volley. Precedence: an explicit `bearing` (radians) wins,
 * then the target (led by `lead`/`leadPx` when asked), then the emitter's
 * `facing`, then straight down. `mirror` lays the bearing through the emitter —
 * the legacy `spread` convention.
 */
function aimBearing(o, opts, mirror = false) {
  const explicit = num(opts.bearing, NaN);
  if (Number.isFinite(explicit)) return wrapPi(explicit);
  if (hasTarget(opts)) {
    const a = bearingTo(o, leading(opts) ? leadPoint(o, opts) : opts.target);
    return wrapPi(mirror ? a + Math.PI : a);
  }
  const facing = num(opts.facing, NaN);
  if (Number.isFinite(facing)) return wrapPi(facing);
  return DOWN;
}

/** Direct aim at the target: the name the rest of the module uses. */
function bearingOf(o, opts) {
  return aimBearing(o, opts, false);
}

/**
 * Bisector for `spread`. An explicit `bearing` or `facing` wins, then
 * `aimLine: true` / `aim: 'target'` fires the fan straight down the line of
 * fire; otherwise the fan centres on the aim line *mirrored* through the
 * emitter, which is the historical convention `tests/patterns.test.mjs` pins.
 */
function spreadBisector(o, opts) {
  const explicit = num(opts.bearing, NaN);
  if (Number.isFinite(explicit)) return wrapPi(explicit);
  const facing = num(opts.facing, NaN);
  const direct = opts.aimLine === true || opts.direct === true || opts.aim === 'target' || opts.aim === 'lead';
  if (hasTarget(opts)) {
    if (direct) return aimBearing(o, opts, false);
    if (Number.isFinite(facing)) return wrapPi(facing);
    return wrapPi(bearingTo(o, opts.target) + Math.PI);
  }
  if (Number.isFinite(facing)) return wrapPi(facing);
  return DOWN;
}

/** Normalised direction towards a target (used by the straight-line generators). */
function unitTowards(o, opts) {
  const a = bearingOf(o, opts);
  return { x: Math.cos(a), y: Math.sin(a) };
}

/* ---------------------------------------------------------------------- fans */

/**
 * The honest angular delta between neighbouring bullets of a fan: `deltaDeg`
 * when the caller gives one (degrees), else the `arcDeg` half-angle divided
 * across the `n` shots. Never negative, so fans are always ordered.
 */
function fanDelta(opts, n, fallbackHalfDeg) {
  const explicit = num(opts.deltaDeg, NaN);
  if (Number.isFinite(explicit) && explicit > 0) return Math.abs(explicit) * DEG;
  if (n <= 1) return 0;
  return (2 * halfAngle(opts.arcDeg, fallbackHalfDeg)) / (n - 1);
}

/** `n` bearings evenly spaced about `bisector`, lowest first, `offsetDeg` shifted. */
function fanAngles(bisector, n, opts, fallbackHalfDeg) {
  const out = [];
  if (n <= 0) return out;
  if (n === 1) {
    out.push(bisector);
    return out;
  }
  const delta = fanDelta(opts, n, fallbackHalfDeg);
  const offset = deg(opts.offsetDeg, 0);
  const middle = (n - 1) / 2;
  for (let i = 0; i < n; i++) out.push(bisector + offset + (i - middle) * delta);
  return out;
}

/* -------------------------------------------------------------------- speeds */

/**
 * Keep a volley inside the authored speed band. Slow-heavy mixes are allowed to
 * dip below the band floor (that is the point of a slow curtain) but never to
 * crawl slower than `DEFAULT_SLOW_SPEED`, and nothing exceeds `enemyMaxSpeed`.
 */
function clampSpeed(v, allowSlow = true) {
  const cfg = bulletCfg();
  const hi = Math.max(DEFAULT_SPEED, num(cfg.enemyMaxSpeed, DEFAULT_SPEED * 3));
  const lo = allowSlow ? DEFAULT_SLOW_SPEED : Math.min(hi, Math.max(DEFAULT_SLOW_SPEED, num(cfg.enemyMinSpeed, DEFAULT_SPEED)));
  return Math.min(hi, Math.max(lo, num(v, lo)));
}

/**
 * Bullets in a burst are all spawned on one frame, so the *timing* of the burst
 * is authored as distance: shot `i` starts `speed * burstGap * (n - 1 - i)`
 * pixels further along the line of fire, which is exactly where it would be if
 * it had been fired `burstGap` frames earlier.
 */
function burstStagger(speed, gapFrames, n, i) {
  const step = Math.max(0, speed) * Math.max(0, gapFrames);
  return step * (n - 1 - i);
}

/**
 * Cumulative spiral phase (degrees) after `index` volleys. The rotation step
 * grows by `accelDeg` per volley until it has done so `capVolleys` times, so the
 * curtain *spins up* and then holds fast, steady rotation instead of aliasing
 * into noise late in a long fight.
 */
function spiralPhaseDeg(index, stepDeg, accelDeg, capVolleys) {
  const cap = Math.max(0, Math.floor(capVolleys));
  const rampEnd = Math.min(index, cap);
  const ramp = stepDeg * rampEnd + (accelDeg * rampEnd * (rampEnd - 1)) / 2;
  const tail = Math.max(0, index - cap);
  return ramp + (stepDeg + accelDeg * rampEnd) * tail;
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
 * An aimed burst: `count` shots (default 1) straight at `target`, along
 * `bearing`, or straight down. One shot is a single bullet; a burst staggers the
 * shots `burstGap` frames apart along the line of fire (see `burstStagger`) and
 * may fan them over `arcDeg` for a tight shotgun spread.
 */
export function aimed(origin, opts = {}) {
  const o = point(origin);
  const n = Math.max(1, count(opts.count, 1));
  const speed = defaultSpeed(opts);

  if (n === 1 && !Number.isFinite(num(opts.arcDeg, NaN)) && !Number.isFinite(num(opts.offsetDeg, NaN))) {
    const dir = unitTowards(o, opts);
    return [specAtVelocity(o, dir.x * speed, dir.y * speed, speed, opts)];
  }

  const gap = num(opts.burstGap, num(opts.gapFrames, tuned('burst', 'gapFrames', DEFAULT_BURST_GAP)));
  const angles = fanAngles(aimBearing(o, opts, false), n, opts, 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = angles[i];
    const advance = burstStagger(speed, gap, n, i);
    out.push(makeSpec(
      o.x + Math.cos(a) * advance,
      o.y + Math.sin(a) * advance,
      Math.cos(a) * speed,
      Math.sin(a) * speed,
      speed,
      opts,
    ));
  }
  return out;
}

/**
 * `aimed` with an authored default of three shots — the standard Cave "aim and
 * rake" burst for turrets that should punish a straight line.
 */
export function aimedBurst(origin, opts = {}) {
  return aimed(origin, { ...opts, count: Math.max(1, count(opts.count, tuned('burst', 'count', DEFAULT_BURST_COUNT))) });
}

/**
 * An even fan of `count` bullets about a bisector. The angular delta between
 * neighbours is honest by construction: pass `deltaDeg` for an explicit spacing,
 * or `arcDeg` for a half-angle (the outermost bullet sits `arcDeg` either side
 * of the bisector, so the fan covers `2 * arcDeg`).
 *
 * With only a `target` the fan is laid out about the aim *line* through `origin`
 * and `target`, **mirrored** through the emitter — the historical contract. Pass
 * `bearing`/`facing` (radians, playfield frame) or `aimLine: true` to fire the
 * fan straight down the line of fire, `el`/`lead` to lead a moving target, or use
 * `nway`, which always aims straight at the player.
 */
export function spread(origin, opts = {}) {
  const o = point(origin);
  const speed = defaultSpeed(opts);
  const n = count(opts.count, DEFAULT_SPREAD_COUNT);
  if (n <= 0) return [];

  const bisector = spreadBisector(o, opts);
  const angles = fanAngles(bisector, n, opts, DEFAULT_SPREAD_ARC_DEG);
  const out = [];
  for (let i = 0; i < n; i++) out.push(specAtAngle(o, angles[i], speed, opts));
  return out;
}

/**
 * A symmetric n-way spread fired *straight at the player*: `count` bullets with
 * the same honest angular delta as `spread` (`deltaDeg`, else `arcDeg`
 * half-angle), centred exactly on the aim line, optionally led by `lead` frames.
 * This is the bread-and-butter Cave midboss/medal-fairy shot.
 */
export function nway(origin, opts = {}) {
  const o = point(origin);
  const speed = defaultSpeed(opts);
  const n = count(opts.count, tuned('nway', 'count', DEFAULT_NWAY_COUNT));
  if (n <= 0) return [];

  const bearing = aimBearing(o, opts, false);
  const angles = fanAngles(bearing, n, opts, tuned('nway', 'arcDeg', DEFAULT_NWAY_ARC_DEG));
  const gap = num(opts.burstGap, num(opts.gapFrames, 0));
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = angles[i];
    const advance = gap > 0 ? burstStagger(speed, gap, n, i) : 0;
    out.push(makeSpec(
      o.x + Math.cos(a) * advance,
      o.y + Math.sin(a) * advance,
      Math.cos(a) * speed,
      Math.sin(a) * speed,
      speed,
      opts,
    ));
  }
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

/**
 * One telegraphing beam — the Cave turret laser.
 *
 * A beam spec carries every field the other volleys do (`x`, `y`, `r`, `kind`,
 * `speed`) so callers and pools can treat it uniformly, but it does not travel:
 * `vx`/`vy` and `speed` are zero and the beam is described by `angle` (radians,
 * playfield frame, straight down by default), `length`, `width`, `damage`,
 * `warn` (telegraph frames) and `activeFrames` (burn frames). `bullets.mjs`
 * consumes exactly this shape in `spawnLaser`.
 */
export function beam(origin, opts = {}) {
  const o = point(origin);
  const cfg = bulletCfg();
  const width = Math.max(1, num(opts.width, num(cfg.laserR, DEFAULT_R) * 2));
  const spec = {
    x: o.x,
    y: o.y,
    vx: 0,
    vy: 0,
    r: width / 2,
    kind: 'laser',
    speed: 0,
    damage: num(opts.damage, num(cfg.laserDamage, DEFAULT_LASER_DAMAGE)),
    angle: bearingOf(o, opts),
    length: Math.max(0, num(opts.length, num(cfg.laserLength, DEFAULT_LASER_LENGTH))),
    width,
    warn: Math.max(0, Math.floor(num(opts.warn, num(cfg.laserWarnFrames, DEFAULT_LASER_WARN)))),
    activeFrames: Math.max(1, Math.floor(num(opts.activeFrames, num(cfg.laserActiveFrames, DEFAULT_LASER_ACTIVE)))),
  };
  const life = num(opts.life, NaN);
  if (Number.isFinite(life) && life > 0) spec.life = life;
  return [spec];
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
  beam,
  bearingTo,
});

/** Names `config.ENEMY_TABLE[*].pattern` may reference (one callable volley each). */
export const PATTERN_NAMES = Object.freeze([
  'aimed',
  'spread',
  'ring',
  'spiralStep',
  'sweep',
  'arc',
  'homing',
  'beam',
]);

/**
 * Look a generator up by name and run it. Unknown names — and the `bearingTo`
 * helper, which is not a generator — fall back to `aimed`, so a data-driven
 * emitter never throws mid-stage.
 */
export function emitPattern(name, origin, opts = {}) {
  const fn = PATTERN_NAMES.includes(name) ? PATTERNS[name] : null;
  return typeof fn === 'function' ? fn(origin, opts) : aimed(origin, opts);
}

export default PATTERNS;
