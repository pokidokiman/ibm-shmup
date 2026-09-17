/**
 * config.mjs — the single source of BALANCE truth for the whole game.
 *
 * Every tunable number lives here: the playfield, the player, danmaku speeds,
 * scoring/extend rules, power tiers, enemy archetypes and the per-stage
 * timeline. `src/core/*` and `src/game/*` are pure modules, so this file must
 * stay data-only: no DOM, no three, no side effects.
 *
 * Units (kept consistent across every table):
 *   • positions / radii  -> playfield pixels (fixed 1024 x 768 design space)
 *   • speeds             -> pixels per simulated frame (the sim runs at 60 Hz)
 *   • durations / counts -> frames at 60 Hz unless the name says otherwise
 *   • angles             -> degrees in the tables, radians only inside maths
 */

/** Design resolution of the playfield. Rendering letterboxes this 4:3 space. */
export const FIELD = Object.freeze({
  width: 1024,
  height: 768,
  centerX: 512,
  centerY: 384,
  /** Kill-plane padding: bullets/items are culled this far past an edge. */
  cullMargin: 96,
});

/** Simulation cadence. Fixed timestep keeps replays bit-for-bit identical. */
export const SIM = Object.freeze({
  dt: 1 / 60,
  maxSteps: 8,
  hz: 60,
});

/* ------------------------------------------------------------------ balance */

export const BALANCE = {
  /** Playfield geometry, mirrored by `FIELD` for convenience. */
  field: {
    width: FIELD.width,
    height: FIELD.height,
    centerX: FIELD.centerX,
    centerY: FIELD.centerY,
    cullMargin: FIELD.cullMargin,
    /** Spawn lanes: enemies enter just above the top edge. */
    spawnY: -48,
    /** Everything below this line is considered gone. */
    despawnY: FIELD.height + FIELD.cullMargin,
  },

  /** Fixed-step simulation budget shared with src/core/clock.mjs. */
  sim: {
    dt: SIM.dt,
    maxSteps: SIM.maxSteps,
  },

  player: {
    /** Normal / focused (slow) movement in pixels per frame. */
    speed: 4.2,
    focusSpeed: 1.9,
    /** Tight Cave-style hitbox: a single 2px circle at the cockpit. */
    hitR: 2,
    /** Graze band: enemy bullets inside this radius of the cockpit score. */
    grazeR: 18,
    /** Starting stock. */
    lives: 3,
    bombs: 3,
    /** Frames of invulnerability granted when a life is lost. */
    invulnFrames: 150,
    /** Frames of invulnerability after a bomb / on spawn. */
    spawnInvuln: 90,
    bombInvuln: 180,
    /** Frames between player shot volleys (lower = faster fire). */
    fireCooldown: 4,
    /** Weapon origin offsets from the cockpit, in pixels. */
    muzzleY: -12,
    muzzleSpread: 9,
    /** Focus mode trades speed for a narrower, denser shot grouping. */
    focusSpreadScale: 0.35,
    /** Corner radius used when clamping the ship inside the playfield. */
    clampMargin: 10,
    /** Vertical offset of the cockpit above the ship centre. */
    cockpitY: -4,
  },

  bullets: {
    /** Player shot speed — faster than any enemy bullet. */
    playerSpeed: 9.5,
    playerR: 4,
    /** Enemy danmaku speeds span a readable 3.0–9.5 px/frame band. */
    enemyMinSpeed: 3.0,
    enemyMaxSpeed: 9.5,
    enemyR: 5,
    /** Hard caps so pools never exhaust under a dense curtain. */
    playerMax: 256,
    enemyMax: 2048,
    itemMax: 128,
    /** Frames a live bullet may exist before it is force-retired. */
    lifetime: 900,
    /** Lasers: pooled beams with a charge windup. */
    laserR: 7,
    laserWarnFrames: 24,
    laserActiveFrames: 90,
    /** Visual/behaviour kinds used by the pattern generators. */
    kinds: ['pellet', 'orb', 'dart', 'laser', 'star'],
  },

  /** Bomb: screen-clearing panic button with a long invulnerable span. */
  bomb: {
    duration: 180,
    damage: 220,
    radius: 360,
    invuln: 240,
    scorePerHit: 150,
    stockCap: 8,
  },

  /** Pickups dropped by destroyed enemies. */
  item: {
    fallSpeed: 2.4,
    r: 12,
    /** Above this y the player's collector sweeps the whole screen. */
    autoCollectY: 180,
    magnetSpeed: 7.5,
    lifetime: 720,
    scoreValue: 2500,
  },

  /** Scoring / chain / graze economy. */
  scorePerHit: 10,
  grazeScore: 25,
  chainTimeout: 120,
  chainMax: 9999,
  /** Chain bonus multiplier: score * (1 + chain * chainStep). */
  chainStep: 0.02,
  chainStepCap: 3,
  /** Extra life every 2,000,000 points. */
  extendScore: 2000000,
  extendMax: 8,
  /** Multiplier applied to an enemy's own points value on kill. */
  killMultiplier: 1,

  /** Dynamic rank: pressure scales with how well the player is doing. */
  rank: {
    min: 0,
    max: 1,
    start: 0.15,
    /** Rank gained per graze / per kill. */
    grazeGain: 0.00035,
    killGain: 0.0012,
    /** Passive decay per frame plus a larger drop on death/bomb. */
    decay: 0.00006,
    deathDrop: 0.35,
    bombDrop: 0.15,
    /** Rank feeds bullet speed and enemy fire cadence. */
    speedScale: 0.6,
    fireRateScale: 0.45,
    hpScale: 0.5,
  },

  /** Number of weapon tiers; must match POWERUP_TABLE.length. */
  powerTiers: 4,

  /** Minimum boss phase count per stage (STAGE_TABLE may raise it). */
  bossPhases: 3,

  /** Boss pressure/telegraph tuning. */
  boss: {
    hpScale: 1,
    timeoutFrames: 3600,
    /** Frames between attack cycles while a phase is active. */
    attackCooldown: 90,
    /** Frames of gate-warning before a phase transition. */
    phaseWarn: 45,
    /** Post-death explosion sequence length before the stage clears. */
    deathFrames: 180,
    contactR: 40,
    points: 100000,
  },

  /** Enemy common defaults; ENEMY_TABLE overrides per archetype. */
  enemy: {
    baseHp: 10,
    basePoints: 200,
    contactR: 16,
    /** Frames of hitstop flash after taking damage. */
    hitFlash: 6,
    /** Off-screen grace before an enemy is recycled. */
    despawnMargin: 120,
    maxActive: 220,
  },

  /** Feedback / presentation knobs the render layer reads. */
  fx: {
    shakeDecay: 0.88,
    hitShake: 2,
    killShake: 4,
    bossShake: 9,
    bombShake: 14,
    /** Event queue is drained by the renderer each frame. */
    eventBudget: 4096,
  },

  /** Stage-agnostic pacing floors so a stage never goes quiet. */
  pacing: {
    minSpawnGapFrames: 12,
    maxSpawnGapFrames: 96,
    /** Fraction of the stage considered the midboss band. */
    midbossWindow: 0.08,
  },
};

