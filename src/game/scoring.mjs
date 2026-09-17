/**
 * scoring.mjs — score, chain, graze, extends and rank.
 *
 * Pure simulation code: no DOM, no three, no timers. Every helper takes the
 * mutable `state` bag owned by GameState and edits it in place, which keeps the
 * hot path allocation-free and replay-deterministic.
 *
 * The chain behaves like a Cave-style hit combo: each kill pushes the counter
 * up and re-arms a `chainTimeout` countdown; every quiet frame bleeds that
 * countdown until the chain collapses back to zero. Grazing feeds score and the
 * graze counter without touching the chain. Rank is a pressure accumulator that
 * climbs on grazes and kills and bleeds away every quiet frame; the bullet
 * patterns and enemy AI scale their aggression against it.
 *
 * Chain payout is the GPS (Get-Point System) formula. For a chain of N kills
 * whose base values are A, B, ... Z in kill order, the chain pays
 *
 *     N*A + (N-1)*B + ... + 1*Z
 *
 * so the earliest kill in a long chain is worth the most. Because N is only
 * known once the chain ends, `addKill()` banks the payout incrementally: every
 * kill re-pays the running sum of all base values in the chain, which
 * telescopes to exactly the GPS total once the last link lands. Every enemy
 * therefore carries a mandatory, strictly positive base value, so no link in a
 * chain can ever be worth nothing.
 */
import { BALANCE } from './config.mjs';

/** First finite argument wins, otherwise the final one (the default). */
function pick(...values) {
  for (const v of values) if (Number.isFinite(v)) return v;
  return values[values.length - 1];
}

const RANK_CFG = BALANCE.rank && typeof BALANCE.rank === 'object' ? BALANCE.rank : {};

const CHAIN_TIMEOUT = pick(BALANCE.chainTimeout, 120);
const EXTEND_SCORE = pick(BALANCE.extendScore, 2000000);
const EXTEND_MAX = pick(BALANCE.extendMax, 8);
const GRAZE_SCORE = pick(BALANCE.grazeScore, 25);
const HIT_SCORE = pick(BALANCE.scorePerHit, 10);
const KILL_MULTIPLIER = pick(BALANCE.killMultiplier, 1);
/** Mandatory base value handed to any enemy that somehow lacks one. */
const ENEMY_BASE = pick(BALANCE.enemy && BALANCE.enemy.basePoints, BALANCE.enemyBasePoints, HIT_SCORE);

/** Fractional score bonus per chain link, clamped by the configured cap. */
const CHAIN_STEP = pick(BALANCE.chainStep, BALANCE.chainBonusStep, 0.02);
const CHAIN_BONUS_CAP = pick(BALANCE.chainStepCap, BALANCE.chainBonusMax, 3);

const RANK_MIN = pick(RANK_CFG.min, 0);
const RANK_MAX = pick(RANK_CFG.max, 1);
const RANK_START = pick(RANK_CFG.start, 0.15);
const RANK_GRAZE_GAIN = pick(RANK_CFG.grazeGain, 0.00035);
const RANK_KILL_GAIN = pick(RANK_CFG.killGain, 0.0012);
const RANK_DECAY = pick(RANK_CFG.decay, 0.00006);
const RANK_DEATH_DROP = pick(RANK_CFG.deathDrop, 0.35);
const RANK_BOMB_DROP = pick(RANK_CFG.bombDrop, 0.15);

const FRAMES_PER_SECOND = 60;

/* ------------------------------------------------------------------ events */

function eventSink(events, state) {
  if (Array.isArray(events)) return events;
  if (state && Array.isArray(state.events)) return state.events;
  return null;
}

function emit(sink, ev) {
  if (sink) sink.push(ev);
}

/* -------------------------------------------------------------- lifecycle */

/**
 * Seed every scoring field a fresh GameState needs. Safe to call on a bag that
 * already carries values (existing numbers win).
 */
export function initScoring(state) {
  if (!state) return state;
  if (!Number.isFinite(state.score)) state.score = 0;
  if (!Number.isFinite(state.chain)) state.chain = 0;
  if (!Number.isFinite(state.chainTimer)) state.chainTimer = 0;
  // GPS ledger: base values in kill order + their running sum (the payout of
  // the next kill). Both reset when the chain collapses.
  if (!Array.isArray(state.chainValues)) state.chainValues = [];
  if (!Number.isFinite(state.chainSum)) state.chainSum = 0;
  if (!Number.isFinite(state.graze)) state.graze = 0;
  if (!Number.isFinite(state.rank)) state.rank = RANK_START;
  if (!Number.isFinite(state.extends)) state.extends = 0;
  if (!Number.isFinite(state.nextExtend)) state.nextExtend = EXTEND_SCORE;
  return state;
}

