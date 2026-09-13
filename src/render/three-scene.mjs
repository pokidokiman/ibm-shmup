/**
 * three-scene.mjs — renderer, orthographic playfield camera, sprite batching and
 * the CRT post chain.
 *
 * This module owns every GPU resource in the game:
 *
 *   • one `THREE.WebGLRenderer` painting into `<canvas id="game-canvas">`;
 *   • one `THREE.OrthographicCamera` whose frustum *is* the playfield design
 *     space (1024 x 768, origin top-left, +y downwards), so simulation
 *     coordinates are render coordinates — no conversion layer, no drift. The
 *     4:3 field is letterboxed into whatever the canvas aspect happens to be;
 *   • the procedural sprite atlas (`./sprites.mjs`), the parallax scenery
 *     (`./background.mjs`) and the CRT pass (`./crt.mjs`);
 *   • dynamic sprite batches so thousands of bullets and particles are drawn in
 *     a handful of draw calls, and the game layer never has to touch three.
 *
 * Frame pipeline:
 *
 *   playfield scene ──► WebGLRenderTarget ──► fullscreen quad (CRT) ──► canvas
 *
 * The render target is a real asset: post-processing is what gives the game its
 * monitor look, so the scene always renders through a target even when the CRT
 * pass is unavailable.
 *
 *   const view = createScene({ canvas, stage: 1 });
 *   view.batches.actors.begin();
 *   view.batches.actors.push('enemyGrunt', 300, 180, { size: 26 });
 *   view.setProgress(0.42);
 *   view.draw(dt);                    // flushes every batch, renders, composites
 *
 * Deliberate contract: nothing here imports `src/game/*` simulation state. The
 * caller pushes what it wants to see, which keeps the renderer swappable and
 * lets the game loop stay pure.
 */

import * as THREE from 'three';
import { FIELD, DEFAULT_SEED, DEFAULT_STAGE, STAGE_TABLE, stageFor } from '../game/config.mjs';
import { createAtlas } from './sprites.mjs';
import { createBackground } from './background.mjs';
import { createCRT } from './crt.mjs';

/** Design space of the playfield: one world unit is one playfield pixel. */
export const VIEW = Object.freeze({ width: FIELD.width, height: FIELD.height });
/** Aspect ratio the letterbox always preserves. */
export const VIEW_ASPECT = FIELD.width / FIELD.height;
/** Never render above this device pixel ratio; 4K CRT shading is not worth it. */
export const MAX_PIXEL_RATIO = 2;
/** Colour of the letterbox around the playfield — the CRT's dark glass. */
export const CLEAR_COLOR = '#050a06';
/** Index budget of a batch: `capacity * 4` vertices must fit a Uint16 index. */
const MAX_BATCH_CAPACITY = 4096;

/* -------------------------------------------------------------------- canvas */

function resolveCanvas(opts) {
  if (opts.canvas) return opts.canvas;
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;
  const selector = opts.canvasId ?? 'game-canvas';
  if (typeof doc.getElementById === 'function' && doc.getElementById(selector)) return doc.getElementById(selector);
  if (typeof doc.querySelector === 'function') return doc.querySelector(selector.startsWith('#') ? selector : `#${selector}`);
  return null;
}

/* -------------------------------------------------------------- sprite batch */

/**
 * A CPU-fed quad batch: the caller declares sprites once per frame, the batch
 * writes positions/uv/colour straight into preallocated typed arrays.
 *
 * @param {{ atlas: object, capacity?: number, depth?: number, renderOrder?: number, additive?: boolean }} opts
 */
