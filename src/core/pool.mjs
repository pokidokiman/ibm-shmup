/**
 * src/core/pool.mjs — generic object pool.
 *
 * A pool owns at most `size` live objects. Objects are created lazily by `factory`
 * the first time a slot is needed and then recycled forever, so steady-state play
 * performs no allocation and never forces a GC pause mid-danmaku.
 *
 *   const bullets = createPool(512, () => ({ x: 0, y: 0, vx: 0, vy: 0, live: false }));
 *   const b = bullets.acquire();
 *   if (b) { b.x = 10; ... }
 *   bullets.release(b);
 *
 * Invariants (pinned by tests/core.test.mjs):
 *   - `active` holds live objects only.
 *   - `acquire()` past capacity returns `null` — it never throws.
 *   - The factory is not invoked again while a free slot exists.
 *
 * Pure ES module: no DOM, no three, no timers.
 */

/**
 * @param {number} size maximum number of simultaneously live objects
 * @param {() => object} factory builds one object when the pool must grow
 */
export function createPool(size, factory) {
  if (typeof factory !== 'function') throw new TypeError('createPool(size, factory): factory must be a function');
  const capacity = Math.max(0, Math.floor(Number(size)) || 0);
  /** Recycled objects waiting for a new owner. */
  const free = [];
  /** Live objects, oldest first. */
  let created = 0;

  const active = [];

  /**
   * Hand out an object, or `null` when every slot is taken.
   *
   * When the pool is full but the free list is empty the freshly built object is
   * parked in the free list instead of being dropped: the one-off reserve keeps
   * later over-capacity calls allocation-free as well.
   */
  const acquire = () => {
    let obj;
    if (free.length > 0) {
      obj = free.pop();
    } else {
      obj = factory();
      created++;
    }
    if (active.length >= capacity) {
      free.push(obj);
      return null;
    }
    active.push(obj);
    return obj;
  };

  /** Return an object to the pool. Unknown/double releases are ignored. */
  const release = (obj) => {
    if (obj === null || obj === undefined) return false;
    const i = active.indexOf(obj);
    if (i < 0) return false;
    active.splice(i, 1);
    if (!free.includes(obj)) free.push(obj);
    return true;
  };

  /** Release everything currently live. */
  const releaseAll = () => {
    while (active.length > 0) {
      const obj = active.pop();
      if (!free.includes(obj)) free.push(obj);
    }
    return free.length;
  };

  /** Is `obj` currently handed out by this pool? */
  const has = (obj) => active.indexOf(obj) >= 0;

  /** Visit every live object (safe against `release` inside the callback). */
  const each = (fn) => {
    for (let i = active.length - 1; i >= 0; i--) {
      const obj = active[i];
      if (obj !== undefined) fn(obj, i);
    }
    return active.length;
  };

  return {
    /** Live objects only. */
    active,
    capacity,
    acquire,
    release,
    releaseAll,
    has,
    each,
    /** How many objects the pool has ever built. */
    get created() {
      return created;
    },
    /** Recycled objects sitting in reserve. */
    get free() {
      return free.length;
    },
    get size() {
      return active.length;
    },
    get full() {
      return active.length >= capacity;
    },
  };
}

export default createPool;