/* ------------------------------------------------------------------ score */

/** Chain bonus multiplier: 1x for a cold chain, rising to 1 + chainStepCap. */
export function chainMultiplier(chain) {
  const links = Math.max(0, chain || 0);
  return 1 + Math.min(CHAIN_BONUS_CAP, links * CHAIN_STEP);
}

/**
 * GPS chain payout: for a chain of N base values A, B, ... Z in kill order,
 * returns `N*A + (N-1)*B + ... + 1*Z`. Pure and total, so tests, the HUD and
 * `addKill()` all agree.
 *
 * Accepts either an array of values (`chainScore([100, 600, 300])`) or the
 * values as separate arguments (`chainScore(100, 600, 300)`). Every value is
 * clamped to a mandatory minimum of 1 point.
 */
export function chainScore(...args) {
  const values = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  const n = values.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const raw = Number.isFinite(values[i]) ? values[i] : ENEMY_BASE;
    total += (n - i) * Math.max(1, raw);
  }
  return Math.max(0, Math.round(total));
}

/** Alias for {@link chainScore}, named after the GPS (Get-Point System). */
export const gpsChainScore = chainScore;
/** Short alias for {@link chainScore}. */
export const gpsScore = chainScore;

/** Award a life and announce it on the event queue. */
export function addExtend(state, events) {
  if (!state) return 0;
  state.extends = (Number.isFinite(state.extends) ? state.extends : 0) + 1;
  state.lives = (state.lives || 0) + 1;
  emit(eventSink(events, state), {
    type: 'extend',
    lives: state.lives,
    extends: state.extends,
    score: state.score || 0,
  });
  return state.lives;
}

/**
 * Walk the extend ladder, awarding one life per crossed threshold. A single
 * huge payout can cross several thresholds; each is awarded, up to the
 * configured `extendMax` life ceiling so score alone cannot mint lives forever.
 */
function checkExtends(state, events) {
  const sink = eventSink(events, state);
  let next = Number.isFinite(state.nextExtend) ? state.nextExtend : EXTEND_SCORE;
  let guard = 0;
  while ((state.score || 0) >= next && guard++ < 1000) {
    const awarded = Number.isFinite(state.extends) ? state.extends : 0;
    if (awarded >= EXTEND_MAX) break;
    state.nextExtend = next + EXTEND_SCORE;
    addExtend(state, sink);
    next = state.nextExtend;
  }
}

/**
 * Add raw points and process any extends they triggered. Returns the points
 * actually banked (never negative).
 */
export function addScore(state, points, events) {
  if (!state) return 0;
  const gained = Math.max(0, Math.round(points || 0));
  if (gained === 0) return 0;
  state.score = (state.score || 0) + gained;
  checkExtends(state, events);
  return gained;
}

/**
 * Mandatory base value an enemy prints. Every enemy must carry a strictly
 * positive point value, so a missing / zero / non-finite value falls back to
 * the configured enemy base (and is clamped to at least one point).
 */
export function basePoints(enemy) {
  const raw = enemy && Number.isFinite(enemy.points) ? enemy.points : ENEMY_BASE;
  return Math.max(1, Math.round(raw));
}

/**
 * Legacy per-link preview kept for callers that only know `base` and `chain`:
 * base value times the fractional chain bonus. The authoritative GPS payout is
 * `chainScore()` / `addKill()`.
 */
export function killScore(base, chain) {
  const value = Number.isFinite(base) ? base : ENEMY_BASE;
  return Math.max(1, Math.round(value * KILL_MULTIPLIER * chainMultiplier(chain)));
}

/**
 * Points the next kill would bank right now under the GPS formula: the enemy's
 * base value re-pays the whole live chain, so a kill deep in a chain is worth
 * its base plus the running sum of everything before it. Pure, so the HUD
 * preview and `addKill()` agree.
 */
export function scoreForKill(state, enemy) {
  const base = basePoints(enemy);
  const live = !!state && Number.isFinite(state.chainTimer) && state.chainTimer > 0;
  const sum = live && Number.isFinite(state.chainSum) ? Math.max(0, state.chainSum) : 0;
  return Math.max(1, Math.round(sum + base));
}

/**
 * Register a kill: bump the chain, re-arm the chain timer and bank the GPS
 * payout for this link. Because the final chain length is unknown at kill
 * time, each kill re-pays the running sum of base values in the live chain;
 * telescoped across the chain that equals `N*A + (N-1)*B + ... + 1*Z`.
 *
 * A cold chain (timer run out) starts a fresh ledger. Returns the points this
 * kill banked so callers can display a popup.
 */
