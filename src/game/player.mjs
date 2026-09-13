/**
 * player.mjs — the player ship state machine: position, focus slow-mode, lives, bombs,
 * invulnerability and fire cadence. Pure simulation: no DOM, no three, no timers.
 *
 * `createPlayer(opts)` returns the object the game loop drives:
 *
 *   fields (read by the renderer + HUD)
 *     x, y            position in playfield pixels (origin = top-left)
 *     hitR            tight collision radius (2px by balance)
 *     grazeR          graze ring radius
 *     speed           current speed in px/frame (focus-aware, ~4.2 / ~1.9)
 *     baseSpeed       unfocused speed, focusSpeed  focused speed
 *     fireCooldown    frames left before the next shot is allowed
 *     invuln          invulnerability frames left
 *     focus           true while the focus button is held
 *     power           1..powerTiers shot streams
 *     lives, bombs    resources; `lives` may reach -1, which means game over
 *     alive           false once every life is gone
 *     respawnTimer    frames left in the death pause (0 while alive)
 *     field           { width, height } the ship is clamped to
 *
 *   methods
 *     update(dt, input) / step(dt, input)  advance one fixed step; returns the player
 *     fire()        -> null while on cooldown, else a shot spec { x, y, power, focus, streams, muzzles }
 *     muzzles()     -> [{ x, y, angle }]; angle is radians clockwise from "up", so a
 *                      bullet direction vector is { x: Math.sin(angle), y: -Math.cos(angle) }
 *     canFire()     -> boolean
 *     hurt()        -> true when a life was actually lost (invulnerable hits do nothing)
 *     respawn()     -> reset to the spawn point with invulnerability frames
 *     useBomb()     -> true when a bomb was spent (bomb grants invulnerability)
 *     addPower(n) / addLives(n) / addBombs(n) -> the clamped new value
 *     hitbox()      -> { x, y, r } tight collision circle
 *     moveTo(x, y) / clampToField() / reset(opts)
 *
 * All speeds are expressed in px per 1/60 s frame, matching config.BALANCE; `dt` is in
 * seconds, so one 1/60 step moves exactly `speed` pixels. Deterministic by construction.
 */

import { BALANCE } from './config.mjs';
import { grazeBand, hitsEntity } from './collision.mjs';

/** Simulation rate the balance numbers are authored against. */
export const FRAME_RATE = 60;

/** Fallbacks used when config.BALANCE omits a value (keeps the module import-safe). */
export const PLAYER_DEFAULTS = Object.freeze({
  speed: 4.2,
  focusSpeed: 1.9,
  hitR: 2,
  grazeR: 14,
  lives: 3,
  bombs: 3,
  power: 1,
  powerTiers: 4,
  fireCooldown: 4,
  invulnFrames: 120,
  respawnDelay: 45,
  margin: 8,
  fieldWidth: 384,
  fieldHeight: 448,
  spawnX: 0.5,
  spawnY: 0.88,
});

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clampInt = (v, lo, hi) => clamp(Math.round(num(v, lo)), lo, hi);

const balanceOf = () => (BALANCE && typeof BALANCE === 'object' ? BALANCE : {});
const playerCfg = () => {
  const b = balanceOf();
  return b.player && typeof b.player === 'object' ? b.player : {};
};
const fieldCfg = () => {
  const b = balanceOf();
  return b.field && typeof b.field === 'object' ? b.field : {};
};

const toFrames = (dt) => (typeof dt === 'number' && Number.isFinite(dt) ? dt * FRAME_RATE : 0);

/** Per-tier muzzle layout. Tier 1 is a single stream, tier 4 fans out to four. */
const MUZZLES = [
  [{ dx: 0, angle: 0 }],
  [
    { dx: -5, angle: 0 },
    { dx: 5, angle: 0 },
  ],
  [
    { dx: -7, angle: -0.14 },
    { dx: 0, angle: 0 },
    { dx: 7, angle: 0.14 },
  ],
  [
    { dx: -9, angle: -0.2 },
    { dx: -3, angle: -0.06 },
    { dx: 3, angle: 0.06 },
    { dx: 9, angle: 0.2 },
  ],
];

const MUZZLE_OFFSET_Y = -10;
/** Focus mode tightens the fan so skilled play keeps a narrow, high-dps stream. */
const FOCUS_TIGHTEN = 0.45;

