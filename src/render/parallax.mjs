/**
 * parallax.mjs — far / mid / near scenery parallax for the playfield.
 *
 * The playfield scrolls downward to sell the ship's forward motion, so every
 * layer here is a band of *generated scenery art* that drifts up the screen and
 * wraps. Three layers run at clearly distinct speeds and opacities
 * (far → mid → near: 0.95 / 0.8 / 0.6), scattered on a jittered grid so the
 * stack never reads as a texture repeat, and a single darkening overlay plane
 * (~0.3) is interleaved between the scenery and the gameplay sprites so the
 * world stays low-contrast and the danmaku pops.
 *
 * The art itself is the PNG catalogue under `assets/scenery/` — see
 * `./scenery-registry.mjs` for the per-theme file lists (`c_*` city, `i_*`
 * industrial, `d_*` desert, `o_*` ocean, `x_*` space, plus `a_*` atmosphere on
 * the far layer). The textures are the ones `./assets.mjs`'s `loadAssets()`
 * uploaded: `createParallax(scene, theme, { THREE, assets })` binds each file
 * name straight onto a `THREE.MeshBasicMaterial`. When a file is missing (or no
 * asset registry was handed in) a neutral silhouette is painted into a
 * `THREE.CanvasTexture` as a fallback, so a layer never renders empty.
 *
 * The module is part of the render layer. `createParallax` / `buildParallax`
 * take the `THREE` namespace by injection rather than a static `import`, which
 * keeps the module importable under plain Node (the node contract only needs the
 * layer layout, not a GPU). `background.mjs` passes the namespace it imports,
 * `setParallaxThree` exists for any other caller, and a `globalThis.THREE`
 * fallback is honoured. With none of those, a tiny headless shim still builds
 * the full scene graph — same layers, same mesh count — so the layout can be
 * asserted in a bare process.
 *
 *   const scenery = createParallax(group, 'city', { THREE, assets, seed: 7 });
 *   scenery.update(dt, stageProgress);   // progress 0..1 accelerates the scroll
 */

import { createRng } from '../core/rng.mjs';
import { FIELD, STAGE_TABLE, DEFAULT_STAGE, stageFor } from '../game/config.mjs';
import {
  THEME_SCENERY,
  ATMOSPHERE_SCENERY,
  SCENERY_FILES,
  sceneryFilesFor,
  sceneryPath,
} from './scenery-registry.mjs';

export {
  THEME_SCENERY,
  ATMOSPHERE_SCENERY,
  SCENERY_FILES,
  sceneryFilesFor,
  sceneryPath,
} from './scenery-registry.mjs';

const W = FIELD.width;
const H = FIELD.height;
/** Props loop this far outside the playfield so nothing pops in at the edges. */
const OVERSCAN = 150;
/** Vertical loop distance for a wrapped tile. */
const SPAN = H + OVERSCAN * 2;
/** Design grid of a fallback-painted tile, in canvas pixels. */
const TILE_CELL = 128;

/* ------------------------------------------------------------------- themes */

/** Every stage theme the scenery catalogue ships with. */
export const THEMES = Object.freeze(Object.keys(THEME_SCENERY));

/**
 * Dark, low-contrast palettes. `fill` tints the scenery body, `glow` a faint
 * accent, and `overlay` the near-black wash laid over the whole stack. Nothing
 * here is brighter than a mid-dark tone: the gameplay layer owns the highlights.
 */
