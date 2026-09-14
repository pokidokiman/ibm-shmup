/**
 * src/render/capture.mjs — the frame probe: how much of the tube is actually lit?
 *
 * `three-scene.mjs` composites the playfield through the CRT pass onto the
 * canvas, but a headless check (or a debug overlay) cannot screenshot a canvas.
 * It can, however, ask the driver what it just painted: `litFraction(canvas)`
 * calls `gl.readPixels` on the composited frame and returns the share of pixels
 * that are not black — the cheapest honest "did anything render?" signal there
 * is, and the only one that survives the post chain untouched.
 *
 * Wiring, straight after the frame that composed it:
 *
 *   const view = createScene({ canvas });
 *   view.draw(dt);                    // playfield + CRT composite -> canvas
 *   litFraction(canvas);              // readPixels on that composite, 0..1
 *
 * Read in the SAME tick as `draw()`. Without `preserveDrawingBuffer` the drawing
 * buffer may be cleared once the frame has been presented, so capture before
 * yielding to the event loop (no awaits, no rAF in between). The default
 * framebuffer is what gets sampled: `draw()` unbinds its render target before
 * the final composite precisely so the CRT result lands on the canvas.
 *
 * The module deliberately takes no rendering-framework dependency — it only
 * needs something that can hand back a WebGL context — which keeps it
 * importable (and therefore unit-testable) in bare Node, where the scene layer
 * cannot load. Beyond an `HTMLCanvasElement` (or the id selector it resolves
 * to), it accepts a raw context, a `THREE.WebGLRenderer`, or a `createScene`
 * view, so callers never have to remember which one they hold.
 *
 *   litFraction(canvas)            // HTMLCanvasElement / canvas id
 *   litFraction(renderer)          // anything with getContext()
 *   litFraction(gl)                // an existing WebGLRenderingContext
 *   litFraction(view)              // the object returned by createScene()
 *
 * A canvas that cannot produce a context, a zero-sized buffer or a throwing
 * `readPixels` all report `0` (nothing lit) rather than exploding inside the
 * render loop: the probe must never be the thing that takes the game down.
 */

/** WebGL enum fallbacks, for contexts that do not expose their constants. */
const RGBA = 0x1908;
const UNSIGNED_BYTE = 0x1401;

/** Context flavours tried in order; the first one that yields wins. */
const CONTEXT_TYPES = ['webgl2', 'webgl', 'experimental-webgl'];

/** One reusable readback buffer per context, so a per-frame probe allocates nothing. */
const buffers = new WeakMap();

/* ------------------------------------------------------------------ helpers */

/**
 * Dig a WebGL context out of whatever the caller handed us.
 *
 * @param {*} target canvas | context | renderer | scene view | null
 * @returns {WebGLRenderingContext|null}
 */
function resolveContext(target) {
  if (!target) return null;
  if (typeof target.readPixels === 'function') return target;
  if (typeof target.getContext === 'function') {
    for (const type of CONTEXT_TYPES) {
      let ctx = null;
      try {
        ctx = target.getContext(type);
      } catch (err) {
        ctx = null;
      }
      if (ctx && typeof ctx.readPixels === 'function') return ctx;
    }
    return null;
  }
  // Wrappers: a THREE.WebGLRenderer, a createScene() view, a { gl } holder.
  return resolveContext(target.renderer ?? target.context ?? target.gl ?? target.canvas ?? target.domElement ?? null);
}

/** The canvas behind a target, when it has one (used only for its pixel size). */
function resolveCanvas(gl, target) {
  if (target && typeof target.getContext === 'function') return target;
  return target?.canvas ?? target?.domElement ?? gl?.canvas ?? null;
}

