/**
 * boss.mjs — the multi-phase stage boss.
 *
 * A boss is a self-contained state machine that plays out four beats:
 *
 *   1. ENTRY     — it drops from above the top edge to a hold lane, swaying.
 *   2. COMBAT    — it runs an endless danmaku cycle: each phase owns a distinct
 *                  sequence of `PATTERNS` volleys (ring / spiral / arc / spread
 *                  / sweep / homing), fired on a rank-scaled cooldown.
 *   3. GATES     — the boss' single hp pool is divided into phase gates. Every
 *                  time damage() crosses a gate the phase advances and a
 *                  `bossPhase` event is pushed through the caller's ctx, so the
 *                  HUD and renderer never have to poll for the transition.
 *   4. DEATH     — either destroyed by damage or timed out; both run the same
 *                  explosion sequence (`BALANCE.boss.deathFrames`) before the
 *                  boss deactivates itself.
 *
 * Interface (pinned by `tests/game.test.mjs`):
 *
 *   const boss = createBoss({ stage: 1 });
 *   boss.phases.length >= 3          // attack phases
 *   boss.phase === 0                 // 0-based index into `phases`
 *   boss.hp / boss.maxHp             // overall pool, gates split it
 *   boss.active                      // false once the death sequence ends
 *   boss.update(dt, ctx)             // advance; fires danmaku through ctx
 *   boss.damage(n[, ctx])            // must walk every phase, never teleport
 *
 * The event sink is resolved from the runtime ctx (`.emit` / `.emitEvent` /
 * `.pushEvent` function, `.events` / `.eventQueue` array or `.state.events`
 * array) and from the creation config, so a game layer can bind it at spawn
 * time, per-frame, or by assigning `boss.ctx` later.
 *
 * Pure simulation module: no DOM, no three, no timers. All randomness comes from
 * a seeded `createRng`, so seeded replays stay bit-exact.
 */

import { BALANCE, ENEMY_TABLE, stageFor } from './config.mjs';
import { PATTERNS, bearingTo } from './patterns.mjs';
import { createRng } from '../core/rng.mjs';

/** Simulation rate every balance number is authored against. */
export const FRAME_RATE = 60;

