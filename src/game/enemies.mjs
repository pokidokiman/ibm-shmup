/**
 * enemies.mjs — enemy archetypes, their movement scripts and their attack cadence.
 *
 * Pure simulation code: no DOM, no three, no timers. `createEnemy(kind, x, y, opts)`
 * builds a live enemy the game loop drives; `resetEnemy()` re-arms the very same
 * object so the game layer can keep them in a `core/pool.mjs` pool and never
 * allocate during play.
 *
 *   live enemy fields (read by the renderer + collision)
 *     kind / type     archetype name from ENEMY_TABLE ('grunt', 'turret', ...)
 *     x, y            position in playfield pixels (origin = top-left)
 *     vx, vy          velocity in px/frame, kept current by the movement script
 *     r               collision radius
 *     hp, maxHp       durability (rank may scale maxHp before spawn)
 *     points          score value the kill prints
 *     t / age         frames alive
 *     active          false once killed or flown off; recycle it then
 *     dead / alive    convenience mirrors of `active`
 *     flash           frames of white hit-flash left
 *     volley          number of shots fired so far (feeds spiralStep)
 *     script          movement script name
 *     pattern         danmaku generator name (null = never fires)
 *     fireCd          base frames between volleys
 *     fireTimer       frames until the next volley
 *
 *   methods
 *     update(dt, ctx) -> this        advance one fixed step (`dt` in seconds, the
 *                                    usual 1/60; a bare frame count > 0.5 is
 *                                    accepted too so frame-driven callers work)
 *     advance(frames, ctx) -> this   the same step expressed in frames
 *     damage(n, ctx) -> boolean      true when this hit destroyed it
 *     hurt(n, ctx) -> boolean        alias of damage
 *     kill(ctx)                      force destruction (bomb, boss clear)
 *     reset(kind, x, y, opts)        re-arm for a new life (pooling)
 *     hitbox() -> { x, y, r }
 *     offscreen() -> boolean
 *
 * The context object is owned by the game layer. Every hook is optional so an
 * enemy can be stepped bare in a unit test; when a hook is missing the module
 * falls back to plain data (specs pushed onto `ctx.bullets` / `ctx.bulletSystem`).
 *
 *   ctx.fireBullets(specs, enemy)   preferred bullet sink (routes to bullets.mjs)
 *   ctx.patternSpecs(name, origin, opts)  preferred danmaku source (patterns.mjs)
 *   ctx.patterns[name](origin, opts)      alternative danmaku source
 *   ctx.player                       the ship bullets are aimed at
 *   ctx.rank                         current dynamic rank, 0..1
 *   ctx.onHit(enemy, dmg)            feedback hook
 *   ctx.onKill(enemy)                feedback hook
 */
import { BALANCE, ENEMY_TABLE } from './config.mjs';

/** Simulation rate every balance number is authored against. */
export const FRAME_RATE = 60;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const fieldCfg = () =>
  BALANCE && BALANCE.field
    ? BALANCE.field
    : { width: 1024, height: 768, centerX: 512, centerY: 384, spawnY: -48, cullMargin: 96 };

const enemyCfg = () => (BALANCE && BALANCE.enemy ? BALANCE.enemy : {});

const bulletCfg = () => (BALANCE && BALANCE.bullets ? BALANCE.bullets : {});

/** Bullet kinds shared with bullets.mjs / patterns.mjs. */
export const BULLET_KINDS =
  Array.isArray(bulletCfg().kinds) && bulletCfg().kinds.length
    ? bulletCfg().kinds
    : ['pellet', 'orb', 'dart', 'laser', 'star'];

/** Fallback archetype so an unknown name still builds a playable enemy. */
export const DEFAULT_SPEC = Object.freeze({
  hp: 10,
  r: 13,
  speed: 2,
  points: 200,
  script: 'dive',
  pattern: null,
  fireCd: 0,
  burst: 0,
  spreadDeg: 0,
  bulletSpeed: 3.6,
  sprite: 'popcorn',
  hitFlash: 6,
  drop: 0.16,
});

