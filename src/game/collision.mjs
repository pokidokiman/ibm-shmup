/**
 * collision.mjs — pure geometry + broadphase for the danmaku simulation.
 *
 * No DOM, no three, no timers: usable straight from Node (see tests/game.test.mjs).
 *
 * Contract:
 *   circlesHit(ax, ay, ar, bx, by, br) -> boolean          (touching counts as a hit)
 *   playerHitbox(player)               -> { x, y, r }      (tight 2px danmaku hitbox)
 *   hitsEntity(player, ox, oy, or)     -> boolean          (player vs one circle)
 *   grazeBand(player, grazeR, ox, oy, or) -> boolean       (inside graze ring, not touching)
 *   createGrid(cell) -> {
 *     cell, size,
 *     insert(o), remove(o), clear(),
 *     query(x, y, r)          -> candidate objects (broadphase, no exact test)
 *     hits(x, y, r, out?)     -> objects whose circle really overlaps (x, y, r)
 *   }
 *
 * Grid objects are anything with numeric `x`, `y` and (optionally) `r`; the grid keeps
 * its bookkeeping in WeakMaps so it never mutates the objects it indexes.
 */

const DEFAULT_CELL = 64;
const MIN_CELL = 4;
const MAX_CELLS_PER_OBJECT = 256;

/** Circle-vs-circle test. Degenerate radii are treated as 0 rather than exploding. */
export function circlesHit(ax, ay, ar, bx, by, br) {
  const a = typeof ar === 'number' && ar > 0 ? ar : 0;
  const b = typeof br === 'number' && br > 0 ? br : 0;
  const dx = (bx || 0) - (ax || 0);
  const dy = (by || 0) - (ay || 0);
  const reach = a + b;
  return dx * dx + dy * dy <= reach * reach;
}

/** Squared distance — handy for range checks that must not allocate. */
export function distSq(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/**
 * The tight player hitbox. Player ships carry `hitR` (2px by balance); anything without
 * an explicit radius falls back to the danmaku default of 2.
 */
export function playerHitbox(player) {
  const p = player || {};
  return {
    x: typeof p.x === 'number' ? p.x : 0,
    y: typeof p.y === 'number' ? p.y : 0,
    r: typeof p.hitR === 'number' ? p.hitR : 2,
  };
}

/** Player hitbox vs a single circle. */
export function hitsEntity(player, ox, oy, or) {
  const p = player || {};
  const r = typeof p.hitR === 'number' ? p.hitR : 2;
  return circlesHit(p.x, p.y, r, ox, oy, or);
}

/**
 * Graze band: the bullet is close enough to brush the ship (within `grazeR` of the
 * hitbox edge) but does not actually touch it. Grazing pays score, touching costs a life.
 */
export function grazeBand(player, grazeR, ox, oy, or) {
  const p = player || {};
  const r = typeof p.hitR === 'number' ? p.hitR : 2;
  if (circlesHit(p.x, p.y, r, ox, oy, or)) return false;
  const band = (typeof grazeR === 'number' && grazeR > 0 ? grazeR : 0) + (or > 0 ? or : 0);
  return distSq(p.x, p.y, ox, oy) <= band * band;
}

/** First object in `list` that touches the player, or null. Allocation-free. */
export function firstHit(player, list) {
  if (!list) return null;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (!o) continue;
    if (hitsEntity(player, o.x, o.y, typeof o.r === 'number' ? o.r : 0)) return o;
  }
  return null;
}

/** Count every player hit inside `list` (used to decide when a hit actually lands). */
export function countHits(player, list) {
  let n = 0;
  if (!list) return n;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o && hitsEntity(player, o.x, o.y, typeof o.r === 'number' ? o.r : 0)) n++;
  }
  return n;
}

/**
 * Uniform-grid broadphase. Objects are bucketed by the cells their bounding box touches,
 * so a single `query` only walks a handful of buckets instead of the whole field.
 */
export function createGrid(cell = DEFAULT_CELL) {
  const cellSize = Number.isFinite(cell) && cell >= MIN_CELL ? Math.floor(cell) : DEFAULT_CELL;
  const buckets = new Map();
  let membership = new WeakMap();
  let stamps = new WeakMap();
  let stamp = 0;
  let count = 0;

  const hash = (cx, cy) => (cx * 73856093) ^ (cy * 19349663);

  function bucketFor(cx, cy) {
    const k = hash(cx, cy);
    let b = buckets.get(k);
    if (!b) {
      b = [];
      buckets.set(k, b);
    }
    return b;
  }

  function insert(o) {
    if (!o || typeof o.x !== 'number' || typeof o.y !== 'number') return false;
    if (membership.has(o)) remove(o);
    const r = typeof o.r === 'number' && o.r > 0 ? o.r : 0;
    const cx0 = Math.floor((o.x - r) / cellSize);
    const cx1 = Math.floor((o.x + r) / cellSize);
    const cy0 = Math.floor((o.y - r) / cellSize);
    const cy1 = Math.floor((o.y + r) / cellSize);
    const cells = [];
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) <= MAX_CELLS_PER_OBJECT) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) cells.push(cx, cy);
      }
    } else {
      // Absurdly large object: bucket it by its centre only, it is bigger than the grid.
      cells.push(Math.floor(o.x / cellSize), Math.floor(o.y / cellSize));
    }
    for (let i = 0; i < cells.length; i += 2) bucketFor(cells[i], cells[i + 1]).push(o);
    membership.set(o, cells);
    count++;
    return true;
  }

  function remove(o) {
    const cells = membership.get(o);
    if (!cells) return false;
    for (let i = 0; i < cells.length; i += 2) {
      const b = buckets.get(hash(cells[i], cells[i + 1]));
      if (!b) continue;
      const idx = b.indexOf(o);
      if (idx >= 0) b.splice(idx, 1);
    }
    membership.delete(o);
    count--;
    return true;
  }

  function clear() {
    buckets.clear();
    membership = new WeakMap();
    stamps = new WeakMap();
    stamp = 0;
    count = 0;
  }

  /** Candidate objects whose bucket overlaps the query box. No exact-circle filtering. */
  function query(x, y, r = 0, out = []) {
    out.length = 0;
    const qx = typeof x === 'number' ? x : 0;
    const qy = typeof y === 'number' ? y : 0;
    const qr = typeof r === 'number' && r > 0 ? r : 0;
    stamp++;
    const cx0 = Math.floor((qx - qr) / cellSize);
    const cx1 = Math.floor((qx + qr) / cellSize);
    const cy0 = Math.floor((qy - qr) / cellSize);
    const cy1 = Math.floor((qy + qr) / cellSize);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const b = buckets.get(hash(cx, cy));
        if (!b) continue;
        for (let i = 0; i < b.length; i++) {
          const o = b[i];
          if (stamps.get(o) === stamp) continue;
          stamps.set(o, stamp);
          out.push(o);
        }
      }
    }
    return out;
  }

  /** Broadcast candidates narrowed by a real circle test against (x, y, r). */
  function hits(x, y, r = 0, out = []) {
    const candidates = query(x, y, r);
    out.length = 0;
    for (let i = 0; i < candidates.length; i++) {
      const o = candidates[i];
      if (circlesHit(x, y, r, o.x, o.y, typeof o.r === 'number' ? o.r : 0)) out.push(o);
    }
    return out;
  }

  return {
    insert,
    remove,
    clear,
    query,
    hits,
    get cell() {
      return cellSize;
    },
    get size() {
      return count;
    },
  };
}
