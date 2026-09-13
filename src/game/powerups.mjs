/**
 * powerups.mjs — drop table, pickup types, auto-collect and power tiers.
 *
 * Pure simulation code: no DOM, no three, no timers. `dropFor()` decides,
 * deterministically from the injected RNG, whether a dying enemy leaves a
 * pickup and which kind. `applyPickup()` folds a collected pickup into the
 * shared GameState, and the small attraction helpers implement the
 * auto-collect magnet that snaps drops to a focused (slow-moving) player.
 */
import { BALANCE, POWERUP_TABLE } from './config.mjs';
import { addScore } from './scoring.mjs';

/** Every pickup kind the game understands. */
export const PICKUP_KINDS = ['power', 'life', 'bomb', 'score'];

/** Used when config.mjs has not supplied a wire table (keeps tiers 1..4 sane). */
const FALLBACK_TIERS = [
  { tier: 1, shots: 1 },
  { tier: 2, shots: 2 },
  { tier: 3, shots: 3 },
  { tier: 4, shots: 4 },
];

/**
 * Per-archetype drop probability and weighted kind table. `chance` is the
 * probability a kill drops anything at all; the weights then choose the kind.
 */
export const DROP_TABLE = {
  popcorn: { chance: 0.14, weights: { power: 68, score: 27, bomb: 4, life: 1 } },
  grunt: { chance: 0.2, weights: { power: 60, score: 30, bomb: 8, life: 2 } },
  turret: { chance: 0.32, weights: { power: 52, score: 26, bomb: 16, life: 6 } },
  midboss: { chance: 1, weights: { power: 50, score: 20, bomb: 20, life: 10 } },
  boss: { chance: 1, weights: { power: 40, score: 10, bomb: 30, life: 20 } },
  default: { chance: 0.16, weights: { power: 66, score: 27, bomb: 5, life: 2 } },
};

/* ---------------------------------------------------------------- helpers */

function eventSink(events, state) {
  if (Array.isArray(events)) return events;
  if (state && Array.isArray(state.events)) return state.events;
  return null;
}

function emit(sink, ev) {
  if (sink) sink.push(ev);
}

function tierTable() {
  return Array.isArray(POWERUP_TABLE) && POWERUP_TABLE.length ? POWERUP_TABLE : FALLBACK_TIERS;
}

function tierCount() {
  const configured = Number.isFinite(BALANCE.powerTiers) ? BALANCE.powerTiers : 0;
  return Math.max(1, Math.min(tierTable().length, configured || tierTable().length));
}

function pickWeighted(weights, rng) {
  let total = 0;
  let last = null;
  for (const kind in weights) {
    total += weights[kind];
    last = kind;
  }
  if (!(total > 0)) return null;
  let roll = rng.float(0, total);
  for (const kind in weights) {
    roll -= weights[kind];
    if (roll < 0) return kind;
  }
  return last;
}

/* ------------------------------------------------------------ drop table */

/**
 * Decide a drop for a killed enemy. Returns `null` when nothing drops, or
 * `{ kind: 'power'|'life'|'bomb'|'score', x, y }` at the enemy's position.
 * Deterministic for a given RNG stream.
 */
export function dropFor(enemy, rng) {
  const kind = enemy && typeof enemy.kind === 'string' ? enemy.kind : 'default';
  const spec = DROP_TABLE[kind] || DROP_TABLE.default;
  if (!rng.chance(spec.chance)) return null;
  const dropped = pickWeighted(spec.weights, rng);
  if (!dropped) return null;
  return {
    kind: dropped,
    x: enemy && Number.isFinite(enemy.x) ? enemy.x : 0,
    y: enemy && Number.isFinite(enemy.y) ? enemy.y : 0,
  };
}

/** Turn a drop spec into a live pickup entity for the renderer/collector. */
export function createPickup(drop) {
  return {
    kind: drop && drop.kind ? drop.kind : 'score',
    x: drop && Number.isFinite(drop.x) ? drop.x : 0,
    y: drop && Number.isFinite(drop.y) ? drop.y : 0,
    r: BALANCE.pickupRadius ?? 7,
    vy: BALANCE.pickupFallSpeed ?? 0.85,
    t: 0,
  };
}

/* ------------------------------------------------------------ collection */

/** Radius within which drops fly to the player (focus mode widens it). */
export function collectRadius(player) {
  if (player && player.focus) return BALANCE.focusCollectRadius ?? 150;
  return BALANCE.collectRadius ?? 26;
}

/**
 * Magnetise a pickup toward the player when it sits inside `radius`. Returns
 * true when the pickup is being pulled in this frame.
 */
export function attractPickup(pickup, player, dt, radius) {
  if (!pickup || !player) return false;
  const reach = Number.isFinite(radius) ? radius : collectRadius(player);
  const dx = player.x - pickup.x;
  const dy = player.y - pickup.y;
  const d2 = dx * dx + dy * dy;
  if (d2 > reach * reach || d2 < 1e-9) return false;
  const dist = Math.sqrt(d2);
  const perFrame = BALANCE.pickupAttractSpeed ?? 6;
  const step = Math.min(dist, perFrame * Math.max(0, dt) * 60);
  pickup.x += (dx / dist) * step;
  pickup.y += (dy / dist) * step;
  return true;
}

/** True when a pickup overlaps the player's collection hitbox. */
export function pickupCaught(pickup, player) {
  if (!pickup || !player) return false;
  const pr = Number.isFinite(pickup.r) ? pickup.r : BALANCE.pickupRadius ?? 7;
  const hr = Number.isFinite(player.hitR) ? player.hitR : BALANCE.player?.hitR ?? 2;
  const pad = BALANCE.pickupGrabPad ?? 6;
  const dx = player.x - pickup.x;
  const dy = player.y - pickup.y;
  const r = pr + hr + pad;
  return dx * dx + dy * dy <= r * r;
}

/** Total number of power tiers (and therefore the power cap). */
export function powerTierCount() {
  return tierCount();
}

/** The POWERUP_TABLE row for a power level, clamped into 1..powerTiers. */
export function powerTier(power) {
  const tiers = tierTable();
  const level = Number.isFinite(power) ? Math.round(power) : 1;
  const index = Math.min(tiers.length, Math.max(1, level)) - 1;
  return tiers[index];
}

/** Number of fire streams the player owns at this power level (always >= 1). */
export function shotsForPower(power) {
  const tier = powerTier(power);
  return Math.max(1, Math.round(tier && Number.isFinite(tier.shots) ? tier.shots : 1));
}

/**
 * Fold a collected pickup into the state. Returns true when the pickup was
 * recognised and consumed, and announces a `powerup` event.
 */
export function applyPickup(state, pickup, events) {
  if (!state || !pickup) return false;
  const kind = pickup.kind;
  const sink = eventSink(events, state);

  switch (kind) {
    case 'power':
      state.power = Math.min((state.power || 0) + 1, powerTierCount());
      break;
    case 'life':
      state.lives = (state.lives || 0) + 1;
      break;
    case 'bomb':
      state.bombs = Math.min((state.bombs || 0) + 1, BALANCE.bombMax ?? 9);
      break;
    case 'score':
      addScore(state, BALANCE.powerupScore ?? 1000, sink);
      break;
    default:
      return false;
  }

  emit(sink, {
    type: 'powerup',
    kind,
    x: pickup.x ?? 0,
    y: pickup.y ?? 0,
    power: state.power || 0,
    lives: state.lives || 0,
    bombs: state.bombs || 0,
  });
  return true;
}