/** Every archetype the game knows, straight from the balance table. */
export const ENEMY_KINDS = Object.keys(ENEMY_TABLE || {});

/** The config row for an archetype (never null, always complete). */
export function enemySpec(kind) {
  const table = ENEMY_TABLE || {};
  const spec = table[kind];
  if (spec && typeof spec === 'object') return spec;
  return table.grunt || DEFAULT_SPEC;
}

/**
 * Convert a step into frames. `dt` is in seconds (the sim's fixed 1/60 step);
 * a raw frame count (anything above 0.5) is passed through unchanged so the
 * frame-driven paths in tests and tools keep working.
 */
export function framesOf(dt) {
  const v = num(dt, 0);
  if (v <= 0) return 0;
  return v <= 0.5 ? v * FRAME_RATE : v;
}

/* ------------------------------------------------------------ movement scripts */

/**
 * Movement routines. Every script integrates the enemy itself so non-linear
 * paths (holds, arcs, exits) stay in one place. `f` is the number of frames to
 * advance this step, so all speeds remain px/frame and replays stay identical.
 */
function scriptDive(e, f) {
  e.vx = num(e.drift, 0);
  e.vy = e.speed;
  e.x += e.vx * f;
  e.y += e.vy * f;
}

/** Enter on a diagonal, straighten out once the lane is reached. */
function scriptCrossDown(e, f) {
  if (e.y < e.turnY) {
    const dx = e.entryX - e.x;
    const dy = Math.max(1, e.turnY - e.y);
    const len = Math.hypot(dx, dy) || 1;
    e.vx = (dx / len) * e.speed;
    e.vy = (dy / len) * e.speed;
  } else {
    e.vx = num(e.drift, 0);
    e.vy = e.speed;
  }
  e.x += e.vx * f;
  e.y += e.vy * f;
}

/** Fast entry, a stationary firing window, then leave downward. */
function scriptHold(e, f) {
  if (e.y < e.holdY) {
    e.vx = num(e.drift, 0) * 0.5;
    e.vy = e.entrySpeed;
  } else if (e.t < e.holdUntil) {
    e.vy = 0;
    e.vx = e.sway ? Math.sin(e.t * 0.03 + e.swayPhase) * e.sway : e.vx * 0.85;
  } else {
    e.vx = num(e.drift, 0) * 0.5;
    e.vy = e.exitSpeed;
  }
  e.x += e.vx * f;
  e.y += e.vy * f;
}

/** Diagonal entry, a drifting firing window, then a climb off one flank. */
function scriptCrossHold(e, f) {
  if (e.y < e.holdY) {
    const dx = e.entryX - e.x;
    const dy = Math.max(1, e.holdY - e.y);
    const len = Math.hypot(dx, dy) || 1;
    e.vx = (dx / len) * e.entrySpeed;
    e.vy = (dy / len) * e.entrySpeed;
  } else if (e.t < e.holdUntil) {
    e.vy = 0;
    e.vx = e.sway ? Math.sin(e.t * 0.04 + e.swayPhase) * e.sway : e.vx * 0.8;
  } else {
    e.vx = e.exitDir * e.exitSpeed;
    e.vy = -e.exitSpeed * 0.3;
  }
  e.x += e.vx * f;
  e.y += e.vy * f;
}

/** Weaving descent: a lateral cosine keeps the lane unpredictable but smooth. */
function scriptWeave(e, f) {
  const amp = e.sway || 1.6;
  e.vx = Math.cos(e.t * 0.06 + e.swayPhase) * amp + num(e.drift, 0);
  e.vy = e.speed;
  e.x += e.vx * f;
  e.y += e.vy * f;
}

