/**
 * powerups.mjs — drop table, pickup types, auto-collect and power tiers.
 *
 * Pure simulation code: no DOM, no three, no timers. `dropFor()` decides,
 * deterministically from the injected RNG, whether a dying enemy leaves a
 * pickup and which kind; both the weighted lottery and the per-archetype drop
 * chance come straight out of config.mjs so the tables can never drift.
 *
 * `applyPickup()` folds a collected pickup into the shared GameState, and the
 * magnet + auto-collect helpers implement the Cave-style item vacuum that snaps
 * drops to a focused (slow-moving) player or to a player camping up top.
 */
import { BALANCE, POWERUP_TABLE, DROP_TABLE, DROP_CHANCE, DEFAULT_SEED } from './config.mjs';
import { createRng } from '../core/rng.mjs';
import { addScore } from './scoring.mjs';

export { DROP_TABLE, DROP_CHANCE };

/** Every pickup kind the game understands. */
export const PICKUP_KINDS = ['power', 'life', 'bomb', 'score'];

/** Frames per simulated second; item speeds are authored in pixels/frame. */
const FRAMES_PER_SECOND = 60;

/** Used when config.mjs has not supplied a wire table (keeps tiers 1..4 sane). */
const FALLBACK_TIERS = [
  { tier: 1, shots: 1 },
  { tier: 2, shots: 2 },
  { tier: 3, shots: 3 },
  { tier: 4, shots: 4 },
];

/* ---------------------------------------------------------------- helpers */

/** First finite argument wins, otherwise the final one (the default). */
function pick(...values) {
  for (const v of values) if (Number.isFinite(v)) return v;
  return values[values.length - 1];
}

const ITEM = BALANCE.item && typeof BALANCE.item === 'object' ? BALANCE.item : {};
const FIELD = BALANCE.field && typeof BALANCE.field === 'object' ? BALANCE.field : {};
const BOMB = BALANCE.bomb && typeof BALANCE.bomb === 'object' ? BALANCE.bomb : {};

/** Item tuning, read once from config.mjs (the single balance source). */
const PICKUP_RADIUS = pick(ITEM.r, BALANCE.pickupRadius, 12);
const PICKUP_FALL_SPEED = pick(ITEM.fallSpeed, BALANCE.pickupFallSpeed, 2.4);
const PICKUP_MAGNET_SPEED = pick(ITEM.magnetSpeed, BALANCE.pickupAttractSpeed, 7.5);
const PICKUP_LIFETIME = pick(ITEM.lifetime, BALANCE.pickupLifetime, 720);
const AUTO_COLLECT_Y = pick(ITEM.autoCollectY, 180);
const SCORE_VALUE = pick(ITEM.scoreValue, BALANCE.powerupScore, 2500);
const COLLECT_RADIUS = pick(BALANCE.collectRadius, 26);
const FOCUS_COLLECT_RADIUS = pick(BALANCE.focusCollectRadius, 150);
const GRAB_PAD = pick(BALANCE.pickupGrabPad, 6);
const BOMB_CAP = pick(BALANCE.bombMax, BOMB.stockCap, 8);
const DESPAWN_Y = pick(FIELD.despawnY, 768 + 96);

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

/** Archetype name a live enemy (or its spec) reports. */
export function enemyKind(enemy) {
  if (!enemy) return 'default';
  if (typeof enemy.kind === 'string') return enemy.kind;
  if (typeof enemy.type === 'string') return enemy.type;
  return 'default';
}

/** Rewrite config's DROP_TABLE array into the {kind: weight} map the roll wants. */
function buildWeights() {
  const rows = Array.isArray(DROP_TABLE) ? DROP_TABLE : [];
  const weights = {};
  for (const row of rows) {
    if (!row || typeof row.kind !== 'string') continue;
    if (!PICKUP_KINDS.includes(row.kind)) continue;
    const weight = Math.max(0, pick(row.weight, 1));
    if (weight > 0) weights[row.kind] = weight;
  }
  if (Object.keys(weights).length === 0) for (const kind of PICKUP_KINDS) weights[kind] = 1;
  return weights;
}

/** Weighted kind table, in config's declared scan order (deterministic). */
const WEIGHTS = buildWeights();

/** Lazily-built stream used only when a caller forgets to inject its own RNG. */
let fallbackRng = null;
function usableRng(rng) {
  if (rng && typeof rng.chance === 'function' && typeof rng.float === 'function') return rng;
  if (!fallbackRng) fallbackRng = createRng(DEFAULT_SEED);
  return fallbackRng;
}

/** Per-archetype chance a kill rolls the drop lottery at all. */
export function dropChance(enemy) {
  if (enemy && Number.isFinite(enemy.drop)) return Math.max(0, Math.min(1, enemy.drop));
  const table = DROP_CHANCE && typeof DROP_CHANCE === 'object' ? DROP_CHANCE : {};
  return Math.max(0, Math.min(1, pick(table[enemyKind(enemy)], table.default, 0.16)));
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
  const chance = dropChance(enemy);
  if (chance <= 0) return null;
  const source = usableRng(rng);
  if (!source.chance(chance)) return null;
  const kind = pickWeighted(WEIGHTS, source);
  if (!kind) return null;
  return {
    kind,
    x: enemy && Number.isFinite(enemy.x) ? enemy.x : 0,
    y: enemy && Number.isFinite(enemy.y) ? enemy.y : 0,
  };
}