export function addKill(state, enemy, events) {
  if (!state) return 0;
  const base = basePoints(enemy);
  const cold = !(Number.isFinite(state.chainTimer) && state.chainTimer > 0);
  if (cold) {
    state.chainValues = [];
    state.chainSum = 0;
  }
  if (!Array.isArray(state.chainValues)) state.chainValues = [];
  state.chainValues.push(base);
  state.chainSum = (Number.isFinite(state.chainSum) ? state.chainSum : 0) + base;
  state.chain = (state.chain || 0) + 1;
  state.chainTimer = CHAIN_TIMEOUT;
  gainRank(state, RANK_KILL_GAIN);
  const points = Math.max(1, Math.round(state.chainSum));
  addScore(state, points, events);
  return points;
}

/** Register a graze: count it, pay the graze bonus, log the event. */
export function addGraze(state, events) {
  if (!state) return 0;
  state.graze = (state.graze || 0) + 1;
  gainRank(state, RANK_GRAZE_GAIN);
  addScore(state, GRAZE_SCORE, events);
  emit(eventSink(events, state), {
    type: 'graze',
    graze: state.graze,
    score: state.score || 0,
  });
  return state.graze;
}

/* ------------------------------------------------------------------ chain */

/** Drop the live chain counter and its GPS ledger back to a cold start. */
function collapseChain(state) {
  state.chain = 0;
  state.chainValues = [];
  state.chainSum = 0;
}

/**
 * Bleed the chain countdown by whole frames; the chain dies at zero. The HUD
 * reads `chain`/`chainTimer` directly, so no extra event type is emitted here.
 */
export function advanceChain(state, frames = 1, events) {
  if (!state) return 0;
  const alive = Number.isFinite(state.chainTimer) ? state.chainTimer : 0;
  if (alive <= 0) {
    state.chainTimer = 0;
    collapseChain(state);
    return 0;
  }
  state.chainTimer = Math.max(0, alive - Math.max(0, frames));
  if (state.chainTimer === 0) collapseChain(state);
  return state.chain;
}

/* ------------------------------------------------------------------- rank */

/**
 * Nudge rank by `amount`, clamped into [rank.min, rank.max]. Grazes and kills
 * feed it positive pressure; deaths, bombs and quiet frames bleed it off.
 */
export function gainRank(state, amount) {
  if (!state) return RANK_MIN;
  const current = Number.isFinite(state.rank) ? state.rank : RANK_START;
  const next = current + (Number.isFinite(amount) ? amount : 0);
  state.rank = Math.min(RANK_MAX, Math.max(RANK_MIN, next));
  return state.rank;
}

/** Bleed rank by `amount`; negative input is treated as zero. */
export function dropRank(state, amount) {
  return gainRank(state, -(Number.isFinite(amount) ? Math.max(0, amount) : 0));
}

/** Rank penalty applied when the player loses a life. */
export function dropRankOnDeath(state) {
  return dropRank(state, RANK_DEATH_DROP);
}

/** Rank penalty applied when the player fires a bomb. */
export function dropRankOnBomb(state) {
  return dropRank(state, RANK_BOMB_DROP);
}

/**
 * Age rank by `frames` of passive decay and clamp it back into range. The
 * result is a pure function of the stored rank, so replays stay bit-identical.
 */
export function updateRank(state, frames = 1) {
  if (!state) return RANK_MIN;
  const step = Math.max(0, Number.isFinite(frames) ? frames : 0);
  if (!Number.isFinite(state.rank)) state.rank = RANK_START;
  if (step > 0) return gainRank(state, -RANK_DECAY * step);
  return state.rank;
}

/** Multiplier derived from rank, used to scale bullet speed / density. */
export function rankScale(state, spread = 0.12) {
  const rank = state && Number.isFinite(state.rank) ? state.rank : RANK_START;
  const step = Number.isFinite(spread) ? Math.max(0, spread) : 0;
  return 1 + Math.max(0, rank - RANK_MIN) * step;
}

/**
 * Frame-explicit scoring tick: age the chain, then decay rank.
 */
export function tickScoring(state, frames = 1, events) {
  advanceChain(state, frames, events);
  updateRank(state, frames);
  return state;
}

/** Per-second scoring tick, matching `GameState.step(dt)`'s units. */
export function updateScoring(state, dt = 0, events) {
  return tickScoring(state, Math.max(0, dt * FRAMES_PER_SECOND), events);
}