/** Slow float that bobs up and down around its hold line. */
function scriptHover(e, f) {
  if (e.y < e.holdY) {
    e.vy = e.entrySpeed;
    e.vx = num(e.drift, 0);
  } else {
    e.vy = Math.sin(e.t * 0.02 + e.swayPhase) * 0.6;
    e.vx = Math.sin(e.t * 0.035 + e.swayPhase) * (e.sway || 1.2) + num(e.drift, 0);
  }
  e.x += e.vx * f;
  e.y += e.vy * f;
}

/** Dive in, cut sideways across the screen, then climb out the far side. */
function scriptSwoop(e, f) {
  if (e.y < e.holdY) {
    const dx = e.entryX - e.x;
    const dy = Math.max(1, e.holdY - e.y);
    const len = Math.hypot(dx, dy) || 1;
    e.vx = (dx / len) * e.speed;
    e.vy = (dy / len) * e.speed;
  } else if (e.t < e.holdUntil) {
    e.vy = 0;
    e.vx = e.exitDir * e.speed * 1.2;
  } else {
    e.vx = e.exitDir * e.speed * 1.4;
    e.vy = -e.speed * 0.9;
  }
  e.x += e.vx * f;
  e.y += e.vy * f;
}

/** Mid-stage anchor: settles high, then slides side to side across the field. */
function scriptMidboss(e, f) {
  const field = fieldCfg();
  if (e.y < e.holdY) {
    const dx = e.entryX - e.x;
    const dy = Math.max(1, e.holdY - e.y);
    const len = Math.hypot(dx, dy) || 1;
    e.vx = (dx / len) * e.entrySpeed;
    e.vy = (dy / len) * e.entrySpeed;
  } else {
    e.vy = 0;
    e.vx = Math.sin(e.t * 0.012 + e.swayPhase) * (e.sway || 2.2);
  }
  e.x += e.vx * f;
  e.y += e.vy * f;
  const margin = e.r + 8;
  e.x = clamp(e.x, margin, field.width - margin);
}

/** Stage anchor used when the boss arrives through the enemy pipeline. */
function scriptBoss(e, f) {
  const field = fieldCfg();
  if (e.y < e.holdY) {
    e.vy = e.entrySpeed;
    e.vx = 0;
  } else {
    e.vy = Math.sin(e.t * 0.01 + e.swayPhase) * 0.35;
    e.vx = Math.sin(e.t * 0.008 + e.swayPhase) * (e.sway || 3);
  }
  e.x += e.vx * f;
  e.y += e.vy * f;
  const margin = e.r + 8;
  e.x = clamp(e.x, margin, field.width - margin);
  if (e.y < e.holdY - 40) e.y = e.holdY - 40;
}

export const ENEMY_SCRIPTS = {
  dive: scriptDive,
  straight: scriptDive,
  crossDown: scriptCrossDown,
  hold: scriptHold,
  crossHold: scriptCrossHold,
  weave: scriptWeave,
  hover: scriptHover,
  swoop: scriptSwoop,
  midboss: scriptMidboss,
  boss: scriptBoss,
};

/** Resolve a script name, falling back to a plain dive. */
export function scriptFor(name) {
  return ENEMY_SCRIPTS[name] || ENEMY_SCRIPTS.dive;
}

/* --------------------------------------------------------------- danmaku ---- */

/**
 * Build one bullet spec in the shape patterns.mjs/bullets.mjs use:
 * `{ x, y, vx, vy, r, kind, speed }`.
 */
function spec(x, y, vx, vy, r, kind) {
  return { x, y, vx, vy, r, kind, speed: Math.hypot(vx, vy) };
}

function kindAt(i) {
  const kinds = BULLET_KINDS;
  return kinds[i % kinds.length];
}

function aimAngle(origin, target) {
  const tx = target && Number.isFinite(target.x) ? target.x : origin.x;
  const ty = target && Number.isFinite(target.y) ? target.y : origin.y + 100;
  return Math.atan2(ty - origin.y, tx - origin.x);
}

