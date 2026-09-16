/**
 * parallax.mjs — far / mid / near scenery parallax for the playfield.
 *
 * The playfield scrolls downward to sell the ship's forward motion, so every
 * layer here is a band of scenery tiles that drifts up the screen and wraps.
 * Three layers run at clearly distinct speeds (far → mid → near), the whole
 * stack is scattered on a jittered grid so it never reads as a texture repeat,
 * and a single darkening overlay plane is interleaved between the scenery and
 * the gameplay sprites so the world stays low-contrast and the danmaku pops.
 *
 * Scenery comes from `assets/scenery` tiles. This project ships zero binary
 * assets (see docs/SPEC.md), so the tile catalogue is *painted* procedurally
 * into small `THREE.CanvasTexture`s at boot — one silhouette per tile kind —
 * and tinted through the material. The catalogue is keyed by the five stage
 * themes: city / industrial / desert / ocean / space. Each theme also owns a
 * dark, low-contrast palette (deep body, subtle rim, near-black overlay), so a
 * stage change re-skins the whole background without touching the sim.
 *
 * The module is part of the render layer. `createParallax` needs a `THREE`
 * namespace; rather than hard-importing three (which would make this module
 * un-importable under plain Node, where the importmap does not exist) the
 * namespace is injected by the caller that already owns it. `background.mjs`
 * passes the namespace it imports, and `setParallaxThree` exists for any other
 * caller; absent both, a `globalThis.THREE` fallback is honoured.
 *
 *   const scenery = createParallax(group, 'city', { THREE, seed: 7 });
 *   scenery.update(dt, stageProgress);   // progress 0..1 accelerates the scroll
 */

import { createRng } from '../core/rng.mjs';
import { FIELD, STAGE_TABLE, DEFAULT_STAGE, stageFor } from '../game/config.mjs';

const W = FIELD.width;
const H = FIELD.height;
/** Props loop this far outside the playfield so nothing pops in at the edges. */
const OVERSCAN = 140;
/** Vertical loop distance for a wrapped tile. */
const SPAN = H + OVERSCAN * 2;
/** Design grid of a single scenery tile, in canvas pixels. */
const TILE_CELL = 128;

/* ------------------------------------------------------------------- themes */

/** Every stage theme the scenery catalogue ships with. */
export const THEMES = Object.freeze(['city', 'industrial', 'desert', 'ocean', 'space']);

/**
 * Dark, low-contrast palettes. `fill` is the tile body, `edge` its rim, `glow`
 * a faint accent, and `overlay` the near-black wash laid over the scenery.
 * Nothing here is brighter than a mid-dark tone: the gameplay layer owns the
 * highlights.
 */
export const THEME_PALETTES = Object.freeze({
  city: Object.freeze({
    sky: '#05070d',
    haze: '#0a0e18',
    fill: '#141c2c',
    edge: '#1f2b41',
    glow: '#283c58',
    overlay: '#03060c',
    overlayOpacity: 0.5,
  }),
  industrial: Object.freeze({
    sky: '#0b0805',
    haze: '#141008',
    fill: '#241c10',
    edge: '#382c18',
    glow: '#4a3a1c',
    overlay: '#070502',
    overlayOpacity: 0.5,
  }),
  desert: Object.freeze({
    sky: '#0d0a06',
    haze: '#171208',
    fill: '#2a2214',
    edge: '#3e3320',
    glow: '#5a4828',
    overlay: '#0a0703',
    overlayOpacity: 0.48,
  }),
  ocean: Object.freeze({
    sky: '#04090f',
    haze: '#08131d',
    fill: '#10222e',
    edge: '#1a3444',
    glow: '#204a5e',
    overlay: '#020609',
    overlayOpacity: 0.52,
  }),
  space: Object.freeze({
    sky: '#03050a',
    haze: '#070b15',
    fill: '#0e1420',
    edge: '#161f30',
    glow: '#1e2a3f',
    overlay: '#010206',
    overlayOpacity: 0.45,
  }),
});

