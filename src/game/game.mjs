/**
 * game.mjs — the integration layer.
 *
 * `createGame({ seed, stage })` wires every pure simulation module in
 * `src/game/*` into one deterministic, headless, fixed-step loop:
 *
 *   const g = createGame({ seed: 42, stage: 1 });
 *   g.input.fire = true;
 *   g.step(1 / 60);           // advance one 60 Hz frame
 *   g.state.score;            // 0…
 *   g.events;                 // shot / enemyKilled / playerHit / powerup /
 *                             // bossPhase / graze / extend
 *
 * The module owns no DOM, no three and no timers — the same seed plus the same
 * input trace replays bit-for-bit. Every sub-system keeps its own state; this
 * file only sequences them and mirrors resources (lives / bombs / power)
 * between the authoritative `state` bag and the `player` ship.
 *
 * Fixed timestep: callers feed wall-clock deltas and the loop accumulates whole
 * 60 Hz frames, so a 120 Hz renderer driving `step(1/120)` still simulates at 60.
 */

import { BALANCE, SIM, DEFAULT_SEED, tierFor } from './config.mjs';
import { createPlayer } from './player.mjs';
import { createBulletSystem } from './bullets.mjs';
import { createEnemy } from './enemies.mjs';
import { createStage } from './waves.mjs';
import { createBoss } from './boss.mjs';
import { applyPickup, createPickup, dropFor, updatePickups } from './powerups.mjs';
import {
  initScoring,
  addScore as bankScore,
  addKill,
  addGraze as registerGraze,
  tickScoring,
  dropRankOnDeath,
  dropRankOnBomb,
} from './scoring.mjs';
import { circlesHit } from './collision.mjs';
import { createRng } from '../core/rng.mjs';

/** Simulation cadence every balance number is authored against. */
export const FRAME_RATE = SIM.hz;
/** Exact seconds-per-simulated-frame handed to the sub-systems. */
const FRAME_DT = SIM.dt;

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Player power tiers (also the power cap). */
const POWER_TIERS = Math.max(1, Math.round(num(BALANCE.powerTiers, 4)));
/** Hard ceiling on simultaneously live stage enemies, from balance. */
const MAX_ENEMIES = Math.max(1, Math.round(num(BALANCE.enemy && BALANCE.enemy.maxActive, 220)));

