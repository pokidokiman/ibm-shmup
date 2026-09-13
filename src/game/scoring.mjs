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

/** Base point value an enemy prints, falling back to the per-hit score. */
export function basePoints(enemy) {
  return enemy && Number.isFinite(enemy.points) ? enemy.points : HIT_SCORE;
}

/**
 * Points a kill banks at a given chain depth: base value times the chain bonus.
 * Pure, so both the HUD preview and `addKill()` agree on the number.
 */
export function killScore(base, chain) {
  const value = Number.isFinite(base) ? base : HIT_SCORE;
  return Math.max(1, Math.round(value * KILL_MULTIPLIER * chainMultiplier(chain)));
}

/** Convenience preview: kill value at the state's current chain depth. */
export function scoreForKill(state, enemy) {
  const chain = state && Number.isFinite(state.chain) ? state.chain : 0;
  return killScore(basePoints(enemy), chain);
}

/**
 * Register a kill: bump the chain, re-arm the chain timer and bank the points.
 * Returns the banked points so callers can display a popup.
 */
export function addKill(state, enemy, events) {
  if (!state) return 0;
  state.chain = (state.chain || 0) + 1;
  state.chainTimer = CHAIN_TIMEOUT;
  gainRank(state, RANK_KILL_GAIN);
  const points = killScore(basePoints(enemy), state.chain);
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

/**
 * Bleed the chain countdown by whole frames; the chain dies at zero. The HUD
 * reads `chain`/`chainTimer` directly, so no extra event type is emitted here.
 */
export function advanceChain(state, frames = 1, events) {
  if (!state) return 0;
  const alive = Number.isFinite(state.chainTimer) ? state.chainTimer : 0;
  if (alive <= 0) {
    state.chainTimer = 0;
    state.chain = 0;
    return 0;
  }
  state.chainTimer = Math.max(0, alive - Math.max(0, frames));
  if (state.chainTimer === 0) state.chain = 0;
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