/** Stage number → theme, indexed from stage 1. */
export const THEME_BY_STAGE = Object.freeze(['space', 'industrial', 'ocean', 'city', 'desert']);
/** Legacy `STAGE_TABLE[].backdrop` → theme, so old call sites keep working. */
export const THEME_BY_BACKDROP = Object.freeze({ shelf: 'space', trench: 'industrial', garden: 'ocean' });

/** Normalise a theme name, stage number, stage record or backdrop to a theme id. */
export function themeForStage(stage) {
  if (stage === undefined || stage === null) return themeForStage(DEFAULT_STAGE);
  if (typeof stage === 'string') {
    const key = stage.trim().toLowerCase();
    if (THEMES.includes(key)) return key;
    const upper = key.toUpperCase();
    const record = STAGE_TABLE.find(
      (s) => s.name === upper || String(s.stage) === upper || String(s.backdrop).toUpperCase() === upper,
    );
    return themeForStage(record ?? DEFAULT_STAGE);
  }
  if (typeof stage === 'number') return themeForStage(stageFor(stage));
  if (stage.backdrop && THEME_BY_BACKDROP[stage.backdrop]) return THEME_BY_BACKDROP[stage.backdrop];
  const i = Math.max(1, Math.min(THEME_BY_STAGE.length, Math.floor(stage.stage) || 1));
  return THEME_BY_STAGE[i - 1];
}

/* -------------------------------------------------------------------- tiles */

/**
 * Tile silhouettes shared by every theme. Each theme orders/weights the kinds
 * it wants; the painter is neutral so the palette does the colouring.
 */
function tile(kind, weight, aspect, height) {
  return Object.freeze({ kind, weight, aspect, height });
}

/** The `assets/scenery` tile catalogue, keyed by theme. */
export const SCENERY_TILES = Object.freeze({
  city: Object.freeze([tile('tower', 1, 0.7, 1.15), tile('slab', 1.1, 1.3, 0.6), tile('stud', 0.7, 1.5, 0.35), tile('arch', 0.5, 1.0, 0.9)]),
  industrial: Object.freeze([tile('slab', 1.2, 1.4, 0.7), tile('tower', 1, 0.6, 1.3), tile('stud', 0.8, 1.6, 0.3), tile('arch', 0.4, 1.1, 0.8)]),
  desert: Object.freeze([tile('slab', 1, 1.6, 0.5), tile('arch', 1, 1.2, 0.7), tile('stud', 0.6, 1.8, 0.3), tile('tower', 0.5, 0.5, 1.0)]),
  ocean: Object.freeze([tile('arch', 1.1, 1.3, 0.9), tile('slab', 1, 1.5, 0.5), tile('stud', 0.7, 1.7, 0.35), tile('tower', 0.6, 0.5, 1.1)]),
  space: Object.freeze([tile('slab', 1.2, 1.5, 0.6), tile('tower', 0.9, 0.6, 1.1), tile('stud', 0.9, 1.6, 0.3), tile('arch', 0.5, 1.0, 0.8)]),
});

/**
 * Layer specs, far → mid → near. `speed` is playfield pixels per simulated
 * frame at 60 Hz (scaled by stage flow), `z` sorts the plane behind the
 * playfield (z = 0), and `cols`/`rows` size the jittered scatter grid.
 */
export const PARALLAX_LAYERS = Object.freeze([
  Object.freeze({ id: 'far', speed: 7, cols: 3, rows: 4, scale: 1.5, opacity: 0.4, z: -560, jitter: 0.7, shade: 0.72 }),
  Object.freeze({ id: 'mid', speed: 16, cols: 4, rows: 5, scale: 1.0, opacity: 0.58, z: -400, jitter: 0.8, shade: 0.88 }),
  Object.freeze({ id: 'near', speed: 30, cols: 5, rows: 6, scale: 0.72, opacity: 0.78, z: -250, jitter: 0.9, shade: 1 }),
]);

/** Z / draw order of the darkening wash: above scenery, below the sprites. */
const OVERLAY_Z = -160;
/** Layer order of the legacy procedural backdrop: behind every parallax tile. */
export const BACKDROP_ORDER = -800;

