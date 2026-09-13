/**
 * background.mjs — procedural parallax starfield + per-stage backdrop.
 *
 * The playfield always scrolls downward to sell the ship's forward motion:
 *
 *   • four star layers (dust → warp streaks) pulled from a seeded PRNG, so a
 *     given stage always looks identical;
 *   • a stage backdrop chosen by `STAGE_TABLE[].backdrop` (`shelf` / `trench` /
 *     `garden`) built from untextured three primitives and shaded from the stage
 *     tint, scrolls at its own rate behind the dust.
 *
 * Everything is generated at runtime from `THREE.Points`, `THREE.LineSegments`
 * and flat meshes: no image files, no fetches, no binary assets. The module is
 * part of the render layer, so it may freely use three; it never touches the
 * simulation.
 *
 * Coordinates are playfield pixels with the origin at the *top-left*, matching
 * the orthographic design space of `src/render/three-scene.mjs` (`FIELD` in
 * `src/game/config.mjs`, 1024 x 768), so the same numbers the simulation uses
 * can be used to place scenery.
 *
 *   const bg = createBackground({ stage: 1 });
 *   scene.add(bg.group);
 *   bg.update(dt, stageProgress);   // progress 0..1 accelerates the scroll
 */

import * as THREE from 'three';
import { createRng } from '../core/rng.mjs';
import { STAGE_TABLE, FIELD, DEFAULT_STAGE, stageFor } from '../game/config.mjs';

const W = FIELD.width;
const H = FIELD.height;
/** Props loop this far outside the playfield so nothing pops in at the edges. */
const OVERSCAN = 80;
/** Vertical loop distance for a wrapped prop. */
const SPAN = H + OVERSCAN * 2;

/**
 * Star layer specs, far → near. `speed` is playfield pixels per simulated frame
 * at 60 Hz, `z` places the layer behind the playfield plane (z = 0).
 */
export const STAR_LAYERS = Object.freeze([
  { id: 'far', kind: 'dust', count: 180, speed: 4.5, size: 1.3, color: '#1f8f3a', opacity: 0.5, z: -470 },
  { id: 'mid', kind: 'dust', count: 120, speed: 12, size: 1.9, color: '#7dff8a', opacity: 0.7, z: -330 },
  { id: 'near', kind: 'dust', count: 70, speed: 25, size: 2.7, color: '#d8ffe0', opacity: 0.9, z: -210 },
  { id: 'warp', kind: 'streak', count: 30, speed: 60, length: 11, color: '#ffc061', opacity: 0.65, z: -150 },
]);

/** Backdrop styles addressable through `STAGE_TABLE[].backdrop`. */
export const BACKDROP_STYLES = Object.freeze(['shelf', 'trench', 'garden']);

/* ------------------------------------------------------------------ helpers */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Wrap a prop back to the far edge once it leaves the playfield. */
function wrapY(y) {
  if (y < -OVERSCAN) return y + SPAN;
  if (y > H + OVERSCAN) return y - SPAN;
  return y;
}

/** Flat silhouette material: the scenery blocks light instead of emitting it. */
function slabMaterial(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
  });
}

/** Emissive trim material for rims, glints and lights. */
function glowMaterial(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Tint-derived colour helper: `k` < 1 darkens, > 1 pushes into the highlights. */
function shade(tint, k) {
  return new THREE.Color(tint ?? DEFAULT_STAGE.tint).multiplyScalar(k);
}

function makeProp(object, speed, extra = {}) {
  object.frustumCulled = false;
  return {
    object,
    speed,
    span: SPAN,
    baseX: object.position.x,
    drift: extra.drift ?? 0,
    phase: extra.phase ?? 0,
    spin: extra.spin ?? 0,
  };
}

/** Wrap a texture-free mesh so it can be dropped into the backdrop group. */
function mesh(geometry, material, x, y, z) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.frustumCulled = false;
  return m;
}

/** Blit dimension of a circle/ring: `segments` keeps the silhouette soft. */
const ROUND_SEGMENTS = 24;

/* ---------------------------------------------------------------- star layer */

