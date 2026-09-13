/**
 * bullets.mjs — the pooled bullet/laser layer: spawn, steer, advance, retire.
 *
 * The system owns one pool of bullet records, so a full danmaku curtain runs
 * allocation-free: spawning past capacity hands back `null` instead of growing
 * or throwing, and every retired bullet is recycled by the next spawn.
 *
 *   const bullets = createBulletSystem(BALANCE.bullets.enemyMax);
 *   bullets.spawn(PATTERNS.aimed(enemy, { target: player, speed: 4 })[0]);
 *   bullets.update(1);                       // one 60 Hz frame
 *   for (const b of bullets.active) { ... }
 *
 * Record layout (all numbers are playfield pixels / pixels per frame):
 *   x, y, vx, vy   position and velocity
 *   r              collision radius
 *   kind           visual/behaviour tag ('pellet', 'orb', 'dart', 'star', 'shot')
 *   speed          |velocity|, kept around for the steering maths
 *   damage         damage a hit deals (1 for a standard pellet)
 *   friendly       true for player shots, false for enemy danmaku
 *   age, life      frames lived, and the frame count that force-retires it
 *   turn, seekX/Y  homing steer rate (radians per frame) and its seek point
 *   grazed         set once a bullet has paid out its graze score
 *   laser, phase   beam bullets: 'warn' -> 'active', plus angle/length/width
 *
 * Pure ES module: no DOM, no three, no timers.
 */

import { createPool } from '../core/pool.mjs';
import { BALANCE } from './config.mjs';
import { grazeBand, hitsEntity } from './collision.mjs';

/** Simulation rate every speed in `config.BALANCE` is authored against. */
export const FRAME_RATE = 60;

/** Fallbacks used when `config.BALANCE` omits a value (keeps the module import-safe). */
const DEFAULTS = Object.freeze({
  capacity: 2048,
  enemyR: 5,
  playerR: 4,
  lifetime: 900,
  cullMargin: 96,
  fieldWidth: 1024,
  fieldHeight: 768,
  laserR: 7,
  laserLength: 320,
  laserWarnFrames: 24,
  laserActiveFrames: 90,
  laserDamage: 2,
});

const bulletCfg = () => (BALANCE && typeof BALANCE === 'object' && BALANCE.bullets ? BALANCE.bullets : {});
const fieldCfg = () => (BALANCE && typeof BALANCE === 'object' && BALANCE.field ? BALANCE.field : {});

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const wrapPi = (a) => {
  const t = Math.PI * 2;
  let r = a % t;
  if (r > Math.PI) r -= t;
  if (r <= -Math.PI) r += t;
  return r;
};

/**
 * Frame delta. The fixed-step simulation works in 60 Hz frames, which is the unit
 * the tests and `BALANCE` use; a fractional delta below one frame cannot be a
 * meaningful frame count, so it is read as a wall-clock delta in seconds and
 * scaled — `update(1/60)` and `update(1)` therefore both advance exactly one frame.
 */
const toFrames = (dt) => {
  const v = num(dt, 0);
  if (v <= 0) return 0;
  return v >= 1 ? v : v * FRAME_RATE;
};

function defaultCapacity() {
  const cfg = bulletCfg();
  return Math.max(
    1,
    Math.floor(num(cfg.enemyMax, DEFAULTS.capacity)) + Math.floor(num(cfg.playerMax, 0)),
  );
}

/* ----------------------------------------------------------------- factory */

/** One recycled bullet record; every field is reset by `spawn`. */
function makeBullet() {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: DEFAULTS.enemyR,
    kind: 'pellet',
    speed: 0,
    damage: 1,
    friendly: false,
    age: 0,
    life: DEFAULTS.lifetime,
    turn: 0,
    seekX: NaN,
    seekY: NaN,
    homing: false,
    grazed: false,
    live: false,
    laser: false,
    phase: 'active',
    angle: 0,
    length: 0,
    width: 0,
    warnFrames: 0,
    activeFrames: 0,
  };
}

/* ------------------------------------------------------------------- system */

/**
 * @param {number} [capacity] maximum number of simultaneously live bullets
 * @param {{ field?: {width?:number,height?:number,cullMargin?:number} }} [opts]
 */