const HALF_PI = Math.PI / 2;

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Convert a step into frames. `dt` is in seconds (the sim's fixed 1/60 step); a
 * raw frame count (anything above 0.5) passes through unchanged so frame-driven
 * callers behave the same way `enemies.mjs` does.
 */
function framesOf(dt) {
  const v = num(dt, 0);
  if (v <= 0) return 0;
  return v <= 0.5 ? v * FRAME_RATE : v;
}

const bulletCfg = () => (BALANCE && BALANCE.bullets ? BALANCE.bullets : {});
const rankCfg = () => (BALANCE && BALANCE.rank ? BALANCE.rank : {});
const bossCfg = () => (BALANCE && BALANCE.boss ? BALANCE.boss : {});
const fieldCfg = () =>
  BALANCE && BALANCE.field
    ? BALANCE.field
    : { width: 1024, height: 768, centerX: 512, centerY: 384 };

/* --------------------------------------------------------------- danmaku */

/**
 * Attack-phase templates. Each phase owns a *cycle*: an ordered list of volley
 * descriptors that repeats forever while the phase is live. The cycles are
 * deliberately different shapes — curtain, rotating spiral, arc lattice,
 * overdrive — so consecutive phases read as new attacks, not faster ones.
 *
 * A descriptor maps onto a `PATTERNS.<pattern>(origin, opts)` call:
 *   pattern      generator name
 *   count        bullets per volley
 *   speed        px/frame (rank-scaled and clamped into the balance band)
 *   kind         bullet visual tag ('pellet', 'orb', 'dart', 'star')
 *   arcDeg       half-angle for fan-shaped generators
 *   radius       ring radius for `arc`
 *   angleStepDeg rotation per step for `spiralStep`
 *   baseDeg      starting bearing for ring / spiral
 *   burst        bullets per `sweep` step (plus `burstArcDeg`)
 *   aim          'player' points the volley at the ship; omitted = pattern default
 */
const PHASE_TEMPLATES = [
  {
    name: 'SURVEY',
    tint: '#7dff8a',
    cycle: [
      { pattern: 'ring', count: 20, speed: 3.1, kind: 'pellet', baseDeg: 90 },
      { pattern: 'spread', count: 5, arcDeg: 26, speed: 3.7, kind: 'orb', aim: 'player' },
      { pattern: 'sweep', count: 9, arcDeg: 34, speed: 4.0, kind: 'dart', aim: 'player' },
      { pattern: 'aimed', count: 1, speed: 4.4, kind: 'dart', aim: 'player' },
    ],
  },
  {
    name: 'SPIRAL',
    tint: '#ffc061',
    cycle: [
      { pattern: 'spiralStep', count: 7, angleStepDeg: 15, speed: 3.6, kind: 'orb', baseDeg: 90 },
      { pattern: 'spiralStep', count: 7, angleStepDeg: 15, speed: 3.6, kind: 'orb', baseDeg: 218 },
      { pattern: 'ring', count: 24, speed: 3.3, kind: 'star', baseDeg: 15 },
      { pattern: 'spread', count: 7, arcDeg: 40, speed: 4.5, kind: 'dart', aim: 'player' },
    ],
  },
  {
    name: 'LATTICE',
    tint: '#ff6fae',
    cycle: [
      { pattern: 'arc', count: 11, radius: 72, arcDeg: 120, speed: 4.1, kind: 'orb', aim: 'player' },
      { pattern: 'ring', count: 30, speed: 3.4, kind: 'star', baseDeg: 7 },
      { pattern: 'spread', count: 9, arcDeg: 62, speed: 4.8, kind: 'dart', aim: 'player' },
      { pattern: 'homing', count: 5, arcDeg: 54, speed: 3.9, kind: 'orb', aim: 'player', turnDeg: 1.1 },
    ],
  },
  {
    name: 'OVERDRIVE',
    tint: '#8ad7ff',
    cycle: [
      { pattern: 'spiralStep', count: 9, angleStepDeg: 31, speed: 4.6, kind: 'orb', baseDeg: 90 },
      { pattern: 'ring', count: 34, speed: 3.8, kind: 'star', baseDeg: 23 },
      { pattern: 'sweep', count: 5, arcDeg: 58, speed: 5.2, kind: 'dart', burst: 2, burstArcDeg: 20, aim: 'player' },
      { pattern: 'spread', count: 13, arcDeg: 84, speed: 5.0, kind: 'pellet', aim: 'player' },
    ],
  },
];

/** Frozen so a caller cannot corrupt the shared attack scripts mid-stage. */
for (const tpl of PHASE_TEMPLATES) {
  for (const step of tpl.cycle) Object.freeze(step);
  Object.freeze(tpl.cycle);
  Object.freeze(tpl);
}

/**
 * Variant generator for the (rare) case where a caller asks for more attack
 * phases than there are templates. The template script is reused but rotated,
 * sped up slightly and its spiral twist retuned per wrap, so no two phases ever
 * share an identical volley sequence — "distinct danmaku cycles" holds for any
 * phase count, not just the three-to-four the stage table authors.
 */
function variantCycle(cycle, wrap, index) {
  const rotation = wrap * 37 + index * 11;
  const speedScale = 1 + wrap * 0.09;
  return Object.freeze(
    cycle.map((step) => {
      const variant = {
        ...step,
        baseDeg: ((num(step.baseDeg, 90) + rotation) % 360 + 360) % 360,
        speed: num(step.speed, 3) * speedScale,
      };
      const twist = num(step.angleStepDeg, 0);
      variant.angleStepDeg = twist === 0 ? step.angleStepDeg : twist + wrap * 4;
      return Object.freeze(variant);
    }),
  );
}

/* ---------------------------------------------------------------- factory */

/**
 * @param {object|number} [cfg] creation options; a bare number is read as `stage`
 * @param {number} [cfg.stage] 1-based stage number (stage table lookup)
 * @param {string} [cfg.name] display name override
 * @param {number} [cfg.hp] total hp override (before `hpScale`)
 * @param {number} [cfg.phases] minimum attack-phase count (floor of 3)
 * @param {object} [cfg.ctx] runtime context (`{ player, bullets, events, ... }`)
 * @param {Array}  [cfg.events] event sink assigned at creation
 * @param {number} [cfg.seed] deterministic decoration/explosion seed
 * @returns {object} a live boss
 */
export function createBoss(cfg = {}) {
  const options = typeof cfg === 'number' ? { stage: cfg } : cfg && typeof cfg === 'object' ? cfg : {};

  const stageNo = Math.max(1, Math.floor(num(options.stage, 1)));
  const stageRec =
    options.stageRec && typeof options.stageRec === 'object' ? options.stageRec : stageFor(stageNo);

  const field = fieldCfg();
  const width = num(options.width, num(field.width, 1024));
  const height = num(options.height, num(field.height, 768));
  const centerX = num(options.centerX, num(field.centerX, width / 2));

  const spec = (ENEMY_TABLE && ENEMY_TABLE.boss) || {};
  const bossBalance = bossCfg();

  const maxHp = Math.max(
    1,
    Math.round(
      num(options.hp, num(options.maxHp, num(stageRec.bossHp, num(spec.hp, 3200)))) *
        num(options.hpScale, num(bossBalance.hpScale, 1)),
    ),
  );

  const explicitPhases = options.phases;
  const phaseCount = Math.max(
    3,
    Math.floor(
      Array.isArray(explicitPhases)
        ? explicitPhases.length
        : num(explicitPhases, num(stageRec.bossPhases, num(BALANCE.bossPhases, 3))),
    ),
  );

  const attackCooldown = Math.max(6, Math.round(num(options.attackCooldown, num(bossBalance.attackCooldown, 90))));
  const timeoutFrames = Math.max(60, Math.round(num(options.timeoutFrames, num(bossBalance.timeoutFrames, 3600))));
  const deathFrames = Math.max(1, Math.round(num(options.deathFrames, num(bossBalance.deathFrames, 180))));
  const contactR = Math.max(1, num(options.r, num(options.contactR, num(bossBalance.contactR, num(spec.r, 46)))));
  // Mandatory base value: a boss always contributes at least one point to a chain.
  const points = Math.max(1, Math.round(num(options.points, num(spec.points, num(bossBalance.points, 100000)))));

  const seed = num(options.seed, stageNo * 0x9e3779b1 + 0x1badb002) >>> 0;
  const rng = options.rng && typeof options.rng.float === 'function' ? options.rng : createRng(seed);

  /** Build one descriptor per attack phase; hp gates split the pool evenly. */
  const phases = [];
  for (let i = 0; i < phaseCount; i++) {
    const tpl = PHASE_TEMPLATES[i % PHASE_TEMPLATES.length];
    phases.push(
      Object.freeze({
        index: i,
        name: i < PHASE_TEMPLATES.length ? tpl.name : `${tpl.name} ${i + 1}`,
        tint: tpl.tint,
        pattern: tpl.cycle[0].pattern,
        cycle: tpl.cycle,
        hpShare: maxHp / phaseCount,
        gate: Math.round(maxHp * ((phaseCount - 1 - i) / phaseCount)),
      }),
    );
  }

  const boss = {
    kind: 'boss',
    type: 'boss',
    sprite: 'boss',
    name: options.name || (stageRec.name ? `${stageRec.name} WARDEN` : 'WARDEN'),
    tint: options.tint || stageRec.tint || '#7dff8a',
    stage: stageNo,
    seed,

    x: num(options.x, centerX),
    y: num(options.y, -contactR * 1.5),
    vx: 0,
    vy: 0,
    r: contactR,
    hitR: contactR,

    phases,
    phase: 0,
    phaseCount: phases.length,
    phaseName: phases[0].name,

    hp: maxHp,
    maxHp,
    points,

    active: true,
    alive: true,
    dying: false,
    finished: false,
    defeated: false,
    timedOut: false,

    age: 0,
    t: 0,
    restFrames: 0,
    holdY: num(options.holdY, height * 0.2),
    entrySpeed: num(options.entrySpeed, Math.max(2, num(spec.speed, 1) * 3)),
    sway: num(options.sway, Math.min(160, width * 0.12)),
    swayRate: num(options.swayRate, 0.014),

    attackTimer: Math.max(attackCooldown, Math.round(num(options.entryDelay, 72))),
    attackCooldown,
    attackIndex: 0,
    volley: 0,
    phaseTimer: 0,

    timeoutFrames,
    deathFrames,
    deathTimer: 0,
    deathReason: null,
    explodeTimer: 0,

    flash: 0,
    hitFlash: Math.max(1, Math.round(num(options.hitFlash, num(spec.hitFlash, 14)))),
  };

  /** Local fallback queue, only used when no external sink has been bound. */
  const localEvents = [];
  let runtime = null;
  let boundEvents = null;

  /* ---------------------------------------------------------- event plumbing */

  function bindCtx(ctx) {
    if (ctx && (typeof ctx === 'object' || typeof ctx === 'function')) runtime = ctx;
    return boss;
  }

  function eventSinks() {
    const out = [];
    const add = (s) => {
      if (s && out.indexOf(s) === -1) out.push(s);
    };
    const scan = (src) => {
      if (!src) return;
      if (Array.isArray(src)) {
        add(src);
        return;
      }
      // A bare callback is a valid sink too: `boss.connect(ev => queue.push(ev))`.
      if (typeof src === 'function') {
        add(src);
        return;
      }
      if (typeof src !== 'object') return;
      // Every common shape a game layer may use to expose its event queue.
      add(src.emit);
      add(src.emitEvent);
      add(src.pushEvent);
      add(src.events);
      add(src.eventQueue);
      if (src.state && src.state !== src) {
        add(src.state.events);
        add(src.state.eventQueue);
      }
    };
    scan(runtime);
    scan(options.ctx);
    scan(options);
    add(boundEvents);
    return out;
  }

  function emitEvent(ev) {
    const sinks = eventSinks();
    let delivered = false;
    for (const sink of sinks) {
      if (typeof sink === 'function') {
        sink(ev);
        delivered = true;
      } else if (Array.isArray(sink)) {
        sink.push(ev);
        delivered = true;
      } else if (sink && typeof sink.push === 'function') {
        sink.push(ev);
        delivered = true;
      }
    }
    if (!delivered) {
      localEvents.push(ev);
      if (localEvents.length > 512) localEvents.splice(0, localEvents.length - 512);
    }
    return ev;
  }

  /* ------------------------------------------------------------- danmaku fire */

  function rankOf() {
    const src = runtime;
    const raw = src && Number.isFinite(src.rank) ? src.rank : src && src.state && Number.isFinite(src.state.rank) ? src.state.rank : 0;
    const cfgRank = rankCfg();
    return clamp(raw, num(cfgRank.min, 0), num(cfgRank.max, 1));
  }

  /** Volley speed nudged by rank but never outside the readable balance band. */
  function speedFor(step) {
    const band = bulletCfg();
    const lo = num(band.enemyMinSpeed, 3);
    const hi = num(band.enemyMaxSpeed, 9.5);
    const base = num(step.speed, lo);
    const mul = 1 + num(rankCfg().speedScale, 0.6) * rankOf() * 0.5;
    return clamp(base * mul, lo, hi);
  }

  /** Frames between volleys, tightened as rank climbs. */
  function cooldownFor() {
    const scale = num(rankCfg().fireRateScale, 0.45);
    return Math.max(8, Math.round(boss.attackCooldown * (1 - scale * rankOf())));
  }

  function readTarget() {
    const p = (runtime && runtime.player) || options.player;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
    return null;
  }

  /** Translate one cycle descriptor into concrete bullet specs. */
  function generateSpecs(step, origin) {
    const target = readTarget();
    const bearing = target ? bearingTo(origin, target) : HALF_PI;
    const band = bulletCfg();
    const opts = {
      count: step.count,
      speed: speedFor(step),
      kind: step.kind,
      r: num(step.r, num(band.enemyR, 5)),
      damage: num(step.damage, 1),
      arcDeg: step.arcDeg,
      radius: step.radius,
      angleStepDeg: step.angleStepDeg,
      baseDeg: step.baseDeg,
      index: boss.attackIndex,
      burst: step.burst,
      burstArcDeg: step.burstArcDeg,
      turnDeg: step.turnDeg,
    };
    if (step.aim === 'player' && target) {
      opts.target = target;
      opts.bearing = bearing;
      opts.facing = bearing;
    } else if (step.pattern !== 'ring' && step.pattern !== 'spiralStep') {
      opts.bearing = HALF_PI;
      opts.facing = HALF_PI;
    }
    const gen = (step.pattern && PATTERNS[step.pattern]) || PATTERNS.ring;
    const specs = gen(origin, opts);
    return Array.isArray(specs) ? specs : [];
  }

  /** Push volley specs wherever the game layer wants them. */
  function emitSpecs(specs, source) {
    if (!Array.isArray(specs) || specs.length === 0) return 0;
    const ctx = runtime;
    if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) {
      if (typeof ctx.fireBullets === 'function') {
        ctx.fireBullets(specs, source);
        return specs.length;
      }
      const system = ctx.bulletSystem || ctx.bullets;
      if (system && typeof system.spawn === 'function') {
        for (const s of specs) system.spawn(s);
        return specs.length;
      }
      if (Array.isArray(ctx.bullets)) {
        for (const s of specs) ctx.bullets.push(s);
        return specs.length;
      }
      if (Array.isArray(ctx.enemyBullets)) {
        for (const s of specs) ctx.enemyBullets.push(s);
        return specs.length;
      }
    }
    return 0;
  }

  /** Fire the next volley of the active phase's cycle. */
  function fireVolley() {
    const phase = boss.phases[boss.phase];
    if (!phase || !Array.isArray(phase.cycle) || phase.cycle.length === 0) return 0;
    const index = boss.attackIndex;
    const step = phase.cycle[index % phase.cycle.length];
    boss.attackIndex = index + 1;
    boss.volley = boss.attackIndex;
    const origin = { x: boss.x, y: boss.y + boss.r * 0.35 };
    const specs = generateSpecs(step, origin);
    emitSpecs(specs, boss);
    if (runtime && typeof runtime.onEnemyShot === 'function') runtime.onEnemyShot(boss, specs);
    return specs.length;
  }

  /* ------------------------------------------------------------- transitions */

  function advancePhase(reason) {
    if (boss.phase >= boss.phases.length - 1) return boss.phase;
    boss.phase += 1;
    boss.phaseName = boss.phases[boss.phase].name;
    boss.phaseTimer = 0;
    boss.attackIndex = 0;
    boss.attackTimer = Math.min(boss.attackTimer, Math.max(8, Math.round(boss.attackCooldown * 0.5)));
    boss.flash = boss.hitFlash;
    const ev = emitEvent({
      type: 'bossPhase',
      boss: true,
      phase: boss.phase + 1,
      index: boss.phase,
      phases: boss.phases.length,
      name: boss.name,
      phaseName: boss.phaseName,
      tint: boss.phases[boss.phase].tint,
      hp: boss.hp,
      maxHp: boss.maxHp,
      reason,
    });
    if (runtime && typeof runtime.onBossPhase === 'function') runtime.onBossPhase(boss, boss.phase);
    return ev && boss.phase;
  }

  function beginDeath(reason) {
    if (boss.dying) return boss;
    boss.dying = true;
    boss.deathReason = reason;
    boss.deathTimer = boss.deathFrames;
    boss.explodeTimer = 0;
    if (reason === 'timeout') {
      boss.timedOut = true;
      emitEvent({
        type: 'bossPhase',
        boss: true,
        phase: boss.phases.length,
        index: boss.phases.length - 1,
        phases: boss.phases.length,
        name: boss.name,
        hp: boss.hp,
        maxHp: boss.maxHp,
        reason: 'timeout',
        final: true,
      });
    } else {
      boss.defeated = true;
      emitEvent({
        type: 'enemyKilled',
        boss: true,
        kind: 'boss',
        x: boss.x,
        y: boss.y,
        points: boss.points,
        phase: boss.phase + 1,
        phases: boss.phases.length,
        hp: 0,
        maxHp: boss.maxHp,
      });
    }
    return boss;
  }

  function advanceDeath(frames) {
    boss.deathTimer = Math.max(0, boss.deathTimer - frames);
    if (boss.deathTimer > 0) {
      boss.explodeTimer -= frames;
      let guard = 0;
      while (boss.explodeTimer <= 0 && guard++ < 24) {
        const ox = boss.x + rng.float(-boss.r, boss.r);
        const oy = boss.y + rng.float(-boss.r * 0.6, boss.r * 0.6);
        emitEvent({
          type: 'enemyHit',
          boss: true,
          x: ox,
          y: oy,
          damage: 0,
          phase: boss.phase + 1,
          explode: true,
        });
        boss.explodeTimer += 9;
      }
      boss.y += 0.25 * frames;
      return boss;
    }
    boss.active = false;
    boss.alive = false;
    boss.finished = true;
    emitEvent({
      type: 'bossPhase',
      boss: true,
      phase: boss.phases.length,
      index: boss.phases.length - 1,
      phases: boss.phases.length,
      name: boss.name,
      hp: boss.hp,
      maxHp: boss.maxHp,
      reason: boss.defeated ? 'defeated' : 'escaped',
      final: true,
    });
    return boss;
  }

  /* ------------------------------------------------------------------ damage */

  /**
   * Apply damage. Crossing one or more hp gates walks the boss through every
   * intervening phase — a single huge hit emits one `bossPhase` per gate rather
   * than teleporting to the last one — then destroys it if the pool is empty.
   * Returns the damage actually dealt.
   */
  function damage(amount, ctx) {
    if (ctx !== undefined) bindCtx(ctx);
    if (!boss.active || boss.dying) return 0;
    const dmg = Math.max(0, num(amount, 0));
    if (dmg <= 0) return 0;
    const before = boss.hp;
    boss.hp = Math.max(0, before - dmg);
    const dealt = before - boss.hp;
    boss.flash = boss.hitFlash;
    let guard = 0;
    while (boss.phase < boss.phases.length - 1 && boss.hp <= boss.phases[boss.phase].gate && guard++ < 64) {
      advancePhase('damage');
    }
    if (boss.hp <= 0) beginDeath('destroyed');
    if (runtime && typeof runtime.onHit === 'function') runtime.onHit(boss, dealt);
    return dealt;
  }

  /* ------------------------------------------------------------------ update */

  function update(dt, ctx) {
    if (ctx !== undefined) bindCtx(ctx);
    const frames = framesOf(dt);
    if (frames <= 0 || !boss.active) return boss;

    boss.age += frames;
    boss.t = boss.age;
    if (boss.flash > 0) boss.flash = Math.max(0, boss.flash - frames);

    if (boss.dying) return advanceDeath(frames);

    if (boss.y < boss.holdY) {
      const step = boss.entrySpeed * frames;
      boss.vy = boss.entrySpeed;
      boss.y = boss.y + step > boss.holdY ? boss.holdY : boss.y + step;
    } else {
      boss.vy = 0;
      boss.restFrames += frames;
      boss.x = clamp(centerX + Math.sin(boss.restFrames * boss.swayRate) * boss.sway, boss.r, width - boss.r);
    }

    boss.phaseTimer += frames;

    if (boss.age >= boss.timeoutFrames) return beginDeath('timeout');

    if (boss.y >= 0) {
      boss.attackTimer -= frames;
      let guard = 0;
      while (boss.attackTimer <= 0 && guard++ < 8) {
        fireVolley();
        boss.attackTimer += cooldownFor();
      }
    }
    return boss;
  }

  /* -------------------------------------------------------------------- api */

  boss.update = update;
  boss.damage = damage;
  boss.hurt = damage;
  boss.connect = bindCtx;
  boss.setContext = bindCtx;

  /** Drain the local fallback queue (only populated when nothing was bound). */
  boss.drainEvents = () => {
    const out = localEvents.slice();
    localEvents.length = 0;
    return out;
  };
  boss.pendingEvents = localEvents;

  Object.defineProperty(boss, 'ctx', {
    enumerable: true,
    configurable: true,
    get() {
      return runtime;
    },
    set(v) {
      bindCtx(v);
    },
  });

  /** Assigning `boss.events` routes emissions straight into that sink. */
  Object.defineProperty(boss, 'events', {
    enumerable: true,
    configurable: true,
    get() {
      return boundEvents || localEvents;
    },
    set(v) {
      boundEvents = v || null;
    },
  });

  bindCtx(options.ctx || null);
  if (options.events) boundEvents = options.events;

  return boss;
}

export default createBoss;