/** Positive integer, or 0 when the value is not usable as a dimension. */
function dim(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Size of the framebuffer to read: explicit options win, then the canvas pixel
 * size, then the live drawing buffer (they agree for a three-managed canvas).
 */
function readSize(gl, canvas, opts) {
  const bufferWidth = dim(gl.drawingBufferWidth);
  const bufferHeight = dim(gl.drawingBufferHeight);
  const width = dim(opts.width) || dim(canvas?.width) || dim(canvas?.clientWidth) || bufferWidth;
  const height = dim(opts.height) || dim(canvas?.height) || dim(canvas?.clientHeight) || bufferHeight;
  return { width, height };
}

/** Borrow (and resize, when the canvas changed) the cached readback buffer. */
function readBuffer(gl, bytes) {
  const cached = buffers.get(gl);
  if (cached && cached.length === bytes) return cached;
  const fresh = new Uint8Array(bytes);
  buffers.set(gl, fresh);
  return fresh;
}

/** A pixel counts as lit when any colour channel survives the threshold. */
export function isLitPixel(pixels, index, threshold = 0, includeAlpha = false) {
  return (
    pixels[index] > threshold ||
    pixels[index + 1] > threshold ||
    pixels[index + 2] > threshold ||
    (includeAlpha && pixels[index + 3] > threshold)
  );
}

/* ------------------------------------------------------------------- capture */

/**
 * Read the composited frame back into a `Uint8Array` (RGBA, bottom-up), the way
 * `gl.readPixels` returns it.
 *
 * @param {*} target canvas | WebGL context | renderer | scene view
 * @param {{ width?: number, height?: number, x?: number, y?: number }} [opts]
 * @returns {{ width: number, height: number, pixels: Uint8Array, lit: number, fraction: number, gl: object }|null}
 *          `null` when there is nothing to read (no context, no size).
 */
export function captureFrame(target, opts = {}) {
  const gl = resolveContext(target);
  if (!gl) return null;

  const canvas = resolveCanvas(gl, target);
  const { width, height } = readSize(gl, canvas, opts);
  if (width <= 0 || height <= 0) return null;

  const total = width * height;
  const pixels = readBuffer(gl, total * 4);
  const x = Math.max(0, Math.floor(Number(opts.x) || 0));
  const y = Math.max(0, Math.floor(Number(opts.y) || 0));

  try {
    gl.readPixels(x, y, width, height, gl.RGBA ?? RGBA, gl.UNSIGNED_BYTE ?? UNSIGNED_BYTE, pixels);
  } catch (err) {
    return null;
  }

  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : Number.isFinite(opts.tolerance) ? opts.tolerance : 0;
  const includeAlpha = opts.includeAlpha === true;

  let lit = 0;
  for (let i = 0; i < pixels.length; i += 4) if (isLitPixel(pixels, i, threshold, includeAlpha)) lit++;

  return { width, height, pixels, lit, fraction: lit / total, gl };
}

/**
 * Fraction of the composited frame that is not black, 0..1.
 *
 * Call it in the same tick as the `draw()` that produced the frame; see the
 * module header for why. Never throws: an unreadable frame reports 0.
 *
 * "Non-black" is literal by default — the CRT bezel around the playfield is the
 * dark glass `#050a06`, not `#000`, so if you want "did the playfield render?"
 * rather than "is this frame not pure black?", raise `threshold` past the bezel
 * (8 is enough for that clear colour).
 *
 * @param {*} target canvas | WebGL context | renderer | scene view
 * @param {{ width?: number, height?: number, x?: number, y?: number, threshold?: number, includeAlpha?: boolean }} [opts]
 * @returns {number} lit pixels / sampled pixels
 */
export function litFraction(target, opts = {}) {
  const frame = captureFrame(target, opts);
  return frame ? frame.fraction : 0;
}

/**
 * Convenience for the game loop: draw one frame through a `createScene()` view
 * and immediately measure the composite it produced.
 *
 * @param {{ draw?: Function, canvas?: * }} view
 * @param {number} [dt] seconds since the previous frame
 * @param {object} [opts] capture options (see `litFraction`)
 * @returns {number} 0..1, or 0 when the view cannot be drawn/read
 */
export function litFractionAfterDraw(view, dt = 0, opts = {}) {
  if (!view || typeof view.draw !== 'function') return 0;
  view.draw(Number.isFinite(dt) ? dt : 0);
  return litFraction(view.canvas ?? view.renderer ?? view, opts);
}

export default litFraction;