/* ------------------------------------------------------------------ helpers */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** FNV-1a: stable string → 32-bit seed so each theme scatters identically. */
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Wrap a tile back to the far edge once it leaves the playfield. */
function wrapY(y) {
  if (y < -OVERSCAN) return y + SPAN;
  if (y > H + OVERSCAN) return y - SPAN;
  return y;
}

/** Weighted pick from a theme's tile catalogue. */
function pickTile(catalog, rng) {
  let total = 0;
  for (const t of catalog) total += t.weight;
  let roll = rng.float(0, total);
  for (const t of catalog) {
    roll -= t.weight;
    if (roll <= 0) return t;
  }
  return catalog[catalog.length - 1];
}

/**
 * Paint one neutral (white-on-transparent) tile silhouette. Neutrality lets a
 * single texture be tinted by any theme palette / layer shade through the
 * material colour, so one atlas of shapes serves every stage.
 */
function paintTile(g, kind, size, rng) {
  const s = size;
  g.clearRect(0, 0, s, s);
  g.lineJoin = 'round';
  const body = 'rgba(255,255,255,0.82)';
  const rim = 'rgba(255,255,255,0.55)';
  const accent = 'rgba(255,255,255,0.95)';

  switch (kind) {
    case 'tower': {
      const w = s * rng.float(0.22, 0.3);
      const x = (s - w) / 2;
      const top = s * rng.float(0.12, 0.2);
      g.fillStyle = body;
      g.fillRect(x, top, w, s - top);
      g.fillStyle = rim;
      g.fillRect(x, top, w, s * 0.05);
      g.strokeStyle = accent;
      g.lineWidth = Math.max(1, s * 0.02);
      g.beginPath();
      g.moveTo(s / 2, top);
      g.lineTo(s / 2, top - s * 0.1);
      g.stroke();
      g.fillStyle = accent;
      for (let i = 0; i < 4; i++) {
        g.globalAlpha = 0.3 + 0.14 * ((i + rng.int(0, 1)) % 3);
        g.fillRect(x + w * 0.25, top + s * (0.18 + 0.16 * i), w * 0.5, s * 0.05);
      }
      g.globalAlpha = 1;
      break;
    }
    case 'arch': {
      const cx = s / 2;
      const baseY = s * 0.86;
      const r = s * 0.34;
      g.fillStyle = body;
      g.beginPath();
      g.moveTo(cx - r, baseY);
      g.lineTo(cx - r, s * 0.42);
      g.arc(cx, s * 0.42, r, Math.PI, 0, false);
      g.lineTo(cx + r, baseY);
      g.closePath();
      g.fill();
      g.save();
      g.globalCompositeOperation = 'destination-out';
      g.beginPath();
      g.moveTo(cx - r * 0.55, baseY);
      g.lineTo(cx - r * 0.55, s * 0.46);
      g.arc(cx, s * 0.46, r * 0.55, Math.PI, 0, false);
      g.lineTo(cx + r * 0.55, baseY);
      g.closePath();
      g.fill();
      g.restore();
      g.fillStyle = rim;
      g.fillRect(cx - r, s * 0.42, r * 2, s * 0.03);
      break;
    }
    case 'stud': {
      g.fillStyle = body;
      const n = 3;
      const bw = s * 0.16;
      const gap = (s - n * bw) / (n + 1);
      for (let i = 0; i < n; i++) {
        const x = gap + i * (bw + gap);
        const h = s * rng.float(0.2, 0.38);
        g.fillRect(x, s - s * 0.18 - h, bw, h);
      }
      g.fillStyle = accent;
      g.fillRect(0, s * 0.86, s, s * 0.05);
      break;
    }
    case 'slab':
    default: {
      const top = s * rng.float(0.34, 0.44);
      g.fillStyle = body;
      g.fillRect(0, top, s, s - top);
      g.fillStyle = rim;
      g.fillRect(0, top, s, s * 0.05);
      g.globalAlpha = 0.5;
      g.fillStyle = accent;
      g.fillRect(s * 0.12, top + s * 0.12, s * 0.3, s * 0.06);
      g.globalAlpha = 1;
      break;
    }
  }
}