/**
 * Self-contained generator used when the game layer has not supplied
 * patterns.mjs. Implements the same six names with the same geometry so enemy
 * behaviour is identical either way.
 */
function localPattern(name, origin, opts) {
  const speed = num(opts.speed, bulletCfg().enemyMinSpeed || 3);
  const r = num(opts.r, bulletCfg().enemyR || 5);
  const count = Math.max(1, Math.round(num(opts.count, 1)));
  const out = [];
  if (name === 'ring') {
    const offset = num(opts.offsetRad, 0);
    for (let i = 0; i < count; i++) {
      const a = offset + (TAU * i) / count;
      out.push(spec(origin.x, origin.y, Math.cos(a) * speed, Math.sin(a) * speed, r, kindAt(i)));
    }
    return out;
  }
  if (name === 'spiralStep') {
    const step = num(opts.angleStepDeg, 17) * DEG;
    const index = Math.round(num(opts.index, 0));
    const offset = num(opts.offsetRad, 0);
    for (let i = 0; i < count; i++) {
      const a = offset + step * index + (TAU * i) / count;
      out.push(spec(origin.x, origin.y, Math.cos(a) * speed, Math.sin(a) * speed, r, kindAt(i)));
    }
    return out;
  }
  if (name === 'spread' || name === 'sweep') {
    const arc = num(opts.arcDeg, 30) * DEG;
    const base = aimAngle(origin, opts.target);
    const shift = name === 'sweep' ? Math.sin(num(opts.index, 0) * 0.9) * arc * 0.25 : 0;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const a = base - arc / 2 + arc * t + shift;
      out.push(spec(origin.x, origin.y, Math.cos(a) * speed, Math.sin(a) * speed, r, kindAt(i)));
    }
    return out;
  }
  if (name === 'arc') {
    const radius = num(opts.radius, 60);
    const facing = num(opts.facing, Math.PI / 2);
    for (let i = 0; i < count; i++) {
      const a = facing - Math.PI / 2 + (Math.PI * i) / Math.max(1, count - 1);
      const bx = origin.x + Math.cos(a) * radius;
      const by = origin.y + Math.sin(a) * radius;
      out.push(spec(bx, by, Math.cos(a) * speed, Math.sin(a) * speed, r, kindAt(i)));
    }
    return out;
  }
  // 'aimed' and anything unknown: a single shot straight at the ship.
  const a = aimAngle(origin, opts.target);
  for (let i = 0; i < count; i++) {
    out.push(spec(origin.x, origin.y, Math.cos(a) * speed, Math.sin(a) * speed, r, kindAt(i)));
  }
  return out;
}

/** Ask the game layer for specs first, then patterns.mjs, then fall back. */
function resolveSpecs(name, origin, opts, ctx) {
  if (ctx && typeof ctx.patternSpecs === 'function') {
    const out = ctx.patternSpecs(name, origin, opts);
    if (Array.isArray(out)) return out;
  }
  const table = ctx && ctx.patterns;
  if (table && typeof table[name] === 'function') {
    const out = table[name](origin, opts);
    if (Array.isArray(out)) return out;
  }
  return localPattern(name, origin, opts);
}

/** Push specs wherever the game layer wants them (hook, system or raw array). */
function emitSpecs(specs, enemy, ctx) {
  if (!Array.isArray(specs) || specs.length === 0) return;
  if (ctx && typeof ctx.fireBullets === 'function') {
    ctx.fireBullets(specs, enemy);
    return;
  }
  const system = ctx && (ctx.bulletSystem || ctx.bullets);
  if (system && typeof system.spawn === 'function') {
    for (const s of specs) system.spawn(s);
    return;
  }
  if (Array.isArray(ctx && ctx.bullets)) {
    for (const s of specs) ctx.bullets.push(s);
    return;
  }
  if (Array.isArray(ctx && ctx.enemyBullets)) {
    for (const s of specs) ctx.enemyBullets.push(s);
  }
}

