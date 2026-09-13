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
 * graze counter without touching the chain. Both survival time and chain depth
 * feed `rank`, which the bullet patterns and enemy AI can scale against.
 */
import { BALANCE } from './config.mjs';

const CHAIN_TIMEOUT = BALANCE.chainTimeout ?? 120;
const EXTEND_SCORE = BALANCE.extendScore ?? 2000000;
const GRAZE_SCORE = BALANCE.grazeScore ?? 10;
const HIT_SCORE = BALANCE.scorePerHit ?? 10;

/** Fractional score bonus per chain link, and its ceiling. */
const CHAIN_STEP = BALANCE.chainBonusStep ?? 0.02;
const CHAIN_MAX_MULT = BALANCE.chainBonusMax ?? 4;

const RANK_MIN = 1;
const RANK_MAX = BALANCE.rankMax ?? 8;
const RANK_PER_SEC = BALANCE.rankPerSecond ?? 0.05;
const RANK_PER_CHAIN = BALANCE.rankPerChain ?? 0.004;
const RANK_PER_STAGE = BALANCE.rankPerStage ?? 1;

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
  if (!Number.isFinite(state.rank)) state.rank = RANK_MIN;
  if (!Number.isFinite(state.nextExtend)) state.nextExtend = EXTEND_SCORE;
  return state;
}

/* ------------------------------------------------------------------ score */

/** Chain bonus multiplier: 1x for a cold chain, rising to CHAIN_MAX_MULT. */
export function chainMultiplier(chain) {
  const links = Math.max(0, chain || 0);
  return Math.min(CHAIN_MAX_MULT, 1 + links * CHAIN_STEP);
}

/** Award a life and announce it on the event queue. */
export function addExtend(state, events) {
  if (!state) return 0;
  state.lives = (state.lives || 0) + 1;
  emit(eventSink(events, state), {
    type: 'extend',
    lives: state.lives,
    score: state.score || 0,
  });
  return state.lives;
}

/** Walk the extend ladder, awarding one life per crossed threshold. */
function checkExtends(state, events) {
  const sink = eventSink(events, state);
  let next = Number.isFinite(state.nextExtend) ? state.nextExtend : EXTEND_SCORE;
  // A very large payout can cross more than one threshold; award them all.
  let guard = 0;
  while ((state.score || 0) >= next && guard++ < 1000) {
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
  return Math.max(1, Math.round(value * chainMultiplier(chain)));
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
  const points = killScore(basePoints(enemy), state.chain);
  addScore(state, points, events);
  return points;
}

/** Register a graze: count it, pay the graze bonus, log the event. */
export function addGraze(state, events) {
  if (!state) return 0;
  state.graze = (state.graze || 0) + 1;
  addScore(state, GRAZE_SCORE, events);
  emit(eventSink(events, state), {
    type: 'graze',
    graze: state.graze,
    score: state.score || 0,
  });
  return state.graze;
}

/* ------------------------------------------------------------------ chain */

/** Bleed the chain countdown by whole frames; the chain dies at zero. */
export function advanceChain(state, frames = 1, events) {
  if (!state) return 0;
  const alive = Number.isFinite(state.chainTimer) ? state.chainTimer : 0;
  if (alive <= 0) {
    state.chainTimer = 0;
    state.chain = 0;
    return 0;
  }
  state.chainTimer = Math.max(0, alive - Math.max(0, frames));
  if (state.chainTimer === 0) {
    state.chain = 0;
    emit(eventSink(events, state), { type: 'chainEnd', score: state.score || 0 });
  }
  return state.chain;
}

/* ------------------------------------------------------------------- rank */

/**
 * Rank is a smoothed pressure value in [1, RANK_MAX]: it climbs with survival
 * time, chains and deeper stages. Rewritten every tick from deterministic state
 * so replays stay bit-identical.
 */
export function updateRank(state) {
  if (!state) return RANK_MIN;
  const time = state.time || 0;
  const chain = state.chain || 0;
  const stage = Math.max(1, state.stage || 1);
  const raw =
    RANK_MIN +
    time * RANK_PER_SEC +
    chain * RANK_PER_CHAIN +
    (stage - 1) * RANK_PER_STAGE;
  state.rank = Math.min(RANK_MAX, Math.max(RANK_MIN, raw));
  return state.rank;
}

/** Multiplier derived from rank, used to scale bullet speed / density. */
export function rankScale(state, spread = 0.12) {
  const rank = state && Number.isFinite(state.rank) ? state.rank : RANK_MIN;
  return 1 + Math.max(0, rank - RANK_MIN) * spread;
}

/**
 * Frame-explicit scoring tick: age the chain, then refresh rank.
 */
export function tickScoring(state, frames = 1, events) {
  advanceChain(state, frames, events);
  updateRank(state);
  return state;
}

/** Per-second scoring tick, matching `GameState.step(dt)`'s units. */
export function updateScoring(state, dt = 0, events) {
  return tickScoring(state, Math.max(0, dt * FRAMES_PER_SECOND), events);
}