/** Build one tile texture, or `null` when the DOM/three cannot supply a canvas. */
function createTileTexture(three, doc, kind, seed) {
  if (!doc || typeof doc.createElement !== 'function' || typeof three.CanvasTexture !== 'function') return null;
  const canvas = doc.createElement('canvas');
  canvas.width = TILE_CELL;
  canvas.height = TILE_CELL;
  const g = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!g) return null;
  paintTile(g, kind, TILE_CELL, createRng(seed ^ hashString(kind)));
  const texture = new three.CanvasTexture(canvas);
  texture.magFilter = three.LinearFilter;
  texture.minFilter = three.LinearMipMapLinearFilter ?? three.LinearFilter;
  texture.generateMipmaps = true;
  if (three.SRGBColorSpace !== undefined) texture.colorSpace = three.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/* --------------------------------------------------------------- injection */

let injectedThree = null;

/** Hand the module a `THREE` namespace when a call site cannot pass one. */
export function setParallaxThree(three) {
  injectedThree = three ?? null;
  return injectedThree;
}

/** Resolve the namespace from call site → injection → a browser global. */
function resolveThree(opts) {
  return (
    opts.THREE ||
    injectedThree ||
    (typeof globalThis !== 'undefined' && globalThis.THREE ? globalThis.THREE : null)
  );
}

/* -------------------------------------------------------------------- build */

function disposeTree(root) {
  root.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    const material = node.material;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else if (material) material.dispose();
  });
  root.clear();
}

/**
 * Build the far / mid / near scenery stack + darkening overlay.
 *
 * @param {object} scene a `THREE.Scene` or `THREE.Group` to add the scenery to
 * @param {string|number|object} theme a theme id, stage number, stage record or backdrop
 * @param {{ THREE?: object, doc?: Document, seed?: number }} [opts]
 * @returns {object} scenery handle (`group`, `overlay`, `layers`, `theme`, `update`, `setTheme`, `reset`, `dispose`)
 */