/** Turn a drop spec into a live pickup entity for the renderer/collector. */
export function createPickup(drop) {
  const kind = drop && PICKUP_KINDS.includes(drop.kind) ? drop.kind : 'score';
  return {
    kind,
    x: drop && Number.isFinite(drop.x) ? drop.x : 0,
    y: drop && Number.isFinite(drop.y) ? drop.y : 0,
    r: PICKUP_RADIUS,
    vx: 0,
    vy: PICKUP_FALL_SPEED,
    t: 0,
    active: true,
  };
}

/* ------------------------------------------------------------ collection */

/** True when the player's collector vacuums the entire screen. */
export function autoCollect(player) {
  if (!player) return false;
  if (player.focus) return true;
  return Number.isFinite(player.y) && player.y <= AUTO_COLLECT_Y;
}

/** Radius within which drops fly to the player (focus/auto mode widens it). */
export function collectRadius(player) {
  return autoCollect(player) ? FOCUS_COLLECT_RADIUS : COLLECT_RADIUS;
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
  const frames = Math.max(0, Number.isFinite(dt) ? dt : 0) * FRAMES_PER_SECOND;
  const step = Math.min(dist, PICKUP_MAGNET_SPEED * frames);
  pickup.x += (dx / dist) * step;
  pickup.y += (dy / dist) * step;
  return true;
}

/** True when a pickup overlaps the player's collection hitbox. */
export function pickupCaught(pickup, player) {
  if (!pickup || !player) return false;
  const pr = Number.isFinite(pickup.r) ? pickup.r : PICKUP_RADIUS;
  const hr = Number.isFinite(player.hitR) ? player.hitR : (BALANCE.player && BALANCE.player.hitR) || 2;
  const dx = player.x - pickup.x;
  const dy = player.y - pickup.y;
  const r = pr + hr + GRAB_PAD;
  return dx * dx + dy * dy <= r * r;
}

/**
 * One simulation tick for a live pickup list, in place: age and drop each
 * pickup, vacuum the ones inside reach, consume the caught ones and retire the
 * expired/off-screen ones. Returns how many were collected this tick.
 */
export function updatePickups(state, pickups, player, dt, events) {
  if (!Array.isArray(pickups) || !player) return 0;
  const frames = Math.max(0, Number.isFinite(dt) ? dt : 0) * FRAMES_PER_SECOND;
  const reach = collectRadius(player);
  let collected = 0;
  for (let i = pickups.length - 1; i >= 0; i--) {
    const item = pickups[i];
    if (!item || item.active === false) {
      pickups.splice(i, 1);
      continue;
    }
    item.t = (Number.isFinite(item.t) ? item.t : 0) + frames;
    const pulled = attractPickup(item, player, dt, reach);
    if (!pulled) {
      item.x += (Number.isFinite(item.vx) ? item.vx : 0) * frames;
      item.y += (Number.isFinite(item.vy) ? item.vy : PICKUP_FALL_SPEED) * frames;
    }
    if (pickupCaught(item, player) && applyPickup(state, item, events)) {
      collected += 1;
      pickups.splice(i, 1);
      continue;
    }
    if (item.t >= PICKUP_LIFETIME || item.y > DESPAWN_Y) pickups.splice(i, 1);
  }
  return collected;
}

/* ------------------------------------------------------------- power tier */

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

/* --------------------------------------------------------------- pickups */

/** Current power level, never below tier 1. */
export function powerLevel(state) {
  if (!state) return 1;
  return Number.isFinite(state.power) ? Math.max(1, Math.round(state.power)) : 1;
}

/**
 * Fold a collected pickup into the state. Returns true when the pickup was
 * recognised and consumed, and announces a `powerup` event carrying the
 * post-collection counters so the HUD never has to guess.
 */
export function applyPickup(state, pickup, events) {
  if (!state || !pickup) return false;
  const kind = pickup.kind;
  const sink = eventSink(events, state);
  let value = 0;

  switch (kind) {
    case 'power': {
      const cap = powerTierCount();
      const level = Math.min(powerLevel(state) + 1, cap);
      value = level;
      state.power = level;
      break;
    }
    case 'life':
      state.lives = (state.lives || 0) + 1;
      value = state.lives;
      break;
    case 'bomb': {
      const held = Number.isFinite(state.bombs) ? state.bombs : 0;
      const next = Math.min(held + 1, BOMB_CAP);
      value = next;
      state.bombs = next;
      break;
    }
    case 'score':
      value = SCORE_VALUE;
      addScore(state, value, sink);
      break;
    default:
      return false;
  }

  emit(sink, {
    type: 'powerup',
    kind,
    x: pickup.x ?? 0,
    y: pickup.y ?? 0,
    value,
    score: state.score || 0,
    power: powerLevel(state),
    lives: state.lives || 0,
    bombs: state.bombs || 0,
  });
  return true;
}