export function createGame(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const seed = num(opts.seed, DEFAULT_SEED);
  const stageNo = Math.max(1, Math.floor(num(opts.stage, 1)));

  const rng = createRng(seed);
  const stage = createStage(stageNo, { seed });
  const player = createPlayer({ field: BALANCE.field });
  const bullets = createBulletSystem();

  const enemies = [];
  const pickups = [];
  const events = [];

  /* ------------------------------------------------------------------ state */

  const state = {
    score: 0,
    lives: player.lives,
    bombs: player.bombs,
    power: player.power,
    chain: 0,
    chainTimer: 0,
    frame: 0,
    time: 0,
    stage: stageNo,
    rank: num(stage.rankStart, 0.15),
    gameOver: false,
    bossActive: false,
    graze: 0,
    extends: 0,
    nextExtend: num(BALANCE.extendScore, 2000000),
    events,
  };
  initScoring(state);
  state.rank = num(stage.rankStart, state.rank);
  state.lives = player.lives;
  state.bombs = player.bombs;
  state.power = player.power;

  const input = {
    up: false,
    down: false,
    left: false,
    right: false,
    fire: false,
    bomb: false,
    focus: false,
  };

  /** Runtime context shared with enemies.mjs and boss.mjs (bullet + event sink). */
  const ctx = {
    player,
    state,
    bullets,
    bulletSystem: bullets,
    events,
    rank: state.rank,
  };

  let boss = null;
  /** Sub-frame accumulator: lets a 120 Hz caller drive a 60 Hz simulation. */
  let pendingFrames = 0;

  /* ------------------------------------------------------------ reconciliation */

  /** Scoring / pickups own `state`; mirror resources onto the live ship. */
  function syncFromState() {
    if (state.lives !== player.lives) player.lives = state.lives;
    if (state.bombs !== player.bombs) player.bombs = state.bombs;
    if (state.power !== player.power) {
      player.power = clamp(Math.round(num(state.power, 1)), 1, POWER_TIERS);
    }
  }

  /** The ship owns position + a death penalty; mirror the resource change back. */
  function syncFromPlayer() {
    state.lives = player.lives;
    state.bombs = player.bombs;
    state.power = player.power;
    if (state.lives < 0) state.gameOver = true;
  }

  function emit(ev) {
    events.push(ev);
    return ev;
  }

  /* -------------------------------------------------------------- spawning */

  function spawnEnemy(kind = 'grunt', x, y, enemyOpts = {}) {
    const e = createEnemy(kind, x, y, enemyOpts);
    if (enemies.length < MAX_ENEMIES) enemies.push(e);
    return e;
  }

  function spawnBoss(stageArg) {
    const no = Math.max(1, Math.floor(num(stageArg, state.stage)));
    boss = createBoss({ stage: no, ctx });
    state.bossActive = !!boss.active;
    game.boss = boss;
    return boss;
  }

  /**
   * Register a destroyed enemy: bump the chain, bank the score (which may cross
   * an extend), announce it and roll the deterministic drop table.
   */
  function killEnemy(e) {
    if (!e || e._processed) return e;
    e._processed = true;
    e.active = false;
    e.alive = false;
    e.dead = true;

    const points = addKill(state, e, events);
    syncFromState();
    emit({
      type: 'enemyKilled',
      kind: e.kind,
      x: e.x,
      y: e.y,
      points,
      chain: state.chain,
      score: state.score,
    });

    const drop = dropFor(e, rng);
    if (drop) pickups.push(createPickup(drop));
    return e;
  }

  /* ------------------------------------------------------------- resources */

  function hurt() {
    const lost = player.hurt();
    if (!lost) return false;
    syncFromPlayer();
    dropRankOnDeath(state);
    emit({
      type: 'playerHit',
      x: player.x,
      y: player.y,
      lives: state.lives,
      power: state.power,
      invuln: player.invuln,
    });
    return true;
  }

  function addScore(points) {
    const before = state.lives;
    bankScore(state, points, events);
    if (state.lives !== before) syncFromState();
    return state.score;
  }

  function addGraze() {
    registerGraze(state, events);
    return state.graze;
  }

  function collectPowerup(pickup) {
    if (!pickup) return false;
    const item = pickup.kind ? createPickup(pickup) : null;
    if (!item) return false;
    if (!applyPickup(state, item, events)) return false;
    syncFromState();
    return true;
  }

  /* ------------------------------------------------------------------ combat */

  function fireShot(shot) {
    const tier = tierFor(player.power);
    const damage = num(tier && tier.damage, 1);
    const speed = num(BALANCE.bullets && BALANCE.bullets.playerSpeed, 9.5);
    const r = num(BALANCE.bullets && BALANCE.bullets.playerR, 4);
    for (let i = 0; i < shot.muzzles.length; i++) {
      const m = shot.muzzles[i];
      bullets.spawnPlayer({
        x: m.x,
        y: m.y,
        vx: Math.sin(m.angle) * speed,
        vy: -Math.cos(m.angle) * speed,
        r,
        kind: 'shot',
        damage,
      });
    }
    emit({
      type: 'shot',
      x: shot.x,
      y: shot.y,
      power: shot.power,
      focus: shot.focus,
      streams: shot.muzzles.length,
    });
  }

  function useBomb() {
    bullets.clearEnemy();
    dropRankOnBomb(state);
    const radius = num(BALANCE.bomb && BALANCE.bomb.radius, 360);
    const damage = num(BALANCE.bomb && BALANCE.bomb.damage, 220);
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active || e._processed) continue;
      if (circlesHit(player.x, player.y, radius, e.x, e.y, e.r) && e.damage(damage)) {
        killEnemy(e);
      }
    }
    if (boss && boss.active) boss.damage(damage, ctx);
    emit({ type: 'bomb', x: player.x, y: player.y, bombs: state.bombs });
  }

  /** Player shots vs. the enemy field (and the boss). One bullet per contact. */
  function collidePlayerShots() {
    bullets.eachPlayer((b) => {
      if (!b.live) return;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e.active || e._processed) continue;
        if (circlesHit(b.x, b.y, b.r, e.x, e.y, e.r)) {
          bullets.retire(b);
          if (e.damage(b.damage)) killEnemy(e);
          return;
        }
      }
      if (boss && boss.active && !boss.dying) {
        const reach = num(boss.hitR, num(boss.r, 46));
        if (circlesHit(b.x, b.y, b.r, boss.x, boss.y, reach)) {
          bullets.retire(b);
          boss.damage(b.damage, ctx);
        }
      }
    });
  }

  /** Enemy danmaku vs. the player's tight hitbox, plus graze bookkeeping. */
  function collidePlayerHits() {
    if (!player.alive) return;
    const grazed = bullets.graze(player, player.grazeR);
    for (let i = 0; i < grazed; i++) registerGraze(state, events);

    if (player.invuln > 0) return;
    const hit = bullets.firstEnemyHit(player);
    if (hit) {
      bullets.retire(hit);
      hurt();
    }
  }

  /* -------------------------------------------------------------- step loop */

  function stepFrame() {
    state.frame += 1;
    state.time = state.frame / FRAME_RATE;

    // Keep the runtime context fresh for enemies.mjs / boss.mjs.
    ctx.rank = state.rank;
    ctx.player = player;
    ctx.state = state;
    ctx.events = events;

    // 1) Stage timeline: spawn whatever is scheduled on this exact frame.
    const scheduled = stage.at(state.frame - 1);
    for (let i = 0; i < scheduled.length; i++) {
      const ev = scheduled[i];
      if (ev.kind === 'enemy') {
        spawnEnemy(ev.enemy || ev.type, ev.x, ev.y, ev.opts);
      } else if (ev.kind === 'midboss') {
        spawnEnemy('midboss', ev.x, ev.y, ev.opts);
      } else if (ev.kind === 'boss') {
        if (!boss || !boss.active) spawnBoss(num(ev.stage, state.stage));
      }
    }

    // 2) Player: movement, focus, cooldowns and respawn.
    player.update(FRAME_DT, input);
    if (player.alive) {
      if (input.fire) {
        const shot = player.fire();
        if (shot) fireShot(shot);
      }
      if (input.bomb) {
        input.bomb = false;
        if (player.useBomb()) useBomb();
      }
    }

    // 3) Enemies and the boss act.
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.active) e.update(FRAME_DT, ctx);
    }
    if (boss && boss.active) boss.update(FRAME_DT, ctx);

    // 4) Move every bullet one frame, then resolve collisions.
    bullets.update(FRAME_DT);
    collidePlayerShots();
    collidePlayerHits();

    // 5) Items: fall, magnetise, collect (applyPickup edits `state`).
    updatePickups(state, pickups, player, FRAME_DT, events);

    // 6) Scoring heartbeat: bleed the chain countdown and decay rank.
    if (!state.gameOver) tickScoring(state, 1, events);

    // 7) Retire dead enemies.
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (!enemies[i].active) enemies.splice(i, 1);
    }

    // 8) Reconcile mirrored resources / flags.
    syncFromState();
    if (boss) state.bossActive = !!boss.active;
    if (state.lives < 0) state.gameOver = true;
  }

  /**
   * Advance the simulation by `dt` seconds. Whole 60 Hz frames are consumed from
   * an accumulator so the same input trace always replays identically.
   */
  function step(dt = FRAME_DT) {
    const seconds = Math.max(0, num(dt, FRAME_DT));
    pendingFrames += seconds * FRAME_RATE;
    let frames = Math.floor(pendingFrames + 1e-9);
    if (frames <= 0) return game;
    pendingFrames -= frames;
    if (pendingFrames < 0) pendingFrames = 0;
    const budget = Math.max(1, Math.round(num(SIM.maxSteps, 8)));
    if (frames > budget) frames = budget;
    for (let i = 0; i < frames; i++) stepFrame();
    return game;
  }

  const game = {
    state,
    player,
    input,
    enemies,
    boss: null,
    events,
    step,
    spawnEnemy,
    spawnBoss,
    killEnemy,
    hurt,
    collectPowerup,
    addScore,
    addGraze,
    /** Extra read-only handles so the renderer/HUD can reach the sub-systems. */
    bullets,
    pickups,
    stage,
    rng,
  };

  return game;
}

export default createGame;
