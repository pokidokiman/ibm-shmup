/**
 * src/core/rng.mjs — deterministic seeded pseudo-random number generator.
 *
 * mulberry32: 32-bit state, one implicit 32-bit multiplication per draw, excellent
 * statistical quality for gameplay work and — crucially — byte-identical replays for
 * a given seed on every platform (all math goes through `Math.imul` + `>>> 0`).
 *
 * Pure ES module: no DOM, no three, no timers. Same seed -> same stream, forever.
 *
 *   const rng = createRng(1234);
 *   rng.next();            // [0, 1)
 *   rng.float(-3, 5);      // [-3, 5)
 *   rng.int(2, 6);         // 2..6 inclusive
 *   rng.pick(['a', 'b']);  // uniform element
 *   rng.chance(0.25);      // true 25% of the time
 */

const UINT32 = 4294967296; // 2 ** 32
const TWO_PI = Math.PI * 2;

/** Mulberry32 step. Exposed so the generator can be re-seeded cheaply. */
function hash(seed) {
  return Math.floor(Number.isFinite(seed) ? seed : 0) >>> 0;
}

/**
 * @param {number} [seed=0] any finite number; fractional seeds are floored
 * @returns {{
 *   next(): number, unit(): number, bool(p?: number): boolean, chance(p?: number): boolean,
 *   float(min?: number, max?: number): number, int(min: number, max: number): number,
 *   sign(): number, pick<T>(arr: ArrayLike<T>): T|undefined, shuffle<T>(arr: T[]): T[],
 *   angle(): number, gaussian(mean?: number, stdev?: number): number,
 *   fork(salt?: number): object, reset(seed?: number): object,
 *   seed: number, calls: number, state: number
 * }}
 */
export function createRng(seed = 0) {
  const origin = hash(seed);
  let state = origin;
  let calls = 0;
  let spare = null; // cached second Box-Muller sample

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    calls++;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };

  const float = (min = 0, max = 1) => {
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 1;
    const a = Math.min(lo, hi);
    const b = Math.max(lo, hi);
    return a + next() * (b - a);
  };

  const int = (min = 0, max = 1) => {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return lo | 0;
    const n = Math.floor(lo + next() * (hi - lo + 1));
    return n > hi ? hi : n;
  };

  const bool = (p = 0.5) => next() < p;

  const chance = (p = 0.5) => {
    if (!Number.isFinite(p) || p <= 0) return false;
    if (p >= 1) return true;
    return next() < p;
  };

  const sign = () => (next() < 0.5 ? -1 : 1);

  const pick = (arr) => {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(next() * arr.length)];
  };

  const shuffle = (arr) => {
    if (!Array.isArray(arr)) return arr;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  };

  const angle = () => next() * TWO_PI;

  const gaussian = (mean = 0, stdev = 1) => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return mean + v * stdev;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = next() * 2 - 1;
      v = next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const scale = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * scale;
    return mean + u * scale * stdev;
  };

  const reset = (nextSeed = origin) => {
    state = hash(nextSeed);
    calls = 0;
    spare = null;
    return api;
  };

  const fork = (salt = 0x9e3779b9) => createRng((state ^ hash(salt)) >>> 0);

  const api = {
    next,
    unit: next,
    bool,
    chance,
    float,
    int,
    sign,
    pick,
    shuffle,
    angle,
    gaussian,
    reset,
    fork,
    get seed() {
      return origin;
    },
    get calls() {
      return calls;
    },
    get state() {
      return state;
    },
  };
  return api;
}

export default createRng;