export function createParallax(scene, theme, opts = {}) {
  const three = resolveThree(opts);
  if (!three || typeof three.Group !== 'function') {
    throw new Error('createParallax: a THREE namespace is required (pass { THREE })');
  }
  if (!scene || typeof scene.add !== 'function') {
    throw new Error('createParallax: a target scene/group with .add() is required');
  }

  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  const seed = Number.isFinite(opts.seed) ? opts.seed : DEFAULT_STAGE.stage;

  const group = new three.Group();
  group.name = 'parallax';
  group.renderOrder = -1000;

  const state = {
    time: 0,
    progress: 0,
    flow: 1,
    theme: null,
    palette: THEME_PALETTES.space,
    layers: [],
    overlay: null,
    textures: new Map(),
  };

  /** Tile textures are shared by every plane using that kind. */
  function textureFor(kind) {
    if (state.textures.has(kind)) return state.textures.get(kind);
    const texture = createTileTexture(three, doc, kind, (seed >>> 0) ^ hashString(state.theme));
    state.textures.set(kind, texture);
    return texture;
  }

  /** One jittered grid of tiles for a layer spec. */
  function buildLayer(spec, index, palette) {
    const catalog = SCENERY_TILES[state.theme] ?? SCENERY_TILES.space;
    const rng = createRng((seed >>> 0) ^ (0x9e37 * (index + 1)) ^ hashString(state.theme));
    const layerGroup = new three.Group();
    layerGroup.name = `parallax:${spec.id}`;

    const cellW = (W + OVERSCAN * 2) / spec.cols;
    const cellH = SPAN / spec.rows;
    const entries = [];

    for (let row = 0; row < spec.rows; row++) {
      for (let col = 0; col < spec.cols; col++) {
        const def = pickTile(catalog, rng);
        const texture = textureFor(def.kind);
        const baseH = TILE_CELL * spec.scale * def.height;
        const baseW = baseH * def.aspect;
        const w = baseW * rng.float(0.8, 1.2);
        const h = baseH * rng.float(0.85, 1.15);
        const cx = -OVERSCAN + cellW * (col + 0.5) + rng.float(-1, 1) * cellW * spec.jitter * 0.35;
        const cy = -OVERSCAN + cellH * (row + 0.5) + rng.float(-1, 1) * cellH * spec.jitter * 0.35;

        const material = new three.MeshBasicMaterial({
          map: texture,
          color: new three.Color(palette.fill).multiplyScalar(spec.shade),
          transparent: true,
          opacity: spec.opacity,
          depthTest: false,
          depthWrite: false,
          side: three.DoubleSide,
        });

        const mesh = new three.Mesh(new three.PlaneGeometry(w, h), material);
        mesh.name = `parallax:${spec.id}:${def.kind}`;
        mesh.position.set(cx, cy, spec.z);
        mesh.renderOrder = spec.z;
        mesh.frustumCulled = false;
        layerGroup.add(mesh);

        entries.push({
          mesh,
          baseX: cx,
          speed: spec.speed * rng.float(0.85, 1.2),
          drift: rng.float(0, 8) * spec.scale,
          phase: rng.angle(),
        });
      }
    }

    group.add(layerGroup);
    return { id: spec.id, spec, group: layerGroup, entries };
  }

  function buildOverlay(palette) {
    const material = new three.MeshBasicMaterial({
      color: palette.overlay,
      transparent: true,
      opacity: palette.overlayOpacity,
      depthTest: false,
      depthWrite: false,
    });
    const overlay = new three.Mesh(new three.PlaneGeometry(W, H), material);
    overlay.name = 'parallax:overlay';
    overlay.position.set(W / 2, H / 2, OVERLAY_Z);
    overlay.renderOrder = OVERLAY_Z;
    overlay.frustumCulled = false;
    group.add(overlay);
    return overlay;
  }

  function clearScenery() {
    for (const layer of state.layers) disposeTree(layer.group);
    if (state.overlay) {
      if (state.overlay.geometry) state.overlay.geometry.dispose();
      if (state.overlay.material) state.overlay.material.dispose();
      group.remove(state.overlay);
    }
    for (const texture of state.textures.values()) if (texture) texture.dispose();
    state.textures.clear();
    state.layers = [];
    state.overlay = null;
    group.clear();
  }

  function rebuild(themeId) {
    clearScenery();
    state.theme = themeId;
    state.palette = THEME_PALETTES[themeId] ?? THEME_PALETTES.space;
    state.layers = PARALLAX_LAYERS.map((spec, i) => buildLayer(spec, i, state.palette));
    state.overlay = buildOverlay(state.palette);
    return state.theme;
  }

  rebuild(themeForStage(theme));
  scene.add(group);

  return {
    /** Scenery root; add it to the playfield behind the sprite batches. */
    group,
    /** The darkening plane interleaved between scenery and gameplay sprites. */
    get overlay() {
      return state.overlay;
    },
    get layers() {
      return state.layers;
    },
    get theme() {
      return state.theme;
    },
    get palette() {
      return state.palette;
    },
    get tileCount() {
      return state.layers.reduce((n, layer) => n + layer.entries.length, 0);
    },

    /** Re-skin the scenery for a new theme (no-op when it is already active). */
    setTheme(next) {
      const themeId = themeForStage(next);
      if (themeId === state.theme) return state.theme;
      return rebuild(themeId);
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
      for (const layer of state.layers) {
        for (const e of layer.entries) {
          e.mesh.position.y = wrapY(e.mesh.position.y + e.speed * dy);
          if (e.drift) e.mesh.position.x = e.baseX + Math.sin(state.time * 0.8 + e.phase) * e.drift;
        }
      }
    },

    /** Rewind the scroll for a fresh stage attempt. */
    reset() {
      state.time = 0;
      state.progress = 0;
      state.flow = 1;
      for (const layer of state.layers) {
        for (const e of layer.entries) e.mesh.position.x = e.baseX;
      }
    },

    dispose() {
      clearScenery();
      if (scene && typeof scene.remove === 'function') scene.remove(group);
    },
  };
}

export default createParallax;