export const THEME_PALETTES = Object.freeze({
  city: Object.freeze({
    sky: '#05070d',
    haze: '#0a0e18',
    fill: '#141c2c',
    edge: '#1f2b41',
    glow: '#283c58',
    overlay: '#03060c',
    overlayOpacity: 0.15,
  }),
  industrial: Object.freeze({
    sky: '#0b0805',
    haze: '#141008',
    fill: '#241c10',
    edge: '#382c18',
    glow: '#4a3a1c',
    overlay: '#070502',
    overlayOpacity: 0.15,
  }),
  desert: Object.freeze({
    sky: '#0d0a06',
    haze: '#171208',
    fill: '#2a2214',
    edge: '#3e3320',
    glow: '#5a4828',
    overlay: '#0a0703',
    overlayOpacity: 0.15,
  }),
  ocean: Object.freeze({
    sky: '#04090f',
    haze: '#08131d',
    fill: '#10222e',
    edge: '#1a3444',
    glow: '#204a5e',
    overlay: '#020609',
    overlayOpacity: 0.15,
  }),
  space: Object.freeze({
    sky: '#03050a',
    haze: '#070b15',
    fill: '#0e1420',
    edge: '#161f30',
    glow: '#1e2a3f',
    overlay: '#010206',
    overlayOpacity: 0.15,
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

/**
 * Layer specs, far → mid → near. `speed` is playfield pixels per simulated frame
 * at 60 Hz (scaled by stage flow), `z` sorts the plane behind the playfield
 * (z = 0), `opacity` is the per-layer wash described in the header, and
 * `cols`/`rows` size the jittered scatter grid (`scale` grows each tile past its
 * cell so the bands overlap and cover the playfield).
 */
export const PARALLAX_LAYERS = Object.freeze([
  Object.freeze({ id: 'far', speed: 7, cols: 3, rows: 4, scale: 1.35, opacity: 0.95, z: -640, jitter: 0.7, shade: 0.95 }),
  Object.freeze({ id: 'mid', speed: 16, cols: 4, rows: 5, scale: 1.05, opacity: 0.8, z: -460, jitter: 0.8, shade: 0.98 }),
  Object.freeze({ id: 'near', speed: 30, cols: 5, rows: 6, scale: 0.9, opacity: 0.6, z: -280, jitter: 0.9, shade: 1.0 }),
]);

/** Z / draw order of the darkening wash: above scenery, below the sprites. */
const OVERLAY_Z = -170;
/** Layer order of the legacy procedural backdrop: behind every parallax tile. */
export const BACKDROP_ORDER = -800;

/* ------------------------------------------------------------------ helpers */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** FNV-1a: stable string → 32-bit seed so each theme scatters identically. */
function hashString(str) {
  let h = 2166136261;
  const text = String(str ?? '');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
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

/* -------------------------------------------------------------------- paint */

/** Fallback silhouette kind for a scenery file, chosen from its prefix. */
function fallbackKind(file) {
  switch (String(file).slice(0, 2)) {
    case 'c_':
      return 'tower';
    case 'o_':
      return 'arch';
    case 'x_':
      return 'slab';
    case 'd_':
      return 'slab';
    case 'i_':
      return 'slab';
    case 'a_':
      return 'cloud';
    default:
      return 'slab';
  }
}

/**
 * Paint one neutral (white-on-transparent) tile silhouette. Neutrality lets a
 * single texture be tinted by any theme palette / layer shade through the
 * material colour, so the fallback atlas serves every stage.
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
    case 'cloud': {
      g.fillStyle = 'rgba(255,255,255,0.5)';
      for (let i = 0; i < 4; i++) {
        const r = s * rng.float(0.16, 0.3);
        g.beginPath();
        g.arc(s * rng.float(0.2, 0.8), s * rng.float(0.25, 0.7), r, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = 'rgba(255,255,255,0.72)';
      g.beginPath();
      g.ellipse(s / 2, s * 0.6, s * 0.4, s * 0.14, 0, 0, Math.PI * 2);
      g.fill();
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

/** Build one fallback tile texture, or `null` when the DOM/three cannot paint. */
function createFallbackTexture(three, doc, file, seed) {
  if (!doc || typeof doc.createElement !== 'function' || typeof three.CanvasTexture !== 'function') return null;
  const canvas = doc.createElement('canvas');
  canvas.width = TILE_CELL;
  canvas.height = TILE_CELL;
  const g = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!g) return null;
  paintTile(g, fallbackKind(file), TILE_CELL, createRng(seed ^ hashString(file)));
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

/* --------------------------------------------------------- headless shim */

/**
 * Minimal three-compatible namespace used only when no real one was injected
 * (a bare Node import). It supports exactly the graph operations `buildParallax`
 * needs — `Group`, `Mesh`, plane geometry, basic material, colour — so the layer
 * layout (and therefore its mesh count) can be built and asserted without a GPU.
 */
function headlessThree() {
  class Object3D {
    constructor() {
      this.children = [];
      this.userData = {};
      this.name = '';
      this.renderOrder = 0;
      this.frustumCulled = true;
      this.parent = null;
      this.position = vec3();
      this.scale = vec3(1, 1, 1);
      this.rotation = vec3();
    }
    add(child) {
      if (child) {
        child.parent = this;
        this.children.push(child);
      }
      return this;
    }
    remove(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      if (child) child.parent = null;
      return this;
    }
    clear() {
      for (const child of this.children) child.parent = null;
      this.children.length = 0;
      return this;
    }
    traverse(fn) {
      fn(this);
      for (const child of this.children) if (typeof child.traverse === 'function') child.traverse(fn);
    }
  }
  function vec3(x = 0, y = 0, z = 0) {
    return {
      x,
      y,
      z,
      set(nx, ny, nz) {
        this.x = nx;
        this.y = ny;
        this.z = nz;
        return this;
      },
    };
  }
  class Group extends Object3D {}
  class Mesh extends Object3D {
    constructor(geometry, material) {
      super();
      this.isMesh = true;
      this.geometry = geometry ?? {};
      this.material = material ?? {};
    }
  }
  class PlaneGeometry {
    constructor(width = 1, height = 1) {
      this.width = width;
      this.height = height;
    }
    dispose() {}
  }
  class MeshBasicMaterial {
    constructor(params = {}) {
      Object.assign(this, params);
    }
    dispose() {}
  }
  class CanvasTexture {
    constructor(image = null) {
      this.image = image;
    }
    dispose() {}
  }
  class Color {
    constructor(value = 0xffffff) {
      this.value = value;
    }
    multiplyScalar() {
      return this;
    }
    lerp() {
      return this;
    }
  }
  return {
    Group,
    Mesh,
    PlaneGeometry,
    MeshBasicMaterial,
    CanvasTexture,
    Color,
    DoubleSide: 2,
    AdditiveBlending: 2,
    LinearFilter: 1006,
    LinearMipMapLinearFilter: 1008,
    SRGBColorSpace: 'srgb',
  };
}

/* -------------------------------------------------------------------- build */

/** Dispose a node's GPU resources (no-op for the headless shim). */
function disposeNode(node) {
  if (!node) return;
  if (node.geometry && typeof node.geometry.dispose === 'function') node.geometry.dispose();
  const material = node.material;
  if (Array.isArray(material)) {
    for (const m of material) if (m && typeof m.dispose === 'function') m.dispose();
  } else if (material && typeof material.dispose === 'function') {
    material.dispose();
  }
}

/** Tint colour for a layer: the theme body dragged toward white, then shaded. */
function tintFor(three, palette, shade) {
  const body = new three.Color(palette.fill);
  if (typeof body.lerp === 'function') body.lerp(new three.Color(0xffffff), 0.92);
  if (typeof body.multiplyScalar === 'function') body.multiplyScalar(shade);
  return body;
}

/**
 * Populate `group` with the three scrolling layers plus the darkening overlay.
 * Shared by `buildParallax` (fresh group) and `createParallax` (re-theme in
 * place), so both paths produce an identical scene graph.
 *
 * @returns {{ palette: object, layers: object[], overlay: object, textures: Map<string, any>, owned: Set<any> }}
 */
function populate(group, ctx) {
  const { three, assets, doc } = ctx;
  const themeId = ctx.theme;
  const palette = THEME_PALETTES[themeId] ?? THEME_PALETTES.space;
  const seed = ctx.seed >>> 0;
  const textures = new Map();
  const owned = new Set();

  /** Texture for a scenery file: the loaded PNG, else a painted fallback. */
  function textureFor(file) {
    if (textures.has(file)) return textures.get(file);
    let texture = assets[file] ?? assets[`${file}.png`] ?? null;
    if (!texture) {
      texture = createFallbackTexture(three, doc, file, seed ^ hashString(themeId));
      if (texture) owned.add(texture);
    }
    textures.set(file, texture);
    return texture;
  }

  const layers = [];
  PARALLAX_LAYERS.forEach((spec, index) => {
    const files = sceneryFilesFor(themeId, spec.id);
    const catalog = files.length ? files : SCENERY_FILES;
    const rng = createRng(seed ^ (0x9e37 * (index + 1)) ^ hashString(themeId));

    const cellW = (W + OVERSCAN * 2) / spec.cols;
    const cellH = SPAN / spec.rows;
    const entries = [];

    for (let row = 0; row < spec.rows; row++) {
      for (let col = 0; col < spec.cols; col++) {
        const file = rng.pick(catalog) ?? 'c_block_a';
        const texture = textureFor(file);
        const w = cellW * spec.scale * rng.float(0.85, 1.35);
        const h = cellH * spec.scale * rng.float(0.85, 1.4);
        const cx = -OVERSCAN + cellW * (col + 0.5) + rng.float(-1, 1) * cellW * spec.jitter * 0.35;
        const cy = -OVERSCAN + cellH * (row + 0.5) + rng.float(-1, 1) * cellH * spec.jitter * 0.35;

        const material = new three.MeshBasicMaterial({
          map: texture,
          color: tintFor(three, palette, spec.shade),
          transparent: true,
          opacity: spec.opacity,
          depthTest: false,
          depthWrite: false,
          side: three.DoubleSide,
        });

        const mesh = new three.Mesh(new three.PlaneGeometry(1, 1), material);
        mesh.name = `parallax:${spec.id}:${file}`;
        mesh.position.set(cx, cy, spec.z);
        mesh.scale.set(w, h, 1);
        mesh.renderOrder = spec.z;
        mesh.frustumCulled = false;
        mesh.userData.layer = spec.id;
        mesh.userData.file = file;
        group.add(mesh);

        entries.push({
          mesh,
          file,
          baseX: cx,
          speed: spec.speed * rng.float(0.85, 1.2),
          drift: rng.float(0, 8) * spec.scale,
          phase: rng.angle(),
        });
      }
    }

    layers.push({ id: spec.id, spec, files: catalog, entries });
  });

  const overlayMaterial = new three.MeshBasicMaterial({
    color: palette.overlay,
    transparent: true,
    opacity: palette.overlayOpacity,
    depthTest: false,
    depthWrite: false,
  });
  const overlay = new three.Mesh(new three.PlaneGeometry(W, H), overlayMaterial);
  overlay.name = 'parallax:overlay';
  overlay.position.set(W / 2, H / 2, OVERLAY_Z);
  overlay.renderOrder = OVERLAY_Z;
  overlay.frustumCulled = false;
  group.add(overlay);

  return { palette, layers, overlay, textures, owned };
}

/** Stamp the layout onto the group so callers can introspect without closures. */
function stampGroup(group, themeId, built) {
  group.userData.theme = themeId;
  group.userData.palette = built.palette;
  group.userData.layers = built.layers;
  group.userData.overlay = built.overlay;
  group.userData.textures = built.textures;
  group.userData.ownedTextures = built.owned;
  group.userData.meshCount = built.layers.reduce((n, layer) => n + layer.entries.length, 0);
  // Return the descriptor, NOT the group: every accessor and both update loops read
  // `current.layers` / `current.overlay` / `current.palette`. Returning the group made
  // them all undefined, so parallax.update() threw "current.layers is not iterable"
  // on the first frame and the renderer never drew anything at all.
  return { ...built, theme: themeId, group };
}

/**
 * Build the far / mid / near scenery stack + darkening overlay.
 *
 * Returns the scenery root `THREE.Group`; its `children` are every scenery mesh
 * (plus the overlay), so `group.children.length` is the tile count. The same
 * layout is mirrored on `group.userData` (`theme`, `layers`, `overlay`). When no
 * `THREE` namespace is available a headless shim is used and the graph is still
 * fully built, so the layout can be asserted in a bare Node process.
 *
 * @param {{
 *   theme?: string|number|object,
 *   THREE?: object,
 *   assets?: Record<string, any>,
 *   doc?: Document,
 *   seed?: number,
 * }} [opts]
 * @returns {object} the scenery root group
 */
export function buildParallax(opts = {}) {
  const three = resolveThree(opts) ?? headlessThree();
  const themeId = themeForStage(opts.theme ?? opts.themeId ?? opts.stage);
  const group = new three.Group();
  group.name = 'parallax';
  group.renderOrder = -1000;

  const ctx = {
    three,
    theme: themeId,
    seed: Number.isFinite(opts.seed) ? opts.seed : DEFAULT_STAGE.stage,
    assets: opts.assets && typeof opts.assets === 'object' ? opts.assets : {},
    doc: opts.doc || (typeof document !== 'undefined' ? document : null),
  };
  return stampGroup(group, themeId, populate(group, ctx));
}

/**
 * Scene-wiring wrapper around {@link buildParallax}: builds the stack, adds the
 * root group to `scene`, and exposes the per-frame scroll / re-theme / dispose
 * surface `background.mjs` drives.
 *
 * @param {object} scene a `THREE.Scene` or `THREE.Group` to add the scenery to
 * @param {string|number|object} theme a theme id, stage number, stage record or backdrop
 * @param {{ THREE?: object, assets?: Record<string, any>, doc?: Document, seed?: number }} [opts]
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

  const seed = Number.isFinite(opts.seed) ? opts.seed : DEFAULT_STAGE.stage;
  const assets = opts.assets && typeof opts.assets === 'object' ? opts.assets : {};
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);

  const group = new three.Group();
  group.name = 'parallax';
  group.renderOrder = -1000;

  const state = { time: 0, progress: 0, flow: 1 };
  const ctx = { three, theme: themeForStage(theme), seed, assets, doc };
  let current = stampGroup(group, ctx.theme, populate(group, ctx));
  scene.add(group);

  function clearScenery() {
    for (const node of [...group.children]) {
      disposeNode(node);
      group.remove(node);
    }
    for (const texture of current.owned) if (texture && typeof texture.dispose === 'function') texture.dispose();
    current.textures.clear();
    current.owned.clear();
    group.clear();
  }

  function rebuild(themeId) {
    clearScenery();
    ctx.theme = themeId;
    current = stampGroup(group, themeId, populate(group, ctx));
    return themeId;
  }

  return {
    /** Scenery root; add it to the playfield behind the sprite batches. */
    group,
    /** Flat `THREE.Mesh` list of every scenery tile (mirrors `group.children`). */
    get children() {
      return group.children;
    },
    /** The darkening plane interleaved between scenery and gameplay sprites. */
    get overlay() {
      return current.overlay;
    },
    get layers() {
      return current.layers;
    },
    get theme() {
      return current.theme ?? group.userData.theme;
    },
    get palette() {
      return current.palette;
    },
    get tileCount() {
      return current.layers.reduce((n, layer) => n + layer.entries.length, 0);
    },

    /** Re-skin the scenery for a new theme (no-op when it is already active). */
    setTheme(next) {
      const themeId = themeForStage(next);
      if (themeId === group.userData.theme) return themeId;
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
      for (const layer of current.layers) {
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
      for (const layer of current.layers) {
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