export function createBulletSystem(capacity = defaultCapacity(), opts = {}) {
  const cfg = bulletCfg();
  const fieldOpt = opts.field && typeof opts.field === 'object' ? opts.field : {};
  const field = fieldCfg();

  const width = num(fieldOpt.width, num(field.width, DEFAULTS.fieldWidth));
  const height = num(fieldOpt.height, num(field.height, DEFAULTS.fieldHeight));
  const margin = Math.max(0, num(fieldOpt.cullMargin, num(field.cullMargin, DEFAULTS.cullMargin)));

  const maxX = width + margin;
  const maxY = height + margin;
  const minX = -margin;
  const minY = -margin;

  const lifetime = Math.max(1, num(cfg.lifetime, DEFAULTS.lifetime));
  const enemyR = num(cfg.enemyR, DEFAULTS.enemyR);
  const playerR = num(cfg.playerR, DEFAULTS.playerR);
  const laserR = num(cfg.laserR, DEFAULTS.laserR);

  const capacityValue = Math.max(0, Math.floor(num(capacity, defaultCapacity())));
  const pool = createPool(capacityValue, makeBullet);

  /** True once a bullet has drifted past the cull boundary and is leaving. */
  const leavingField = (b) => {
    if (b.x < minX) return b.vx <= 0;
    if (b.x > maxX) return b.vx >= 0;
    if (b.y < minY) return b.vy <= 0;
    if (b.y > maxY) return b.vy >= 0;
    return false;
  };

  /** Off the playfield (plus cull margin) or out of lifetime. */
  const shouldRetire = (b) => {
    if (b.age >= b.life) return true;
    const outside = b.x < minX || b.x > maxX || b.y < minY || b.y > maxY;
    return outside && leavingField(b);
  };

  /** Rotate a homing bullet's velocity towards its seek point. */
  const steer = (b, frames) => {
    if (!b.homing || !(b.turn > 0)) return;
    if (!Number.isFinite(b.seekX) || !Number.isFinite(b.seekY)) return;
    if (b.speed <= 0) return;
    const want = Math.atan2(b.seekY - b.y, b.seekX - b.x);
    const cur = Math.atan2(b.vy, b.vx);
    const maxTurn = b.turn * frames;
    const diff = wrapPi(want - cur);
    const turned = diff > maxTurn ? maxTurn : diff < -maxTurn ? -maxTurn : diff;
    const a = cur + turned;
    b.vx = Math.cos(a) * b.speed;
    b.vy = Math.sin(a) * b.speed;
  };

  const retire = (b) => {
    if (!b) return false;
    const released = pool.release(b);
    if (released) b.live = false;
    return released;
  };

  const spawn = (spec, spawnOpts = {}) => {
    const s = spec && typeof spec === 'object' ? spec : {};
    const o = spawnOpts && typeof spawnOpts === 'object' ? spawnOpts : {};
    const b = pool.acquire();
    if (!b) return null;

    const friendly = o.friendly !== undefined ? !!o.friendly : !!s.friendly;
    const vx = num(s.vx, 0);
    const vy = num(s.vy, 0);

    b.x = num(s.x, 0);
    b.y = num(s.y, 0);
    b.vx = vx;
    b.vy = vy;
    b.speed = Math.max(0, num(s.speed, Math.hypot(vx, vy)));
    b.r = Math.max(0.5, num(s.r, friendly ? playerR : enemyR));
    b.kind = typeof s.kind === 'string' && s.kind ? s.kind : friendly ? 'shot' : 'pellet';
    b.damage = num(s.damage, 1);
    b.friendly = friendly;
    b.age = 0;
    b.life = Math.max(1, num(s.life, lifetime));
    b.turn = Math.max(0, num(s.turn, 0));
    b.seekX = Number.isFinite(s.seekX) ? s.seekX : NaN;
    b.seekY = Number.isFinite(s.seekY) ? s.seekY : NaN;
    b.homing = b.turn > 0 && Number.isFinite(b.seekX) && Number.isFinite(b.seekY);
    b.grazed = false;
    b.live = true;
    b.laser = false;
    b.phase = 'active';
    b.angle = num(s.angle, Math.atan2(vy, vx));
    b.length = 0;
    b.width = 0;
    b.warnFrames = 0;
    b.activeFrames = 0;
    return b;
  };

  const spawnMany = (specs, spawnOpts = {}) => {
    let n = 0;
    if (!specs) return n;
    for (let i = 0; i < specs.length; i++) if (spawn(specs[i], spawnOpts)) n++;
    return n;
  };

  const spawnPlayer = (spec, spawnOpts = {}) => spawn(spec, { ...spawnOpts, friendly: true });

  const spawnEnemy = (spec, spawnOpts = {}) => spawn(spec, { ...spawnOpts, friendly: false });

  /**
   * A pooled beam: it telegraphs for `warn` frames, then deals damage down
   * `angle` for `length` pixels while `phase === 'active'`. Beams do not move by
   * themselves, so an emitter can re-point them (`b.angle`) every frame.
   */
  const spawnLaser = (spec, spawnOpts = {}) => {
    const s = spec && typeof spec === 'object' ? spec : {};
    const b = spawn({ ...s, vx: 0, vy: 0 }, spawnOpts);
    if (!b) return null;
    b.laser = true;
    b.angle = num(s.angle, Math.PI / 2);
    b.length = Math.max(0, num(s.length, num(cfg.laserLength, DEFAULTS.laserLength)));
    b.width = Math.max(1, num(s.width, laserR * 2));
    b.r = b.width / 2;
    b.damage = num(s.damage, num(cfg.laserDamage, DEFAULTS.laserDamage));
    b.warnFrames = Math.max(0, Math.floor(num(s.warn, num(cfg.laserWarnFrames, DEFAULTS.laserWarnFrames))));
    b.activeFrames = Math.max(1, Math.floor(num(s.activeFrames, num(cfg.laserActiveFrames, DEFAULTS.laserActiveFrames))));
    b.phase = b.warnFrames > 0 ? 'warn' : 'active';
    b.life = b.warnFrames + b.activeFrames;
    b.kind = typeof s.kind === 'string' && s.kind ? s.kind : 'laser';
    return b;
  };

  /**
   * Advance every live bullet by `dt` (60 Hz frames, see `toFrames`) and recycle
   * whatever left the field or ran out of lifetime. Returns how many retired.
   */
  const update = (dt = 1) => {
    const frames = toFrames(dt);
    if (frames <= 0) return 0;
    const active = pool.active;
    let retired = 0;
    for (let i = active.length - 1; i >= 0; i--) {
      const b = active[i];
      b.age += frames;
      if (b.laser) {
        if (b.warnFrames > 0 && b.age >= b.warnFrames) b.phase = 'active';
      } else {
        steer(b, frames);
        b.x += b.vx * frames;
        b.y += b.vy * frames;
      }
      if (shouldRetire(b)) {
        retire(b);
        retired++;
      }
    }
    return retired;
  };

  /** Visit every live bullet, newest first (safe against retiring inside `fn`). */
  const each = (fn) => {
    if (typeof fn !== 'function') return 0;
    const active = pool.active;
    for (let i = active.length - 1; i >= 0; i--) fn(active[i], i);
    return active.length;
  };

  /** Visit only the enemy danmaku — the set the player's hitbox is tested against. */
  const eachEnemy = (fn) => {
    if (typeof fn !== 'function') return 0;
    const active = pool.active;
    for (let i = active.length - 1; i >= 0; i--) if (!active[i].friendly) fn(active[i], i);
    return active.length;
  };

  const eachPlayer = (fn) => {
    if (typeof fn !== 'function') return 0;
    const active = pool.active;
    for (let i = active.length - 1; i >= 0; i--) if (active[i].friendly) fn(active[i], i);
    return active.length;
  };

  /** Clear everything (stage transition, restart). */
  const clear = () => {
    const active = pool.active;
    while (active.length > 0) retire(active[active.length - 1]);
    return 0;
  };

  /** Clear one side's bullets — a bomb wipes the enemy curtain but not your own shots. */
  const clearSide = (friendly) => {
    let n = 0;
    const active = pool.active;
    for (let i = active.length - 1; i >= 0; i--) {
      if (!!active[i].friendly === friendly) {
        retire(active[i]);
        n++;
      }
    }
    return n;
  };

  /** First enemy bullet touching the player's tight hitbox, or null. */
  const firstEnemyHit = (player) => {
    const active = pool.active;
    for (let i = 0; i < active.length; i++) {
      const b = active[i];
      if (!b.friendly && hitsEntity(player, b.x, b.y, b.r)) return b;
    }
    return null;
  };

  /** How many enemy bullets touch the player right now. */
  const countEnemyHits = (player) => {
    let n = 0;
    const active = pool.active;
    for (let i = 0; i < active.length; i++) {
      const b = active[i];
      if (!b.friendly && hitsEntity(player, b.x, b.y, b.r)) n++;
    }
    return n;
  };

  /**
   * Mark every enemy bullet brushing the player's graze ring (one payout each)
   * and report how many were newly grazed.
   */
  const graze = (player, grazeR) => {
    let n = 0;
    const active = pool.active;
    for (let i = 0; i < active.length; i++) {
      const b = active[i];
      if (b.friendly || b.grazed) continue;
      if (grazeBand(player, grazeR, b.x, b.y, b.r)) {
        b.grazed = true;
        n++;
      }
    }
    return n;
  };

  /** End points of a live beam, for rendering and for swept collision. */
  const laserSegment = (b) => {
    if (!b || !b.laser) return null;
    return {
      x1: b.x,
      y1: b.y,
      x2: b.x + Math.cos(b.angle) * b.length,
      y2: b.y + Math.sin(b.angle) * b.length,
      width: b.width,
    };
  };

  const countLive = (friendly) => {
    let n = 0;
    const active = pool.active;
    for (let i = 0; i < active.length; i++) if (!!active[i].friendly === friendly) n++;
    return n;
  };

  return {
    /** Live bullets, oldest first — the array the pool recycles into. */
    active: pool.active,
    pool,
    capacity: capacityValue,
    field: Object.freeze({ width, height, cullMargin: margin }),
    lifetime,
    spawn,
    spawnEnemy,
    spawnPlayer,
    spawnMany,
    spawnLaser,
    update,
    retire,
    clear,
    clearEnemy: () => clearSide(false),
    clearPlayer: () => clearSide(true),
    each,
    eachEnemy,
    eachPlayer,
    firstEnemyHit,
    countEnemyHits,
    graze,
    laserSegment,
    /** True while a beam is actually dangerous. */
    laserActive: (b) => !!b && b.laser === true && b.phase === 'active',
    get count() {
      return pool.active.length;
    },
    get enemyCount() {
      return countLive(false);
    },
    get playerCount() {
      return countLive(true);
    },
    get free() {
      return pool.free;
    },
    get full() {
      return pool.full;
    },
  };
}

export default createBulletSystem;