/* ------------------------------------------------------------------- enemy -- */

function rankOf(ctx) {
  if (!ctx) return 0;
  const raw = Number.isFinite(ctx.rank)
    ? ctx.rank
    : ctx.state && Number.isFinite(ctx.state.rank)
      ? ctx.state.rank
      : 0;
  const rankCfg = (BALANCE && BALANCE.rank) || {};
  return clamp(raw, num(rankCfg.min, 0), num(rankCfg.max, 1));
}

/** Frames between volleys, tightened as rank rises. */
function cadenceFrames(e, ctx) {
  const rankCfg = (BALANCE && BALANCE.rank) || {};
  const scale = num(rankCfg.fireRateScale, 0.45);
  return Math.max(6, Math.round(e.fireCd * (1 - scale * rankOf(ctx))));
}

/** Bullet speed, nudged (never past the readable band) by rank. */
function volleySpeed(e, ctx) {
  const rankCfg = (BALANCE && BALANCE.rank) || {};
  const mul = 1 + num(rankCfg.speedScale, 0.6) * rankOf(ctx) * 0.5;
  const band = bulletCfg();
  const lo = num(band.enemyMinSpeed, 3);
  const hi = num(band.enemyMaxSpeed, 9.5);
  return clamp(e.bulletSpeed * mul, lo, hi);
}

/** Fire one volley of the enemy's configured pattern. */
export function enemyFire(e, ctx) {
  if (!e.pattern || e.fireCd <= 0) return 0;
  const origin = { x: e.x, y: e.y + e.r * 0.4 };
  const target =
    ctx && ctx.player
      ? { x: ctx.player.x, y: ctx.player.y }
      : { x: e.entryX, y: fieldCfg().height };
  const burst = Math.max(1, Math.round(e.burst || 1));
  const speed = volleySpeed(e, ctx);
  const opts = {
    target,
    speed,
    count:
      e.pattern === 'spread'
        ? burst * 2 + 1
        : e.pattern === 'ring'
          ? burst * 3
          : e.pattern === 'arc'
            ? burst * 2 + 1
            : burst,
    arcDeg: e.spreadDeg > 0 ? e.spreadDeg : 30,
    angleStepDeg: e.spiralStepDeg,
    index: e.volley,
    radius: e.r * 2.4,
    facing: Math.atan2(target.y - e.y, target.x - e.x),
    r: num(bulletCfg().enemyR, 5),
  };
  const specs = resolveSpecs(e.pattern, origin, opts, ctx);
  emitSpecs(specs, e, ctx);
  if (ctx && typeof ctx.onEnemyShot === 'function') ctx.onEnemyShot(e, specs);
  return specs.length;
}

/**
 * Arm an existing enemy object for a new life. Keeps the object identity (and
 * therefore every pool slot) stable across spawns.
 */
