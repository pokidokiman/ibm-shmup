/**
 * src/core/input.mjs — keyboard + pointer to logical shmup actions.
 *
 * The module is DOM-agnostic: nothing here touches globals. `attach(target)` wires
 * a real element (the canvas or the window) from the bootstrap, while tests and
 * scripted replays drive the same state directly through `key(code, down)`.
 *
 * Logical actions (pinned by tests/core.test.mjs and docs/SPEC.md):
 *   up | down | left | right | fire | bomb | focus
 *
 * Behaviour notes:
 *   - Presses are *latched*: a key tapped between two simulation frames still
 *     reports an edge through `pressed(action)`, which satisfies the spec's
 *     "sub-frame input sampling" requirement.
 *   - `pressed()` consumes its edge (it fires once); `snapshot()` never does, so a
 *     caller may read the action state and the edge in the same frame.
 *   - Letter keys are accepted as `e.code` ("KeyZ") or `e.key` ("z"), and Shift as
 *     both "ShiftLeft"/"ShiftRight" and the generic "Shift".
 *
 * Pure ES module: no DOM globals, no three, no timers.
 */

/** The canonical action list, in stable order. */
export const ACTIONS = ['up', 'down', 'left', 'right', 'fire', 'bomb', 'focus'];

/** Physical key -> logical actions. Multiple keys may drive one action. */
const KEY_MAP = {
  ArrowUp: ['up'],
  KeyW: ['up'],
  ArrowDown: ['down'],
  KeyS: ['down'],
  ArrowLeft: ['left'],
  KeyA: ['left'],
  ArrowRight: ['right'],
  KeyD: ['right'],
  Space: ['fire'],
  KeyZ: ['fire'],
  KeyJ: ['fire'],
  KeyX: ['bomb'],
  KeyK: ['bomb'],
  ShiftLeft: ['focus'],
  ShiftRight: ['focus'],
  KeyL: ['focus'],
};

/** Virtual codes the pointer drives, folded into the same pipeline as real keys. */
const POINTER_CODES = { 0: 'PointerPrimary', 2: 'PointerSecondary' };
const POINTER_MAP = { PointerPrimary: ['fire'], PointerSecondary: ['bomb'] };

const KEY_ACTIONS = { ...KEY_MAP, ...POINTER_MAP };

/** Normalise `KeyboardEvent.code` / `KeyboardEvent.key` to a canonical code. */
export function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  if (raw === ' ' || raw === 'Space' || raw === 'Spacebar') return 'Space';
  if (raw.startsWith('Arrow') || raw.startsWith('Key') || raw.startsWith('Digit')) return raw;
  if (raw.startsWith('Shift')) return 'ShiftLeft';
  if (raw === 'esc' || raw === 'Escape') return 'Escape';
  if (raw.length === 1 && /[a-z]/i.test(raw)) return `Key${raw.toUpperCase()}`;
  return raw;
}

/**
 * @returns {{
 *   key(code: string, down?: boolean): boolean,
 *   snapshot(): object, state: object,
 *   pressed(action: string): boolean, released(action: string): boolean,
 *   set(action: string, down: boolean): object,
 *   axis(): { x: number, y: number },
 *   pointer: object, pointerMove(x: number, y: number, active?: boolean): object,
 *   pointerDown(button?: number, x?: number, y?: number): boolean,
 *   pointerUp(button?: number): boolean, pointerActive(active: boolean): object,
 *   anyHeld(): boolean, clear(): object, attach(target: any, options?: object): () => void,
 *   actions: string[]
 * }}
 */