function createStarLayer(spec, rng) {
  const count = spec.count;
  const streak = spec.kind === 'streak';
  const verts = streak ? count * 2 : count;
  const positions = new Float32Array(verts * 3);
  const colors = new Float32Array(verts * 3);
  const lanes = new Float32Array(count);
  const base = new THREE.Color(spec.color);
  const half = (spec.length ?? 0) * 0.5;

  for (let i = 0; i < count; i++) {
    const x = rng.float(-6, W + 6);
    const y = rng.float(-OVERSCAN, H + OVERSCAN);
    const b = rng.float(0.5, 1);
    lanes[i] = y;
    if (streak) {
      const k = i * 6;
      positions[k] = x;
      positions[k + 1] = y - half;
      positions[k + 3] = x;
      positions[k + 4] = y + half;
      for (let v = 0; v < 2; v++) {
        colors[k + v * 3] = base.r * b;
        colors[k + v * 3 + 1] = base.g * b;
        colors[k + v * 3 + 2] = base.b * b;
      }
    } else {
      const k = i * 3;
      positions[k] = x;
      positions[k + 1] = y;
      colors[k] = base.r * b;
      colors[k + 1] = base.g * b;
      colors[k + 2] = base.b * b;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = streak
    ? new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: spec.opacity,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    : new THREE.PointsMaterial({
        size: spec.size,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: spec.opacity,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

  const object = streak ? new THREE.LineSegments(geometry, material) : new THREE.Points(geometry, material);
  object.name = `stars:${spec.id}`;
  object.position.z = spec.z;
  object.frustumCulled = false;
  object.renderOrder = spec.z;

  return {
    id: spec.id,
    spec,
    object,
    geometry,
    material,
    count,
    streak,
    lanes,
    positions,
    length: spec.length ?? 0,
    /** Point sizes are framebuffer pixels: keep them stable across DPR changes. */
    setPixelScale(scale) {
      if (!streak) material.size = spec.size * scale;
    },
    step(dy) {
      const drift = dy * spec.speed;
      for (let i = 0; i < count; i++) {
        const y = wrapY(lanes[i] + drift);
        lanes[i] = y;
        if (streak) {
          const k = i * 6;
          positions[k + 1] = y - half;
          positions[k + 4] = y + half;
        } else {
          positions[i * 3 + 1] = y;
        }
      }
      geometry.attributes.position.needsUpdate = true;
    },
    /** Subtle phosphor flicker keeps the dust from looking like a still image. */
    twinkle(time) {
      material.opacity = spec.opacity * (0.9 + 0.1 * Math.sin(time * 1.7 + spec.count));
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/* ------------------------------------------------------------ backdrop styles */

/**
 * ORBITAL SHELF — freight slabs and support pylons hanging in the dark, lit by a
 * thin glint along each leading edge.
 */
function buildShelf(rng, tint) {
  const props = [];
  const body = shade(tint, 0.16);
  const pylon = shade(tint, 0.1);
  const glint = shade(tint, 1.45);
  const rail = shade(tint, 0.4);

  for (let i = 0; i < 12; i++) {
    const w = rng.float(160, 520);
    const h = rng.float(22, 64);
    const g = new THREE.Group();
    g.add(mesh(new THREE.PlaneGeometry(w, h), slabMaterial(body, rng.float(0.3, 0.55)), 0, h / 2, 0));
    g.add(mesh(new THREE.PlaneGeometry(w, 3), glowMaterial(glint, rng.float(0.22, 0.45)), 0, 0, 0.5));
    g.position.set(rng.float(-40, W + 40), rng.float(-OVERSCAN, H + OVERSCAN), rng.float(-450, -390));
    props.push(makeProp(g, rng.float(0.9, 1.7)));
  }

  for (let i = 0; i < 9; i++) {
    const w = rng.float(38, 120);
    const h = rng.float(240, 540);
    const g = mesh(
      new THREE.PlaneGeometry(w, h),
      slabMaterial(pylon, rng.float(0.22, 0.4)),
      rng.float(0, W),
      rng.float(-OVERSCAN, H + OVERSCAN),
      rng.float(-380, -330),
    );
    props.push(makeProp(g, rng.float(1.1, 1.8)));
  }

  for (let i = 0; i < 10; i++) {
    const g = mesh(
      new THREE.PlaneGeometry(2, rng.float(40, 130)),
      glowMaterial(rail, rng.float(0.2, 0.4)),
      rng.float(0, W),
      rng.float(-OVERSCAN, H + OVERSCAN),
      rng.float(-320, -280),
    );
    props.push(makeProp(g, rng.float(1.6, 2.6)));
  }

  return props;
}

/**
 * EMBER TRENCH — close walls rushing past on both sides of the lane, broken by
 * hot streaks racing through the middle.
 */
function buildTrench(rng, tint) {
  const props = [];
  const wall = shade(tint, 0.14);
  const edge = shade(tint, 1.3);
  const spark = shade(tint, 1.6);

  for (let i = 0; i < 14; i++) {
    const w = rng.float(64, 170);
    const h = rng.float(320, 720);
    const left = rng.float(0, 1) < 0.5;
    const x = left ? rng.float(-30, W * 0.24) : rng.float(W * 0.76, W + 30);
    const g = new THREE.Group();
    g.add(mesh(new THREE.PlaneGeometry(w, h), slabMaterial(wall, rng.float(0.3, 0.5)), 0, 0, 0));
    const inner = left ? w / 2 : -w / 2;
    g.add(mesh(new THREE.PlaneGeometry(4, h), glowMaterial(edge, rng.float(0.25, 0.5)), inner, 0, 0.5));
    g.position.set(x, rng.float(-OVERSCAN, H + OVERSCAN), rng.float(-420, -350));
    props.push(makeProp(g, rng.float(1.8, 3)));
  }

  for (let i = 0; i < 10; i++) {
    const g = new THREE.Group();
    const h = rng.float(18, 46);
    g.add(mesh(new THREE.PlaneGeometry(rng.float(40, 120), h), slabMaterial(wall, rng.float(0.18, 0.32)), 0, 0, 0));
    g.add(mesh(new THREE.PlaneGeometry(rng.float(40, 120), 2), glowMaterial(edge, rng.float(0.15, 0.3)), 0, -h / 2, 0.5));
    g.position.set(rng.float(0, W), rng.float(-OVERSCAN, H + OVERSCAN), rng.float(-300, -260));
    props.push(makeProp(g, rng.float(2.2, 3.2)));
  }

  for (let i = 0; i < 12; i++) {
    const g = mesh(
      new THREE.PlaneGeometry(2, rng.float(60, 180)),
      glowMaterial(spark, rng.float(0.18, 0.36)),
      rng.float(W * 0.24, W * 0.76),
      rng.float(-OVERSCAN, H + OVERSCAN),
      rng.float(-240, -200),
    );
    props.push(makeProp(g, rng.float(3.4, 4.6)));
  }

  return props;
}

/**
 * VOID GARDEN — slow luminous orbs and rings drifting up through the lane, with a
 * couple of dim canopies for depth.
 */
function buildGarden(rng, tint) {
  const props = [];
  const canopy = shade(tint, 0.12);

  for (let i = 0; i < 6; i++) {
    const g = mesh(
      new THREE.PlaneGeometry(rng.float(220, 440), rng.float(280, 560)),
      slabMaterial(canopy, rng.float(0.16, 0.3)),
      rng.float(0, W),
      rng.float(-OVERSCAN, H + OVERSCAN),
      rng.float(-460, -400),
    );
    props.push(makeProp(g, rng.float(0.4, 0.8)));
  }

  for (let i = 0; i < 16; i++) {
    const r = rng.float(12, 46);
    const color = shade(tint, rng.float(0.7, 1.25));
    const g = mesh(
      new THREE.CircleGeometry(r, ROUND_SEGMENTS),
      glowMaterial(color, rng.float(0.14, 0.3)),
      rng.float(0, W),
      rng.float(-OVERSCAN, H + OVERSCAN),
      rng.float(-380, -280),
    );
    props.push(
      makeProp(g, rng.float(0.7, 1.8), {
        drift: rng.float(6, 26),
        phase: rng.angle(),
        spin: rng.sign() * rng.float(0.2, 0.7),
      }),
    );
  }

  for (let i = 0; i < 8; i++) {
    const r = rng.float(24, 74);
    const g = mesh(
      new THREE.RingGeometry(r, r + rng.float(2, 6), ROUND_SEGMENTS * 2),
      glowMaterial(shade(tint, 1.5), rng.float(0.12, 0.26)),
      rng.float(0, W),
      rng.float(-OVERSCAN, H + OVERSCAN),
      rng.float(-260, -200),
    );
    props.push(
      makeProp(g, rng.float(0.5, 1.2), {
        drift: rng.float(4, 16),
        phase: rng.angle(),
        spin: -rng.sign() * rng.float(0.3, 0.9),
      }),
    );
  }

  return props;
}

/** Backdrop catalogue, keyed by `STAGE_TABLE[].backdrop`. */
export const BACKDROP_BUILDERS = Object.freeze({
  shelf: buildShelf,
  trench: buildTrench,
  garden: buildGarden,
});

/* --------------------------------------------------------------- public API */

/** Resolve a stage by 1-based number, record, or `STAGE_TABLE[].name`. */
function resolveStage(input) {
  if (typeof input === 'number') return stageFor(input);
  if (typeof input === 'string') {
    const key = input.trim().toUpperCase();
    return (
      STAGE_TABLE.find((s) => s.name === key || String(s.stage) === key) ??
      STAGE_TABLE.find((s) => String(s.backdrop).toUpperCase() === key) ??
      DEFAULT_STAGE
    );
  }
  return input ?? DEFAULT_STAGE;
}

/**
 * @param {{ seed?: number, stage?: number|string|object, rng?: object, pixelRatio?: number }} [opts]
 */
export function createBackground(opts = {}) {
  const rng = opts.rng ?? createRng(opts.seed ?? DEFAULT_STAGE.stage);
  const group = new THREE.Group();
  group.name = 'background';
  group.renderOrder = -1000;

  const starLayers = STAR_LAYERS.map((spec, i) => createStarLayer(spec, rng.fork(0x51f + i)));
  for (const layer of starLayers) group.add(layer.object);

  const backdropRoot = new THREE.Group();
  backdropRoot.name = 'backdrop';
  group.add(backdropRoot);

  const state = {
    time: 0,
    progress: 0,
    flow: 1,
    pixelScale: 1,
    stage: null,
    style: null,
    tint: DEFAULT_STAGE.tint,
    props: [],
  };

  function disposeObject(object) {
    object.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      const material = node.material;
      if (Array.isArray(material)) for (const m of material) m.dispose();
      else if (material) material.dispose();
    });
  }

  function clearBackdrop() {
    for (const p of state.props) disposeObject(p.object);
    state.props.length = 0;
    backdropRoot.clear();
    backdropRoot.position.y = 0;
  }

  function rebuildBackdrop() {
    clearBackdrop();
    const build = BACKDROP_BUILDERS[state.style] ?? BACKDROP_BUILDERS[DEFAULT_STAGE.backdrop];
    if (!build) return;
    const styleRng = rng.fork(0x7a1e ^ (state.stage?.stage ?? 1));
    for (const prop of build(styleRng, state.tint)) {
      state.props.push(prop);
      backdropRoot.add(prop.object);
    }
  }

  function applyStage(record) {
    state.stage = record ?? DEFAULT_STAGE;
    state.style = state.stage.backdrop ?? DEFAULT_STAGE.backdrop;
    state.tint = state.stage.tint ?? DEFAULT_STAGE.tint;
    rebuildBackdrop();
    return state.stage;
  }

  applyStage(resolveStage(opts.stage ?? DEFAULT_STAGE.stage));

  const initialScale = Number.isFinite(opts.pixelRatio) && opts.pixelRatio > 0 ? opts.pixelRatio : 1;
  if (initialScale !== 1) {
    state.pixelScale = initialScale;
    for (const layer of starLayers) layer.setPixelScale(initialScale);
  }

  return {
    /** Root group; add it to the scene once, behind the playfield layers. */
    group,
    /** Backdrop props live here and are rebuilt whenever the stage changes. */
    backdropRoot,
    starLayers,

    get stage() {
      return state.stage;
    },
    get style() {
      return state.style;
    },
    get tint() {
      return state.tint;
    },
    get time() {
      return state.time;
    },
    get progress() {
      return state.progress;
    },
    /** Live scroll multiplier: 0.55 at stage start, 1.7 at the boss. */
    get flow() {
      return state.flow;
    },
    get propCount() {
      return state.props.length;
    },

    /** Switch stage (number, record or stage name) and rebuild the scenery. */
    setStage(stage) {
      return applyStage(resolveStage(stage));
    },

    /** Re-tint the scenery; the backdrop is rebuilt only when the hue changes. */
    setTint(color) {
      if (color === undefined || color === null) return state.tint;
      const next = typeof color === 'string' ? color : `#${new THREE.Color(color).getHexString()}`;
      if (next !== state.tint) {
        state.tint = next;
        if (state.style) rebuildBackdrop();
      }
      return state.tint;
    },

    /** Keep point sprite sizes stable when the renderer's pixel ratio changes. */
    setPixelScale(scale) {
      const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
      state.pixelScale = s;
      for (const layer of starLayers) layer.setPixelScale(s);
    },

    /**
     * Scroll the scenery.
     * @param {number} dt seconds since the previous frame
     * @param {number} [progress] stage progress 0..1 (defaults to the last value)
     */
    update(dt = 1 / 60, progress = state.progress) {
      const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
      state.progress = clamp01(Number.isFinite(progress) ? progress : state.progress);
      state.time += step;
      state.flow = 0.55 + 1.15 * state.progress;
      const dy = state.flow * step * 60;
      for (const layer of starLayers) {
        layer.step(dy);
        layer.twinkle(state.time);
      }
      for (const prop of state.props) {
        const o = prop.object;
        o.position.y = wrapY(o.position.y + dy * prop.speed);
        if (prop.drift) o.position.x = prop.baseX + Math.sin(state.time * 0.9 + prop.phase) * prop.drift;
        if (prop.spin) o.rotation.z += prop.spin * step;
      }
    },

    /** Rewind the scroll for a fresh stage attempt. */
    reset() {
      state.time = 0;
      state.progress = 0;
      state.flow = 1;
      for (const p of state.props) p.object.position.y = wrapY(p.object.position.y);
    },

    dispose() {
      clearBackdrop();
      for (const layer of starLayers) {
        group.remove(layer.object);
        layer.dispose();
      }
      group.clear();
    },
  };
}

export default createBackground;