export function resetEnemy(e, kind = 'grunt', x, y, opts = {}) {
  const spec = enemySpec(kind);
  const field = fieldCfg();
  const common = enemyCfg();

  e.kind = kind;
  e.type = kind;
  e.sprite = typeof opts.sprite === 'string' ? opts.sprite : spec.sprite || kind;
  e.x = num(x, field.centerX);
  e.y = num(y, num(field.spawnY, -48));
  e.vx = 0;
  e.vy = 0;

  e.speed = Math.max(0.05, num(opts.speed, num(spec.speed, DEFAULT_SPEC.speed)));
  e.entrySpeed = Math.max(0.05, num(opts.entrySpeed, Math.max(e.speed, 3.2)));
  e.exitSpeed = Math.max(0.05, num(opts.exitSpeed, Math.max(e.speed * 1.6, 3)));
  e.r = Math.max(1, num(opts.r, num(spec.r, DEFAULT_SPEC.r)));

  const hp = Math.max(1, Math.round(num(opts.hp, num(spec.hp, DEFAULT_SPEC.hp))));
  e.hp = hp;
  e.maxHp = hp;
  e.points = Math.max(0, num(opts.points, num(spec.points, DEFAULT_SPEC.points)));
  e.hitFlash = Math.max(1, Math.round(num(opts.hitFlash, num(spec.hitFlash, common.hitFlash || 6))));
  e.flash = 0;
  e.drop = clamp(num(opts.drop, num(spec.drop, DEFAULT_SPEC.drop)), 0, 1);

  e.script = typeof opts.script === 'string' ? opts.script : spec.script || DEFAULT_SPEC.script;
  e.scriptFn = scriptFor(e.script);
  e.pattern = opts.pattern !== undefined ? opts.pattern : spec.pattern ?? null;
  e.fireCd = Math.max(0, Math.round(num(opts.fireCd, num(spec.fireCd, 0))));
  e.burst = Math.max(0, Math.round(num(opts.burst, num(spec.burst, DEFAULT_SPEC.burst))));
  e.spreadDeg = num(opts.spreadDeg, num(spec.spreadDeg, DEFAULT_SPEC.spreadDeg));
  e.bulletSpeed = num(opts.bulletSpeed, num(spec.bulletSpeed, DEFAULT_SPEC.bulletSpeed));
  e.spiralStepDeg = num(opts.spiralStepDeg, e.spreadDeg > 0 ? e.spreadDeg * 0.5 : 17);
  e.fireDelay = Math.max(0, Math.round(num(opts.fireDelay, e.fireCd * 0.6)));
  e.fireTimer = e.fireDelay;
  e.volley = 0;

  e.holdY = num(opts.holdY, field.height * 0.24);
  e.turnY = num(opts.turnY, Math.min(e.holdY, field.height * 0.22));
  e.entryX = num(opts.entryX, e.x);
  e.holdFrames = Math.max(0, Math.round(num(opts.holdFrames, 180)));
  e.entryFrames = Math.max(1, (e.holdY - e.y) / Math.max(0.05, e.entrySpeed));
  e.holdUntil = e.entryFrames + e.holdFrames;
  e.sway = num(opts.sway, spec.sway ?? 1.6);
  e.swayPhase = num(opts.swayPhase, 0);
  e.drift = num(opts.drift, 0);
  e.exitDir = num(opts.exitDir, e.x < field.centerX ? -1 : 1);

  e.t = 0;
  e.age = 0;
  e.active = true;
  e.alive = true;
  e.dead = false;
  e.removed = false;
  e.spawnFrame = num(opts.frame, 0);
  e.wave = opts.wave ?? 0;
  e.lane = opts.lane ?? 0;
  e.formation = typeof opts.formation === 'string' ? opts.formation : null;
  return e;
}

/** True once the enemy is past the kill plane in any direction. */
export function enemyOffscreen(e) {
  const field = fieldCfg();
  const margin = num(enemyCfg().despawnMargin, 120);
  if (e.y > num(field.despawnY, field.height + num(field.cullMargin, 96))) return true;
  if (e.x < -margin * 2 || e.x > field.width + margin * 2) return true;
  // Only treat "above the top" as gone once the enemy has had time to enter.
  if (e.t > 60 && e.y < -margin * 2) return true;
  return false;
}

/**
 * Build a live enemy. `opts` overrides anything from the archetype row, and is
 * where waves.mjs injects its per-formation movement instructions.
 */