export function createInput() {
  const held = new Set();
  const counts = Object.create(null);
  const edge = Object.create(null);
  const releasedEdge = Object.create(null);
  const overrides = Object.create(null);

  /** Live action state — the object the game reads every step. */
  const state = Object.create(null);

  /** Pointer position in target-local pixels plus button mask. */
  const pointer = { x: 0, y: 0, active: false, buttons: 0 };

  for (const a of ACTIONS) {
    counts[a] = 0;
    edge[a] = false;
    releasedEdge[a] = false;
    overrides[a] = false;
    state[a] = false;
  }

  const refresh = () => {
    for (const a of ACTIONS) state[a] = overrides[a] || counts[a] > 0;
    return state;
  };

  /** Low-level transition. Returns true when the code changed state. */
  const apply = (code, down) => {
    const actions = KEY_ACTIONS[code];
    if (!actions) return false;
    const isDown = held.has(code);
    if (down === isDown) return false;
    if (down) {
      held.add(code);
      for (const a of actions) {
        counts[a]++;
        edge[a] = true;
      }
    } else {
      held.delete(code);
      for (const a of actions) {
        counts[a] = Math.max(0, counts[a] - 1);
        releasedEdge[a] = true;
      }
    }
    refresh();
    return true;
  };

  /** Record a key press/release. `key('ArrowLeft', true)` / `key('ArrowLeft', false)`. */
  const key = (code, down = true) => apply(normalizeCode(code), down === true);

  /** Programmatic override, used by replays and menu-driven demos. */
  const set = (action, down = true) => {
    if (!ACTIONS.includes(action)) return state;
    overrides[action] = down === true;
    if (down === true) edge[action] = true;
    else releasedEdge[action] = true;
    return refresh();
  };

  /** Immutable-per-frame copy of the action state (safe to store). */
  const snapshot = () => {
    refresh();
    const out = {};
    for (const a of ACTIONS) out[a] = state[a] === true;
    return out;
  };

  /** Edge-triggered query: true on the first read after a press, then false. */
  const pressed = (action) => {
    if (edge[action] !== true) return false;
    edge[action] = false;
    return true;
  };

  /** Edge-triggered query for key releases. */
  const released = (action) => {
    if (releasedEdge[action] !== true) return false;
    releasedEdge[action] = false;
    return true;
  };

  /** True while any action is active (used to unlock/resume). */
  const anyHeld = () => ACTIONS.some((a) => state[a] === true);

  /** Directional input as a unit axis: x right-positive, y down-positive. */
  const axis = () => ({
    x: (state.right ? 1 : 0) - (state.left ? 1 : 0),
    y: (state.down ? 1 : 0) - (state.up ? 1 : 0),
  });

  const pointerMove = (x, y, active = true) => {
    if (Number.isFinite(x)) pointer.x = x;
    if (Number.isFinite(y)) pointer.y = y;
    pointer.active = active === true;
    return pointer;
  };

  const pointerActive = (active) => {
    pointer.active = active === true;
    return pointer;
  };

  const pointerDown = (button = 0, x, y) => {
    pointer.buttons |= 1 << button;
    if (x !== undefined || y !== undefined) pointerMove(x, y, true);
    const code = POINTER_CODES[button];
    if (!code) return false;
    return apply(code, true);
  };

  const pointerUp = (button = 0) => {
    pointer.buttons &= ~(1 << button);
    const code = POINTER_CODES[button];
    if (!code) return false;
    return apply(code, false);
  };

  /** Drop every held key, pending edge and pointer state (blur, pause, restart). */
  const clear = () => {
    held.clear();
    for (const a of ACTIONS) {
      counts[a] = 0;
      edge[a] = false;
      releasedEdge[a] = false;
      overrides[a] = false;
    }
    pointer.buttons = 0;
    return refresh();
  };

  /**
   * Bind real DOM events to the logical state. The element is passed in, never
   * looked up globally, so this file stays importable in plain Node.
   * @returns {() => void} detach function (removes every listener it added)
   */
  const attach = (target, options = {}) => {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    const opts = {
      preventDefault: options.preventDefault !== false,
      pointerFire: options.pointerFire !== false,
      pointerBomb: options.pointerBomb !== false,
      onFocusRequest: typeof options.onFocusRequest === 'function' ? options.onFocusRequest : null,
    };

    const localPoint = (ev) => {
      let x = Number.isFinite(ev.offsetX) ? ev.offsetX : ev.clientX;
      let y = Number.isFinite(ev.offsetY) ? ev.offsetY : ev.clientY;
      if (typeof target.getBoundingClientRect === 'function' && Number.isFinite(ev.clientX)) {
        const r = target.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) {
          x = ev.clientX - r.left;
          y = ev.clientY - r.top;
        }
      }
      pointerMove(x, y, true);
    };

    const onKeyDown = (ev) => {
      const code = normalizeCode(ev.code || ev.key);
      if (opts.preventDefault && KEY_ACTIONS[code]) ev.preventDefault();
      apply(code, true);
      if (opts.onFocusRequest) opts.onFocusRequest();
    };
    const onKeyUp = (ev) => {
      const code = normalizeCode(ev.code || ev.key);
      if (opts.preventDefault && KEY_ACTIONS[code]) ev.preventDefault();
      apply(code, false);
    };
    const onPointerDown = (ev) => {
      localPoint(ev);
      const button = ev.button ?? 0;
      if (opts.preventDefault && (button === 0 || button === 2)) ev.preventDefault();
      if (button === 0 && !opts.pointerFire) return;
      if (button === 2 && !opts.pointerBomb) return;
      pointerDown(button, pointer.x, pointer.y);
    };
    const onPointerUp = (ev) => {
      if (typeof target.releasePointerCapture === 'function' && ev.pointerId !== undefined) {
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          /* capture was never taken — nothing to release */
        }
      }
      pointerUp(ev.button ?? 0);
    };
    const onPointerMove = (ev) => localPoint(ev);
    const onPointerLeave = () => pointerActive(false);
    const onContextMenu = (ev) => {
      if (opts.preventDefault) ev.preventDefault();
    };
    const onBlur = () => clear();

    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('pointerdown', onPointerDown);
    target.addEventListener('pointerup', onPointerUp);
    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerleave', onPointerLeave);
    target.addEventListener('contextmenu', onContextMenu);
    target.addEventListener('blur', onBlur);

    return () => {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerleave', onPointerLeave);
      target.removeEventListener('contextmenu', onContextMenu);
      target.removeEventListener('blur', onBlur);
    };
  };

  return {
    key,
    set,
    snapshot,
    pressed,
    released,
    anyHeld,
    axis,
    clear,
    attach,
    pointer,
    pointerMove,
    pointerDown,
    pointerUp,
    pointerActive,
    /** Live action state object (mutated in place by `key`/`set`). */
    state,
    actions: ACTIONS.slice(),
  };
}

export default createInput;