/* ------------------------------------------------------------- power tiers */

/**
 * Weapon tiers, index 0 = pick-up level 1. `shots` is the number of bullet
 * streams fired per volley; the game caps the player at BALANCE.powerTiers.
 */
export const POWERUP_TABLE = [
  {
    tier: 1,
    shots: 1,
    spreadDeg: 0,
    cooldown: 5,
    damage: 1,
    speedScale: 1,
    laser: false,
    powered: 0,
    label: 'PULSE',
  },
  {
    tier: 2,
    shots: 2,
    spreadDeg: 8,
    cooldown: 5,
    damage: 1,
    speedScale: 1,
    laser: false,
    powered: 2,
    label: 'TWIN',
  },
  {
    tier: 3,
    shots: 3,
    spreadDeg: 12,
    cooldown: 4,
    damage: 1.25,
    speedScale: 1,
    laser: true,
    powered: 4,
    label: 'TRIDENT',
  },
  {
    tier: 4,
    shots: 4,
    spreadDeg: 18,
    cooldown: 4,
    damage: 1.5,
    speedScale: 1.1,
    laser: true,
    powered: 6,
    label: 'NOVA',
  },
];

/** Lookup a tier record by 1-based power level, clamped into range. */
export function tierFor(power) {
  const i = Math.max(1, Math.min(POWERUP_TABLE.length, Math.floor(power) || 1));
  return POWERUP_TABLE[i - 1];
}

/* --------------------------------------------------------------- drop table */

/**
 * Weighted pickup lottery consumed by `dropFor()`. Weights are relative; the
 * array order also defines the deterministic scan order for the PRNG.
 */
export const DROP_TABLE = [
  { kind: 'power', weight: 58, label: 'POWER UP' },
  { kind: 'score', weight: 27, label: 'BONUS' },
  { kind: 'bomb', weight: 10, label: 'BOMB' },
  { kind: 'life', weight: 5, label: '1 UP' },
];

/** Per-archetype chance that a kill rolls the DROP_TABLE at all. */
export const DROP_CHANCE = {
  popcorn: 0.18,
  grunt: 0.3,
  turret: 0.55,
  heavy: 0.75,
  midboss: 1,
  boss: 1,
};

/* ------------------------------------------------------------- enemy table */