export function createEnemy(kind = 'grunt', x, y, opts = {}) {
  const e = {
    kind,
    type: kind,
    sprite: kind,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: 13,
    speed: 2,
    entrySpeed: 3.2,
    exitSpeed: 3.2,
    hp: 1,
    maxHp: 1,
    points: 0,
    t: 0,
    age: 0,
    active: true,
    alive: true,
    dead: false,
    removed: false,
    flash: 0,
    hitFlash: 6,
    drop: 0.16,
    script: 'dive',
    scriptFn: scriptFor('dive'),
    pattern: null,
    fireCd: 0,
    fireDelay: 0,
    fireTimer: 0,
    burst: 0,
    spreadDeg: 0,
    spiralStepDeg: 17,
    bulletSpeed: 3.6,
    volley: 0,
    holdY: 0,
    turnY: 0,
    entryX: 0,
    holdFrames: 180,
    entryFrames: 1,
    holdUntil: 1,
    sway: 1.6,
    swayPhase: 0,
    drift: 0,
    exitDir: 1,
    spawnFrame: 0,
    wave: 0,
    lane: 0,
    formation: null,
  };

  e.hitbox = () => ({ x: e.x, y: e.y, r: e.r });

  /** Take damage; returns true when this hit destroyed the enemy. */
  e.damage = (amount, ctx) => {
    if (!e.active) return false;
    const dmg = Math.max(0, num(amount, 0));
    if (dmg <= 0) return false;
    e.hp -= dmg;
    e.flash = e.hitFlash;
    if (ctx && typeof ctx.onHit === 'function') ctx.onHit(e, dmg);
    if (e.hp <= 0) {
      e.hp = 0;
      e.kill(ctx);
      return true;
    }
    return false;
  };
  e.hurt = e.damage;

  /** Retire the enemy without scoring (bomb clear, stage reset). */
  e.kill = (ctx) => {
    if (!e.active) return false;
    e.active = false;
    e.alive = false;
    e.dead = true;
    if (ctx && typeof ctx.onKill === 'function') ctx.onKill(e);
    return true;
  };

  /**
   * Leave the playfield: like `kill()` but explicitly *not* a scoring event, so
   * an enemy that simply flies away can never feed the chain or drop loot.
   */
  e.despawn = (ctx) => {
    if (!e.active) return false;
    e.active = false;
    e.alive = false;
    e.dead = false;
    e.removed = true;
    if (ctx && typeof ctx.onDespawn === 'function') ctx.onDespawn(e);
    return true;
  };

  e.offscreen = () => enemyOffscreen(e);

  /** Advance by an explicit frame count. */
  e.advance = (frames, ctx) => {
    const f = num(frames, 0);
    if (!e.active || f <= 0) return e;
    e.t += f;
    e.age = e.t;
    if (e.flash > 0) e.flash = Math.max(0, e.flash - f);
    e.scriptFn(e, f, ctx);
    if (e.pattern && e.fireCd > 0) {
      if (e.fireDelay > 0) {
        // Windup: no shots until the enemy has settled into its lane.
        e.fireDelay = Math.max(0, e.fireDelay - f);
      } else if (e.y <= 0) {
        // Still above the playfield: hold the cadence at zero so the first
        // volley lands the moment the enemy becomes a real threat.
        e.fireTimer = Math.max(e.fireTimer, 0);
      } else {
        e.fireTimer -= f;
        let guard = 0;
        while (e.fireTimer <= 0 && guard++ < 4) {
          enemyFire(e, ctx);
          e.volley++;
          e.fireTimer += cadenceFrames(e, ctx);
        }
      }
    }
    if (enemyOffscreen(e)) e.despawn(ctx);
    return e;
  };

  /** Advance one fixed step (`dt` in seconds, or a frame count above 0.5). */
  e.update = (dt, ctx) => e.advance(framesOf(dt), ctx);

  e.reset = (nextKind, nx, ny, nextOpts) => resetEnemy(e, nextKind, nx, ny, nextOpts);

  resetEnemy(e, kind, x, y, opts);
  return e;
}

/** Pool factory: `createPool(64, enemyFactory('grunt'))`. */
export function enemyFactory(kind = 'grunt', opts = {}) {
  return () => createEnemy(kind, num(opts.x, fieldCfg().centerX), num(opts.y, num(fieldCfg().spawnY, -48)), opts);
}

export default createEnemy;