export function createPlayer(opts = {}) {
  const cfg = playerCfg();
  const fieldOpt = opts.field && typeof opts.field === 'object' ? opts.field : fieldCfg();

  const setup = {
    baseSpeed: num(cfg.speed, PLAYER_DEFAULTS.speed),
    focusSpeed: num(cfg.focusSpeed, PLAYER_DEFAULTS.focusSpeed),
    // Cadence must gate the fire rate: never allow a shot every frame.
    fireDelay: Math.max(1, num(cfg.fireCooldown, num(cfg.fireDelay, PLAYER_DEFAULTS.fireCooldown))),
    // A hit must always grant invulnerability frames, so the floor is 1 frame.
    invulnFrames: Math.max(
      1,
      num(cfg.invulnFrames, num(cfg.respawnInvuln, num(cfg.invuln, PLAYER_DEFAULTS.invulnFrames))),
    ),
    respawnDelay: num(cfg.respawnDelay, PLAYER_DEFAULTS.respawnDelay),
    margin: num(fieldOpt.margin, num(cfg.margin, PLAYER_DEFAULTS.margin)),
    powerTiers: clampInt(num(cfg.powerTiers, balanceOf().powerTiers ?? PLAYER_DEFAULTS.powerTiers), 1, 8),
    maxLives: num(cfg.maxLives, 9),
    maxBombs: num(cfg.maxBombs, 9),
  };

  const player = {
    x: 0,
    y: 0,
    hitR: num(cfg.hitR, PLAYER_DEFAULTS.hitR),
    grazeR: num(cfg.grazeR, num(balanceOf().grazeRadius, PLAYER_DEFAULTS.grazeR)),
    speed: setup.baseSpeed,
    baseSpeed: setup.baseSpeed,
    focusSpeed: setup.focusSpeed,
    fireCooldown: 0,
    fireDelay: setup.fireDelay,
    invuln: 0,
    focus: false,
    power: PLAYER_DEFAULTS.power,
    lives: num(cfg.lives, PLAYER_DEFAULTS.lives),
    bombs: num(cfg.bombs, PLAYER_DEFAULTS.bombs),
    alive: true,
    respawnTimer: 0,
    field: {
      width: num(fieldOpt.width, PLAYER_DEFAULTS.fieldWidth),
      height: num(fieldOpt.height, PLAYER_DEFAULTS.fieldHeight),
    },
  };

  const spawn = {
    x: num(opts.x, player.field.width * num(fieldOpt.spawnX, PLAYER_DEFAULTS.spawnX)),
    y: num(opts.y, player.field.height * num(fieldOpt.spawnY, PLAYER_DEFAULTS.spawnY)),
  };

  function clampToField() {
    const m = setup.margin;
    const maxX = Math.max(m, player.field.width - m);
    const maxY = Math.max(m, player.field.height - m);
    player.x = clamp(player.x, Math.min(m, maxX), maxX);
    player.y = clamp(player.y, Math.min(m, maxY), maxY);
    return player;
  }

  function moveTo(x, y) {
    player.x = num(x, player.x);
    player.y = num(y, player.y);
    return clampToField();
  }

  function respawn() {
    player.x = spawn.x;
    player.y = spawn.y;
    clampToField();
    player.invuln = Math.max(setup.invulnFrames, player.invuln);
    player.fireCooldown = 0;
    player.focus = false;
    player.speed = setup.baseSpeed;
    player.alive = true;
    player.respawnTimer = 0;
    return player;
  }

  function reset(o = {}) {
    player.power = clampInt(num(o.power, PLAYER_DEFAULTS.power), 1, setup.powerTiers);
    player.lives = num(o.lives, num(cfg.lives, PLAYER_DEFAULTS.lives));
    player.bombs = num(o.bombs, num(cfg.bombs, PLAYER_DEFAULTS.bombs));
    if (o.field && typeof o.field === 'object') {
      player.field.width = num(o.field.width, player.field.width);
      player.field.height = num(o.field.height, player.field.height);
    }
    spawn.x = num(o.x, spawn.x);
    spawn.y = num(o.y, spawn.y);
    player.invuln = num(o.invuln, setup.invulnFrames);
    return respawn();
  }

  function canFire() {
    return player.alive && player.fireCooldown <= 0;
  }

  function muzzles() {
    const tier = clampInt(player.power, 1, setup.powerTiers);
    const layout = MUZZLES[Math.min(tier, MUZZLES.length) - 1];
    const tighten = player.focus ? FOCUS_TIGHTEN : 1;
    const out = [];
    for (let i = 0; i < layout.length; i++) {
      const m = layout[i];
      out.push({
        x: player.x + m.dx * tighten,
        y: player.y + MUZZLE_OFFSET_Y,
        angle: m.angle * tighten,
      });
    }
    return out;
  }

  function fire() {
    if (!canFire()) return null;
    player.fireCooldown = setup.fireDelay;
    const shots = muzzles();
    return {
      x: player.x,
      y: player.y,
      power: clampInt(player.power, 1, setup.powerTiers),
      focus: player.focus,
      streams: shots.length,
      muzzles: shots,
    };
  }

  function update(dt, input) {
    const frames = toFrames(dt);
    if (player.invuln > 0) player.invuln = Math.max(0, player.invuln - frames);
    if (player.fireCooldown > 0) player.fireCooldown = Math.max(0, player.fireCooldown - frames);

    if (!player.alive) {
      if (player.respawnTimer > 0) {
        player.respawnTimer = Math.max(0, player.respawnTimer - frames);
        if (player.respawnTimer === 0) respawn();
      }
      return player;
    }

    player.focus = !!(input && input.focus);
    player.speed = player.focus ? player.focusSpeed : player.baseSpeed;

    let ax = 0;
    let ay = 0;
    if (input) {
      if (input.left) ax -= 1;
      if (input.right) ax += 1;
      if (input.up) ay -= 1;
      if (input.down) ay += 1;
    }
    if (ax !== 0 || ay !== 0) {
      // Normalise diagonals so 45° movement is not 41% faster.
      const scale = ax !== 0 && ay !== 0 ? Math.SQRT1_2 : 1;
      const step = player.speed * frames * scale;
      player.x += ax * step;
      player.y += ay * step;
    }
    return clampToField();
  }

  function hurt(powerPenalty = 1) {
    if (!player.alive || player.invuln > 0) return false;
    player.lives -= 1;
    player.invuln = setup.invulnFrames;
    player.fireCooldown = 0;
    // Cave-style death penalty: one power tier is lost, never below tier 1.
    player.power = Math.max(1, clampInt(player.power, 1, setup.powerTiers) - Math.max(0, powerPenalty));
    if (player.lives < 0) {
      player.alive = false;
      player.respawnTimer = 0;
      player.speed = player.baseSpeed;
      player.focus = false;
      return true;
    }
    respawn();
    player.invuln = setup.invulnFrames;
    return true;
  }

  function useBomb() {
    if (!player.alive || player.bombs <= 0) return false;
    player.bombs -= 1;
    player.invuln = Math.max(player.invuln, setup.invulnFrames);
    return true;
  }

  function addPower(n = 1) {
    player.power = clampInt(player.power + num(n, 1), 1, setup.powerTiers);
    return player.power;
  }

  function addLives(n = 1) {
    player.lives = clamp(player.lives + num(n, 1), 0, setup.maxLives);
    if (player.lives >= 0) player.alive = true;
    return player.lives;
  }

  function addBombs(n = 1) {
    player.bombs = clamp(player.bombs + num(n, 1), 0, setup.maxBombs);
    return player.bombs;
  }

  function hitbox() {
    return { x: player.x, y: player.y, r: player.hitR };
  }

  /** True when this circle touches the tight hitbox (bullets/enemies call this). */
  function touches(ox, oy, or) {
    return hitsEntity(player, ox, oy, or);
  }

  /** True when the circle is inside the graze ring without touching the hitbox. */
  function grazes(ox, oy, or) {
    return grazeBand(player, player.grazeR, ox, oy, or);
  }

  Object.assign(player, {
    update,
    step: update,
    fire,
    muzzles,
    canFire,
    hurt,
    takeHit: hurt,
    respawn,
    reset,
    useBomb,
    addPower,
    addLives,
    addBombs,
    hitbox,
    touches,
    grazes,
    moveTo,
    clampToField,
  });

  player.power = clampInt(num(opts.power, PLAYER_DEFAULTS.power), 1, setup.powerTiers);
  player.lives = num(opts.lives, player.lives);
  player.bombs = num(opts.bombs, player.bombs);
  return respawn();
}