/**
 * Enemy archetypes. Every entry carries enough data for enemies.mjs to build a
 * live entity without further lookups: durability, size, movement, fire
 * pattern and reward. `script` names a movement routine, `pattern` names one
 * of the generators in patterns.mjs.
 */
export const ENEMY_TABLE = {
  popcorn: {
    hp: 4,
    r: 10,
    speed: 3.0,
    points: 150,
    script: 'dive',
    pattern: null,
    fireCd: 0,
    burst: 0,
    spreadDeg: 0,
    bulletSpeed: 3.0,
    sprite: 'popcorn',
    hitFlash: 4,
    drop: 0.18,
  },
  grunt: {
    hp: 12,
    r: 13,
    speed: 1.8,
    points: 320,
    script: 'crossDown',
    pattern: 'aimed',
    fireCd: 96,
    burst: 1,
    spreadDeg: 0,
    bulletSpeed: 3.6,
    sprite: 'grunt',
    hitFlash: 6,
    drop: 0.3,
  },
  turret: {
    hp: 44,
    r: 20,
    speed: 0.7,
    points: 900,
    script: 'hold',
    pattern: 'ring',
    fireCd: 84,
    burst: 2,
    spreadDeg: 0,
    bulletSpeed: 4.2,
    sprite: 'turret',
    hitFlash: 8,
    drop: 0.55,
  },
  heavy: {
    hp: 96,
    r: 24,
    speed: 1.0,
    points: 1800,
    script: 'crossHold',
    pattern: 'spread',
    fireCd: 76,
    burst: 3,
    spreadDeg: 34,
    bulletSpeed: 4.8,
    sprite: 'heavy',
    hitFlash: 10,
    drop: 0.75,
  },
  midboss: {
    hp: 520,
    r: 34,
    speed: 1.2,
    points: 12000,
    script: 'midboss',
    pattern: 'spiralStep',
    fireCd: 60,
    burst: 4,
    spreadDeg: 46,
    bulletSpeed: 5.2,
    sprite: 'midboss',
    hitFlash: 12,
    drop: 1,
  },
  boss: {
    hp: 3200,
    r: 46,
    speed: 0.9,
    points: 100000,
    script: 'boss',
    pattern: 'ring',
    fireCd: 72,
    burst: 5,
    spreadDeg: 62,
    bulletSpeed: 5.6,
    sprite: 'boss',
    hitFlash: 14,
    drop: 1,
  },
};

/* --------------------------------------------------------------- stage table */

/**
 * Stage timeline descriptors. `midbossAt` / `bossAt` are progress fractions
 * (0..1) consumed by waves.mjs; `durationFrames` is the full stage length at
 * 60 Hz (all well past the three-minute mark). `bossPhases` is per stage and
 * never drops below BALANCE.bossPhases.
 */
export const STAGE_TABLE = [
  {
    stage: 1,
    name: 'ORBITAL SHELF',
    durationFrames: 5400,
    midbossAt: 0.55,
    bossAt: 1,
    bossPhases: 3,
    bossHp: 3200,
    spawnInterval: 42,
    density: 1,
    rankStart: 0.15,
    enemyMix: { popcorn: 5, grunt: 3, turret: 1 },
    backdrop: 'shelf',
    tint: '#7dff8a',
    tempo: 132,
  },
  {
    stage: 2,
    name: 'EMBER TRENCH',
    durationFrames: 5700,
    midbossAt: 0.5,
    bossAt: 1,
    bossPhases: 4,
    bossHp: 4400,
    spawnInterval: 36,
    density: 1.2,
    rankStart: 0.25,
    enemyMix: { popcorn: 4, grunt: 4, turret: 2, heavy: 1 },
    backdrop: 'trench',
    tint: '#ffc061',
    tempo: 142,
  },
  {
    stage: 3,
    name: 'VOID GARDEN',
    durationFrames: 6000,
    midbossAt: 0.6,
    bossAt: 1,
    bossPhases: 4,
    bossHp: 5600,
    spawnInterval: 30,
    density: 1.4,
    rankStart: 0.35,
    enemyMix: { popcorn: 4, grunt: 5, turret: 2, heavy: 2 },
    backdrop: 'garden',
    tint: '#ff6fae',
    tempo: 152,
  },
];

/** First entry of a stage table, used as the default when none is supplied. */
export const DEFAULT_STAGE = STAGE_TABLE[0];

/** Look up a 1-based stage record, clamped into the table. */
export function stageFor(stage) {
  const i = Math.max(1, Math.min(STAGE_TABLE.length, Math.floor(stage) || 1));
  return STAGE_TABLE[i - 1];
}

/** Default deterministic seed when the caller does not provide one. */
export const DEFAULT_SEED = 0x1badb002;

export default BALANCE;