export function createSpriteBatch(opts = {}) {
  const atlas = opts.atlas ?? null;
  const capacity = Math.max(1, Math.min(Math.floor(opts.capacity ?? 512) || 1, MAX_BATCH_CAPACITY));

  const positions = new Float32Array(capacity * 4 * 3);
  const uvs = new Float32Array(capacity * 4 * 2);
  const colors = new Float32Array(capacity * 4 * 4);
  const indices = new Uint16Array(capacity * 6);
  for (let q = 0; q < capacity; q++) {
    const v = q * 4;
    const k = q * 6;
    indices[k] = v;
    indices[k + 1] = v + 1;
    indices[k + 2] = v + 2;
    indices[k + 3] = v;
    indices[k + 4] = v + 2;
    indices[k + 5] = v + 3;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);

  const material = new THREE.MeshBasicMaterial({
    map: atlas?.texture ?? null,
    transparent: true,
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = opts.name ?? 'sprites';
  mesh.frustumCulled = false;
  mesh.position.z = opts.depth ?? 0;
  mesh.renderOrder = opts.renderOrder ?? 0;

  const tint = new THREE.Color(1, 1, 1);
  let count = 0;
  let dirty = false;

  /** Quad corner from a rotated centre: `dx/dy` are the local corner offsets. */
  function writeCorner(vertex, dx, dy, u, v, x, y, cos, sin) {
    const p = vertex * 3;
    positions[p] = x + dx * cos - dy * sin;
    positions[p + 1] = y + dx * sin + dy * cos;
    positions[p + 2] = 0;
    const t = vertex * 2;
    uvs[t] = u;
    uvs[t + 1] = v;
  }

  /**
   * Queue one sprite. Never allocates and never throws: when the batch is full
   * (or the sprite name is unknown) it returns `false` and the caller can slow
   * down its effects. Off-screen sprites are the caller's business.
   *
   * @param {string} name sprite name from the atlas
   * @param {number} x playfield x
   * @param {number} y playfield y
   * @param {{ size?: number, frame?: number, rot?: number, alpha?: number, scaleX?: number, scaleY?: number, tint?: string|number|THREE.Color }} [o]
   */
  function push(name, x, y, o = {}) {
    if (count >= capacity || !atlas || typeof atlas.uv !== 'function') return false;
    const uv = atlas.uv(name, (o.frame ?? 0) | 0);
    if (!uv) return false;

    const size = o.size ?? (typeof atlas.displaySize === 'function' ? atlas.displaySize(name) : 64);
    const hw = (size * (o.scaleX ?? 1)) / 2;
    const hh = (size * (o.scaleY ?? 1)) / 2;
    const rot = o.rot ?? 0;
    const cos = rot === 0 ? 1 : Math.cos(rot);
    const sin = rot === 0 ? 0 : Math.sin(rot);
    const vertex = count * 4;

    writeCorner(vertex, -hw, -hh, uv.u0, uv.v1, x, y, cos, sin);
    writeCorner(vertex + 1, hw, -hh, uv.u1, uv.v1, x, y, cos, sin);
    writeCorner(vertex + 2, -hw, hh, uv.u0, uv.v0, x, y, cos, sin);
    writeCorner(vertex + 3, hw, hh, uv.u1, uv.v0, x, y, cos, sin);

    if (o.tint !== undefined && o.tint !== null) tint.set(o.tint);
    else tint.setRGB(1, 1, 1);
    const alpha = o.alpha ?? 1;
    for (let i = 0; i < 4; i++) {
      const t = (vertex + i) * 4;
      colors[t] = tint.r;
      colors[t + 1] = tint.g;
      colors[t + 2] = tint.b;
      colors[t + 3] = alpha;
    }

    count++;
    dirty = true;
    return true;
  }

  return {
    mesh,
    geometry,
    material,
    capacity,
    get count() {
      return count;
    },
    /** Start a frame; the previous content is dropped without touching the GPU. */
    begin() {
      count = 0;
      return 0;
    },
    push,
    /**
     * Queue a sprite with explicit width/height instead of one edge length —
     * used for lasers and stretched bullets.
     */
    pushSized(name, x, y, width, height, o = {}) {
      const height0 = height ?? width;
      return push(name, x, y, { ...o, size: Math.max(width, height) });
    },
    /** Publish the accumulated quads to the GPU. Idempotent within a frame. */
    end() {
      geometry.setDrawRange(0, count * 6);
      if (dirty) {
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.uv.needsUpdate = true;
        geometry.attributes.color.needsUpdate = true;
        dirty = false;
      }
      return count;
    },
    setDepth(z) {
      mesh.position.z = z;
      return mesh;
    },
    dispose() {
      count = 0;
      if (mesh.parent) mesh.parent.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}

/* ----------------------------------------------------------------- the scene */

/**
 * @param {{
 *   canvas?: HTMLCanvasElement|string,
 *   doc?: Document,
 *   canvasId?: string,
 *   stage?: number|string|object,
 *   seed?: number,
 *   pixelRatio?: number,
 *   maxPixelRatio?: number,
 *   resolutionScale?: number,
 *   antialias?: boolean,
 *   actorCapacity?: number,
 *   fxCapacity?: number,
 *   autoResize?: boolean,
 *   crt?: Function|null,
 * }} [opts]
 */
export function createScene(opts = {}) {
  const canvas = resolveCanvas(opts);
  if (!canvas) throw new Error('createScene: no canvas element to render into');

  const stageRecord = typeof opts.stage === 'object' && opts.stage !== null ? opts.stage : stageFor(opts.stage ?? DEFAULT_STAGE.stage);

  /* ------------------------------------------------------------- renderer */

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: opts.antialias ?? false,
    alpha: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  const maxPixelRatio = Number.isFinite(opts.maxPixelRatio) ? opts.maxPixelRatio : MAX_PIXEL_RATIO;
  const nativePixelRatio = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
  const pixelRatio = Math.min(Number.isFinite(opts.pixelRatio) ? opts.pixelRatio : nativePixelRatio, maxPixelRatio);
  renderer.setPixelRatio(Math.max(pixelRatio, 0.5));
  renderer.setClearColor(CLEAR_COLOR, 1);
  if (THREE.SRGBColorSpace !== undefined) renderer.outputColorSpace = THREE.SRGBColorSpace;

  /* --------------------------------------------------------- scene graph */

  const scene = new THREE.Scene();
  scene.name = 'playfield';

  const camera = new THREE.OrthographicCamera(0, VIEW.width, 0, VIEW.height, 1, 4000);
  camera.position.set(0, 0, 1200);
  camera.updateProjectionMatrix();

  function makeLayer(name, order) {
    const group = new THREE.Group();
    group.name = name;
    group.renderOrder = order;
    scene.add(group);
    return group;
  }

  const layers = {
    backdrop: makeLayer('backdrop', -900),
    actors: makeLayer('actors', -800),
    fx: makeLayer('fx', -700),
    overlay: makeLayer('overlay', -600),
  };

  /* -------------------------------------------------------- render assets */

  const atlas = createAtlas({ THREE, doc: opts.doc, filter: THREE.NearestFilter });

  const background = createBackground({
    seed: opts.seed ?? DEFAULT_SEED,
    stage: stageRecord,
    pixelRatio: renderer.getPixelRatio(),
  });
  layers.backdrop.add(background.group);

  const batches = {
    actors: createSpriteBatch({ atlas, capacity: opts.actorCapacity ?? 1024, depth: 0, renderOrder: 0, name: 'actors' }),
    fx: createSpriteBatch({ atlas, capacity: opts.fxCapacity ?? 768, depth: 4, renderOrder: 4, additive: true, name: 'fx' }),
    overlay: createSpriteBatch({ atlas, capacity: 96, depth: 24, renderOrder: 8, additive: true, name: 'overlay' }),
  };
  layers.actors.add(batches.actors.mesh);
  layers.fx.add(batches.fx.mesh);
  layers.overlay.add(batches.overlay.mesh);

  /* ------------------------------------------------------------ post chain */

  const target = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });

  const blit = new THREE.MeshBasicMaterial({
    map: target.texture,
    depthTest: false,
    depthWrite: false,
  });
  const compositeScene = new THREE.Scene();
  compositeScene.name = 'composite';
  const compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const compositeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blit);
  compositeQuad.frustumCulled = false;
  compositeScene.add(compositeQuad);

  /** Live uniforms shared with the CRT pass (it may add its own on top). */
  const uniforms = {
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTint: { value: new THREE.Color(stageRecord.tint ?? DEFAULT_STAGE.tint) },
  };

  let crtPass = null;
  let time = 0;
  let frames = 0;
  let progress = 0;
  const viewport = { x: 0, y: 0, width: VIEW.width, height: VIEW.height, bufferWidth: VIEW.width, bufferHeight: VIEW.height };

  /**
   * Install the CRT post pass. The factory receives the renderer, the current
   * target size and the shared uniform block; it must return an object carrying
   * a `THREE.ShaderMaterial` (plus optional `resize(w, h)`, `update(dt, u)` and
   * `dispose()`). Anything else — a missing pass, a shader that refuses to
   * compile — leaves the plain blit in place: post-processing is polish, and it
   * must never be able to take the playfield down.
   */
  function attachCRT(factory) {
    if (typeof factory !== 'function') return null;
    let pass = null;
    try {
      pass = factory({
        renderer,
        width: target.width,
        height: target.height,
        tint: stageRecord.tint ?? DEFAULT_STAGE.tint,
        uniforms,
      });
    } catch (err) {
      return null;
    }
    if (!pass || !pass.material) return null;
    crtPass = pass;
    if (typeof pass.resize === 'function') pass.resize(target.width, target.height);
    compositeQuad.material = pass.material;
    return pass;
  }

  /* --------------------------------------------------------------- layout */

  /** Fit the fixed 4:3 field inside the canvas and resize every buffer. */
  function resize(width, height) {
    const cssWidth = Math.max(1, Math.round(width ?? canvas.clientWidth ?? VIEW.width));
    const cssHeight = Math.max(1, Math.round(height ?? canvas.clientHeight ?? VIEW.height));
    renderer.setSize(cssWidth, cssHeight, false);

    const dpr = renderer.getPixelRatio();
    const bufferWidth = Math.max(1, Math.round(cssWidth * dpr));
    const bufferHeight = Math.max(1, Math.round(cssHeight * dpr));
    const wide = bufferWidth / bufferHeight > VIEW_ASPECT;
    const fitWidth = wide ? Math.round(bufferHeight * VIEW_ASPECT) : bufferWidth;
    const fitHeight = wide ? bufferHeight : Math.round(bufferWidth / VIEW_ASPECT);

    viewport.x = Math.round((bufferWidth - fitWidth) / 2);
    viewport.y = Math.round((bufferHeight - fitHeight) / 2);
    viewport.width = fitWidth;
    viewport.height = fitHeight;
    viewport.bufferWidth = bufferWidth;
    viewport.bufferHeight = bufferHeight;

    const scale = Math.min(Math.max(opts.resolutionScale ?? 1, 0.25), 2);
    const targetWidth = Math.max(1, Math.round(fitWidth * scale));
    const targetHeight = Math.max(1, Math.round(fitHeight * scale));
    target.setSize(targetWidth, targetHeight);
    uniforms.uResolution.value.set(targetWidth, targetHeight);
    background.setPixelScale(dpr);
    if (crtPass && typeof crtPass.resize === 'function') crtPass.resize(targetWidth, targetHeight);
    return { ...viewport };
  }

  resize();

  if (opts.crt !== null && opts.crt !== undefined) attachCRT(opts.crt);
  else if (opts.crt === undefined && typeof createCRT === 'function') attachCRT(createCRT);

  /* ---------------------------------------------------------------- stage */

  function setStage(stage) {
    const record = typeof stage === 'string' ? stageByName(stage) : typeof stage === 'number' ? stageFor(stage) : stage ?? stageRecord;
    background.setStage(record);
    setTint(record?.tint);
    return record;
  }

  function setTint(color) {
    const hex = color ?? DEFAULT_STAGE.tint;
    uniforms.uTint.value.set(hex);
    background.setTint(hex);
    return hex;
  }

  function stageByName(name) {
    const key = String(name).trim().toUpperCase();
    return (
      STAGE_TABLE.find((s) => s.name === key) ??
      STAGE_TABLE.find((s) => String(s.stage) === key) ??
      STAGE_TABLE.find((s) => String(s.backdrop).toUpperCase() === key) ??
      DEFAULT_STAGE
    );
  }

  /* ----------------------------------------------------------------- draw */

  /** Render one frame: scenery, every batch, then the CRT composite. */
  function draw(dt = 0) {
    const delta = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    time += delta;
    background.update(delta, progress);
    uniforms.uTime.value = time;
    for (const key in batches) batches[key].end();
    if (crtPass && typeof crtPass.update === 'function') crtPass.update(delta, uniforms);

    renderer.setScissorTest(false);
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, target.width, target.height);
    renderer.render(scene, camera);

    renderer.setRenderTarget(null);
    renderer.setScissorTest(true);
    renderer.setScissor(viewport.x, viewport.y, viewport.width, viewport.height);
    renderer.setViewport(viewport.x, viewport.y, viewport.width, viewport.height);
    renderer.render(compositeScene, compositeCamera);
    renderer.setScissorTest(false);

    frames++;
    return time;
  }

  const onResize = () => resize();
  const autoResize = opts.autoResize ?? true;
  if (autoResize && typeof globalThis.addEventListener === 'function') globalThis.addEventListener('resize', onResize);

  function destroy() {
    if (autoResize && typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('resize', onResize);
    for (const key in batches) batches[key].dispose();
    background.dispose();
    if (crtPass && typeof crtPass.dispose === 'function') crtPass.dispose();
    compositeQuad.geometry.dispose();
    blit.dispose();
    target.dispose();
    if (renderer.renderLists && typeof renderer.renderLists.dispose === 'function') renderer.renderLists.dispose();
    renderer.dispose();
  }

  return {
    canvas,
    renderer,
    scene,
    camera,
    layers,
    batches,
    atlas,
    background,
    uniforms,
    viewport,

    get width() {
      return VIEW.width;
    },
    get height() {
      return VIEW.height;
    },
    get time() {
      return time;
    },
    get frames() {
      return frames;
    },
    get progress() {
      return progress;
    },
    get crt() {
      return crtPass;
    },
    get stage() {
      return background.stage;
    },

    /** Stage progress 0..1: accelerates the parallax and drives the scenery. */
    setProgress(value) {
      progress = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 1);
      return progress;
    },
    setStage,
    setTint,
    attachCRT,
    resize,
    draw,
    destroy,
  };
}

export default createScene;
