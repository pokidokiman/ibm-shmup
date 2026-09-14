/**
 * src/core/vec2.mjs — plain `{ x, y }` 2D vector math.
 *
 * Every function is pure: inputs are never mutated. Arithmetic helpers accept an
 * optional `out` vector so hot loops (bullets, particles) can recycle objects
 * instead of allocating.
 *
 * Pure ES module: no DOM, no three, no timers.
 */

const TAU = Math.PI * 2;

/** A fresh `{ x: 0, y: 0 }`. */
export const zero = () => ({ x: 0, y: 0 });

/** Shallow copy of `v` (optionally into `out`). */
export function clone(v, out) {
  const o = out || { x: 0, y: 0 };
  o.x = v.x;
  o.y = v.y;
  return o;
}

/** Pure vector creation from components. */
export function vec(x = 0, y = 0) {
  return { x, y };
}

/** Write `x, y` into `out` (or a new vector). */
export function set(out, x = 0, y = 0) {
  const o = out || { x: 0, y: 0 };
  o.x = x;
  o.y = y;
  return o;
}

export function add(a, b, out) {
  const o = out || { x: 0, y: 0 };
  o.x = a.x + b.x;
  o.y = a.y + b.y;
  return o;
}

export function sub(a, b, out) {
  const o = out || { x: 0, y: 0 };
  o.x = a.x - b.x;
  o.y = a.y - b.y;
  return o;
}

/** Component-wise multiply (useful for aspect-correcting a direction). */
export function mul(a, b, out) {
  const o = out || { x: 0, y: 0 };
  o.x = a.x * b.x;
  o.y = a.y * b.y;
  return o;
}

/** Component-wise divide; a zero divisor leaves that component at 0. */
export function div(a, b, out) {
  const o = out || { x: 0, y: 0 };
  o.x = b.x === 0 ? 0 : a.x / b.x;
  o.y = b.y === 0 ? 0 : a.y / b.y;
  return o;
}

/** Scale a vector by a scalar. */
export function scale(v, s, out) {
  const o = out || { x: 0, y: 0 };
  o.x = v.x * s;
  o.y = v.y * s;
  return o;
}

export function negate(v, out) {
  const o = out || { x: 0, y: 0 };
  o.x = -v.x;
  o.y = -v.y;
  return o;
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

/** 2D cross product (z component of the 3D cross). */
export function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

/** Perpendicular vector (90 degrees counter-clockwise). */
export function perp(v, out) {
  const o = out || { x: 0, y: 0 };
  o.x = -v.y;
  o.y = v.x;
  return o;
}

export function lenSq(v) {
  return v.x * v.x + v.y * v.y;
}

export function len(v) {
  return Math.hypot(v.x, v.y);
}

export function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Unit vector; a zero-length input yields the zero vector (never NaN). */
export function norm(v, out) {
  const o = out || { x: 0, y: 0 };
  const d = Math.hypot(v.x, v.y);
  if (d < 1e-12) {
    o.x = 0;
    o.y = 0;
    return o;
  }
  o.x = v.x / d;
  o.y = v.y / d;
  return o;
}

/** Clamp a vector's magnitude to `max` (optionally with a dead zone). */
export function limit(v, max, out) {
  const o = out || { x: 0, y: 0 };
  const d = Math.hypot(v.x, v.y);
  if (d <= max || d < 1e-12) return clone(v, o);
  const k = max / d;
  o.x = v.x * k;
  o.y = v.y * k;
  return o;
}

export function isZero(v, eps = 1e-12) {
  return Math.abs(v.x) <= eps && Math.abs(v.y) <= eps;
}

export function equals(a, b, eps = 1e-9) {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

/**
 * Scalar linear interpolation. `t` is clamped to [0, 1] so callers can pass a
 * raw progress ratio without producing overshoot.
 */
export function lerp(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return a + (b - a) * k;
}

/** Vector linear interpolation (non-mutating, optional `out`). */
export function lerpVec(a, b, t, out) {
  const o = out || { x: 0, y: 0 };
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  o.x = a.x + (b.x - a.x) * k;
  o.y = a.y + (b.y - a.y) * k;
  return o;
}

/** Move `current` toward `target` by at most `maxDelta`. Never overshoots. */
export function approach(current, target, maxDelta) {
  const d = target - current;
  if (d > maxDelta) return current + maxDelta;
  if (d < -maxDelta) return current - maxDelta;
  return target;
}

/** Vector form of `approach`; snaps exactly onto the target once close enough. */
export function approachVec(current, target, maxDelta, out) {
  const o = out || { x: 0, y: 0 };
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const d = Math.hypot(dx, dy);
  if (d <= maxDelta || d < 1e-12) return clone(target, o);
  const k = maxDelta / d;
  o.x = current.x + dx * k;
  o.y = current.y + dy * k;
  return o;
}

export function clamp(x, min, max) {
  return x < min ? min : x > max ? max : x;
}

/** Angle of a vector in radians, `atan2(y, x)` -> [-PI, PI]. */
export function angle(v) {
  return Math.atan2(v.y, v.x);
}

/** Signed shortest rotation from `a` to `b`, in [-PI, PI]. */
export function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Shortest-path angle interpolation. */
export function angleLerp(a, b, t) {
  return a + angleDiff(a, b) * clamp(t, 0, 1);
}

/** Wrap an angle into [0, TAU). */
export function wrapAngle(a) {
  const w = a % TAU;
  return w < 0 ? w + TAU : w;
}

/** Vector of length `length` (default 1) pointing at `radians`. */
export function fromAngle(radians, length = 1, out) {
  const o = out || { x: 0, y: 0 };
  o.x = Math.cos(radians) * length;
  o.y = Math.sin(radians) * length;
  return o;
}

/** Rotate `v` by `radians` about the origin. */
export function rotate(v, radians, out) {
  const o = out || { x: 0, y: 0 };
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  o.x = v.x * c - v.y * s;
  o.y = v.x * s + v.y * c;
  return o;
}

/** Rotate `v` about `pivot`. */
export function rotateAround(v, pivot, radians, out) {
  const o = out || { x: 0, y: 0 };
  const dx = v.x - pivot.x;
  const dy = v.y - pivot.y;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  o.x = pivot.x + dx * c - dy * s;
  o.y = pivot.y + dx * s + dy * c;
  return o;
}

/** The `{x, y}` tuple as an array, handy for renderer code. */
export function toArray(v) {
  return [v.x, v.y];
}

export default {
  zero,
  clone,
  vec,
  set,
  add,
  sub,
  mul,
  div,
  scale,
  negate,
  dot,
  cross,
  perp,
  len,
  lenSq,
  dist,
  distSq,
  norm,
  limit,
  isZero,
  equals,
  lerp,
  lerpVec,
  approach,
  approachVec,
  clamp,
  angle,
  angleDiff,
  angleLerp,
  wrapAngle,
  fromAngle,
  rotate,
  rotateAround,
  toArray,
};
