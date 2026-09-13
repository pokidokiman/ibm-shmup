/**
 * sprites.mjs — procedural sprite atlas.
 *
 * Every sprite in the game is painted with Canvas2D vector calls into a single
 * offscreen canvas, which is then uploaded once as a `THREE.CanvasTexture`.
 * There are no image assets, no fetches and no binary blobs: the atlas is
 * deterministic pixel art generated on boot.
 *
 * The module is split in two halves:
 *   • pure layout/painting code (works anywhere, even with a tiny 2D-context stub)
 *   • `createSpriteAtlas()` which also builds the GPU texture when three + a DOM
 *     canvas are available.
 *
 * UV convention: `THREE.CanvasTexture` uploads with `flipY = true`, so texture
 * space v=0 is the *bottom* row of the canvas. `spriteUv()` therefore flips v.
 */

import * as THREE from 'three';

/** Sprites per atlas row. */
export const ATLAS_COLUMNS = 8;
/** Design grid of a single cell, in canvas pixels. */
export const CELL_SIZE = 64;
/** Square atlas edge, in canvas pixels. */
export const ATLAS_WIDTH = ATLAS_COLUMNS * CELL_SIZE;
export const ATLAS_HEIGHT = ATLAS_COLUMNS * CELL_SIZE;
export const ATLAS_SIZE = ATLAS_WIDTH;

/** Warm CRT / phosphor palette shared by every sprite. */
export const PALETTE = {
  void: '#050a06',
  dim: '#12401f',
  phosphor: '#7dff8a',
  phosphorDeep: '#1f8f3a',
  hull: '#d8ffe0',
  hot: '#fff7dd',
  amber: '#ffc061',
  amberDeep: '#c46a12',
  orange: '#ff9a3c',
  red: '#ff4d4d',
  magenta: '#ff6fae',
  violet: '#b07cff',
  cyan: '#7fe6ff',
  cyanDeep: '#1d6f8c',
};

const TAU = Math.PI * 2;
const U = CELL_SIZE;

/* ------------------------------------------------------------------ helpers */

function withUnit(g, cell, fn) {
  g.save();
  const k = cell / U;
  if (k !== 1) g.scale(k, k);
  try {
    fn();
  } finally {
    g.restore();
  }
}

function poly(g, pts, close = true) {
  g.beginPath();
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  if (close) g.closePath();
}

function shape(g, pts, fill, stroke, lw = 1.6) {
  poly(g, pts);
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = lw;
    g.stroke();
  }
}

function disc(g, x, y, r, fill, stroke, lw = 1.6) {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = lw;
    g.stroke();
  }
}

function ring(g, x, y, r, stroke, lw = 2) {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.strokeStyle = stroke;
  g.lineWidth = lw;
  g.stroke();
}

function box(g, x, y, w, h, fill, stroke, lw = 1.6) {
  if (fill) {
    g.fillStyle = fill;
    g.fillRect(x, y, w, h);
  }
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = lw;
    g.strokeRect(x, y, w, h);
  }
}

/** Radial gradient with a flat fallback for minimal 2D-context implementations. */
function radial(g, x, y, r, stops, fallback) {
  if (typeof g.createRadialGradient !== 'function') return fallback;
  const grd = g.createRadialGradient(x, y, 0, x, y, r);
  if (!grd || typeof grd.addColorStop !== 'function') return fallback;
  for (const [pos, color] of stops) grd.addColorStop(pos, color);
  return grd;
}

/** Linear gradient with a flat fallback, mirroring `radial`. */
function linear(g, x0, y0, x1, y1, stops, fallback) {
  if (typeof g.createLinearGradient !== 'function') return fallback;
  const grd = g.createLinearGradient(x0, y0, x1, y1);
  if (!grd || typeof grd.addColorStop !== 'function') return fallback;
  for (const [pos, color] of stops) grd.addColorStop(pos, color);
  return grd;
}

function label(g, text, color, x = 32, y = 32, size = 34) {
  g.save();
  g.fillStyle = color;
  g.font = `bold ${size}px "Courier New",monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (typeof g.fillText === 'function') g.fillText(text, x, y);
  g.restore();
}

/* ------------------------------------------------------------- sprite table */

/**
 * Ordered sprite definitions. `frames` cells are allocated consecutively in the
 * atlas; `size` is the on-screen edge length in playfield pixels.
 */
export const SPRITE_DEFS = {
  player: {
    frames: 1,
    size: 30,
    draw(g) {
      shape(g, [32, 2, 43, 33, 57, 45, 50, 53, 41, 45, 32, 50, 23, 45, 14, 53, 7, 45, 21, 33], PALETTE.phosphorDeep);
      shape(g, [32, 1, 41, 25, 41, 47, 32, 53, 23, 47, 23, 25], PALETTE.hull, PALETTE.phosphor, 1.4);
      shape(g, [32, 6, 35, 26, 32, 40, 29, 26], PALETTE.phosphor, null);
      disc(g, 32, 24, 5.5, PALETTE.amber);
      disc(g, 32, 24, 2.4, PALETTE.hot);
      box(g, 29, 44, 6, 8, PALETTE.amber);
      box(g, 11, 46, 5, 6, PALETTE.cyan);
      box(g, 48, 46, 5, 6, PALETTE.cyan);
    },
  },
  playerHit: {
    frames: 1,
    size: 30,
    draw(g) {
      shape(g, [32, 2, 43, 33, 57, 45, 50, 53, 41, 45, 32, 50, 23, 45, 14, 53, 7, 45, 21, 33], PALETTE.hot);
      shape(g, [32, 1, 41, 25, 41, 47, 32, 53, 23, 47, 23, 25], PALETTE.hot, PALETTE.amber, 2);
      disc(g, 32, 24, 6, PALETTE.hot);
    },
  },
  shot: {
    frames: 1,
    size: 14,
    draw(g) {
      g.fillStyle = radial(g, 32, 32, 30, [[0, PALETTE.hot], [0.35, PALETTE.amber], [1, 'rgba(255,154,60,0)']], PALETTE.amber);
      g.fillRect(12, 4, 40, 56);
      box(g, 27, 4, 10, 56, PALETTE.hot);
      box(g, 30, 8, 4, 48, '#ffffff');
    },
  },
  laser: {
    frames: 1,
    size: 12,
    draw(g) {
      g.fillStyle = linear(g, 0, 0, 64, 0, [[0, 'rgba(127,230,255,0)'], [0.5, PALETTE.cyan], [1, 'rgba(127,230,255,0)']], PALETTE.cyan);
      g.fillRect(0, 0, 64, 64);
      box(g, 28, 0, 8, 64, PALETTE.hot);
      box(g, 31, 0, 2, 64, '#ffffff');
    },
  },
  bulletOrb: {
    frames: 1,
    size: 18,
    draw(g) {
      disc(g, 32, 32, 22, radial(g, 32, 32, 22, [[0, '#ffffff'], [0.3, PALETTE.hot], [0.6, PALETTE.magenta], [1, 'rgba(176,124,255,0)']], PALETTE.magenta));
      disc(g, 32, 32, 12, PALETTE.magenta);
      disc(g, 32, 32, 5, '#ffffff');
    },
  },
  bulletShaft: {
    frames: 1,
    size: 16,
    draw(g) {
      shape(g, [32, 2, 46, 20, 46, 56, 32, 62, 18, 56, 18, 20], PALETTE.cyan);
      box(g, 28, 6, 8, 48, PALETTE.hot);
      box(g, 30, 10, 4, 40, '#ffffff');
    },
  },
  bulletShell: {
    frames: 1,
    size: 14,
    draw(g) {
      disc(g, 32, 32, 20, PALETTE.red, null);
      disc(g, 32, 32, 12, PALETTE.hot);
      ring(g, 32, 32, 18, PALETTE.amber, 3);
    },
  },
  bulletWave: {
    frames: 1,
    size: 20,
    draw(g) {
      shape(g, [32, 4, 50, 22, 44, 52, 32, 60, 20, 52, 14, 22], PALETTE.violet);
      box(g, 27, 16, 10, 38, PALETTE.hot);
      box(g, 30, 24, 4, 24, '#ffffff');
    },
  },
  enemyGrunt: {
    frames: 1,
    size: 24,
    draw(g) {
      shape(g, [8, 6, 56, 6, 62, 26, 42, 34, 42, 50, 22, 50, 22, 34, 2, 26], PALETTE.phosphorDeep);
      shape(g, [14, 10, 50, 10, 54, 24, 32, 30, 10, 24], PALETTE.phosphor, null);
      disc(g, 32, 20, 6, PALETTE.red);
      disc(g, 32, 20, 2.5, PALETTE.hot);
      box(g, 26, 48, 12, 12, PALETTE.amberDeep);
    },
  },
  enemyPopcorn: {
    frames: 1,
    size: 18,
    draw(g) {
      shape(g, [32, 8, 56, 32, 32, 56, 8, 32], PALETTE.amberDeep);
      shape(g, [32, 16, 48, 32, 32, 48, 16, 32], PALETTE.amber);
      disc(g, 32, 32, 7, PALETTE.hot);
    },
  },
  enemyTurret: {
    frames: 1,
    size: 28,
    draw(g) {
      shape(g, [16, 4, 48, 4, 60, 20, 60, 44, 48, 60, 16, 60, 4, 44, 4, 20], PALETTE.phosphorDeep);
      shape(g, [22, 10, 42, 10, 52, 22, 52, 42, 42, 54, 22, 54, 12, 42, 12, 22], PALETTE.cyanDeep);
      ring(g, 32, 32, 15, PALETTE.cyan, 3);
      disc(g, 32, 32, 9, PALETTE.red);
      disc(g, 32, 32, 4, PALETTE.hot);
      box(g, 18, 54, 8, 10, PALETTE.amber);
      box(g, 38, 54, 8, 10, PALETTE.amber);
    },
  },
  enemyMidboss: {
    frames: 1,
    size: 44,
    draw(g) {
      shape(g, [32, 0, 50, 14, 58, 34, 44, 44, 44, 58, 20, 58, 20, 44, 6, 34, 14, 14], PALETTE.phosphorDeep);
      shape(g, [32, 6, 46, 18, 48, 34, 32, 42, 16, 34, 18, 18], PALETTE.phosphor, null);
      shape(g, [18, 40, 46, 40, 40, 60, 24, 60], PALETTE.amberDeep);
      disc(g, 32, 26, 9, PALETTE.magenta);
      disc(g, 32, 26, 4, PALETTE.hot);
      box(g, 12, 20, 6, 20, PALETTE.amber);
      box(g, 46, 20, 6, 20, PALETTE.amber);
    },
  },
  bossCore: {
    frames: 1,
    size: 132,
    draw(g) {
      shape(g, [32, 0, 54, 10, 62, 30, 52, 44, 54, 62, 32, 62, 10, 62, 12, 44, 2, 30, 10, 10], PALETTE.phosphorDeep);
      shape(g, [32, 4, 48, 16, 54, 32, 44, 46, 44, 58, 20, 58, 20, 46, 10, 32, 16, 16], PALETTE.cyanDeep);
      ring(g, 32, 32, 20, PALETTE.cyan, 3);
      disc(g, 32, 32, 15, PALETTE.red);
      disc(g, 32, 32, 11, radial(g, 32, 32, 11, [[0, '#ffffff'], [0.5, PALETTE.magenta], [1, PALETTE.red]], PALETTE.red));
      disc(g, 32, 32, 4, '#ffffff');
      box(g, 4, 26, 8, 16, PALETTE.amber);
      box(g, 52, 26, 8, 16, PALETTE.amber);
    },
  },
  explosion: {
    frames: 4,
    size: 52,
    draw(g, _s, frame) {
      const t = frame / 3;
      const alpha = 1 - t * 0.75;
      const r = 8 + t * 22;
      g.globalAlpha = alpha;
      disc(g, 32, 32, r, radial(g, 32, 32, r, [[0, '#ffffff'], [0.35, PALETTE.amber], [0.7, PALETTE.orange], [1, 'rgba(255,77,77,0)']], PALETTE.orange));
      ring(g, 32, 32, r + 3, PALETTE.hot, 3);
      if (frame > 0) {
        const spikes = 8;
        for (let i = 0; i < spikes; i++) {
          const a = (i / spikes) * TAU + t;
          const r0 = r * 0.6;
          const r1 = r * 1.5;
          shape(
            g,
            [32 + Math.cos(a) * r0 - 2, 32 + Math.sin(a) * r0 - 2, 32 + Math.cos(a) * r1, 32 + Math.sin(a) * r1, 32 + Math.cos(a) * r0 + 2, 32 + Math.sin(a) * r0 + 2],
            PALETTE.hot
          );
        }
      }
      g.globalAlpha = 1;
    },
  },
  spark: {
    frames: 1,
    size: 16,
    draw(g) {
      shape(g, [32, 4, 36, 28, 60, 32, 36, 36, 32, 60, 28, 36, 4, 32, 28, 28], PALETTE.hot);
      disc(g, 32, 32, 6, PALETTE.amber);
    },
  },
  ring: {
    frames: 1,
    size: 60,
    draw(g) {
      ring(g, 32, 32, 26, PALETTE.cyan, 3);
      ring(g, 32, 32, 18, PALETTE.hot, 2);
      ring(g, 32, 32, 10, PALETTE.phosphor, 1.5);
    },
  },
  graze: {
    frames: 1,
    size: 22,
    draw(g) {
      g.strokeStyle = PALETTE.cyan;
      g.lineWidth = 4;
      g.beginPath();
      g.arc(32, 44, 22, Math.PI * 1.15, Math.PI * 1.85);
      g.stroke();
      ring(g, 32, 44, 12, PALETTE.hot, 2);
    },
  },
  powerPow: {
    frames: 1,
    size: 26,
    draw(g) {
      shape(g, [32, 2, 58, 16, 58, 48, 32, 62, 6, 48, 6, 16], PALETTE.red, PALETTE.hot, 2);
      label(g, 'P', PALETTE.hot);
    },
  },
  powerLife: {
    frames: 1,
    size: 26,
    draw(g) {
      shape(g, [32, 2, 58, 16, 58, 48, 32, 62, 6, 48, 6, 16], PALETTE.phosphorDeep, PALETTE.hot, 2);
      shape(g, [32, 20, 44, 32, 32, 50, 20, 32], PALETTE.hot);
      box(g, 28, 28, 8, 8, PALETTE.phosphor);
    },
  },
  powerBomb: {
    frames: 1,
    size: 26,
    draw(g) {
      shape(g, [32, 2, 58, 16, 58, 48, 32, 62, 6, 48, 6, 16], PALETTE.violet, PALETTE.hot, 2);
      label(g, 'B', PALETTE.hot);
    },
  },
  powerScore: {
    frames: 1,
    size: 26,
    draw(g) {
      shape(g, [32, 2, 58, 16, 58, 48, 32, 62, 6, 48, 6, 16], PALETTE.amberDeep, PALETTE.hot, 2);
      label(g, '$', PALETTE.hot);
    },
  },
  star: {
    frames: 1,
    size: 6,
    draw(g) {
      disc(g, 32, 32, 20, radial(g, 32, 32, 20, [[0, '#ffffff'], [0.4, PALETTE.amber], [1, 'rgba(255,192,97,0)']], PALETTE.amber));
      disc(g, 32, 32, 8, '#ffffff');
    },
  },
  flame: {
    frames: 2,
    size: 14,
    draw(g, _s, frame) {
      const len = frame === 0 ? 46 : 32;
      shape(g, [32 - 10, 4, 32 + 10, 4, 32, len], PALETTE.amber);
      shape(g, [32 - 6, 6, 32 + 6, 6, 32, len - 10], PALETTE.hot);
    },
  },
  bombWave: {
    frames: 1,
    size: 260,
    draw(g) {
      disc(g, 32, 32, 32, radial(g, 32, 32, 32, [[0, 'rgba(255,255,255,0)'], [0.55, 'rgba(255,247,221,0.35)'], [0.82, 'rgba(127,230,255,0.75)'], [1, 'rgba(127,230,255,0)']], PALETTE.cyan));
      ring(g, 32, 32, 30, PALETTE.hot, 3);
    },
  },
};

/** Sprite names in atlas order. */
export const SPRITE_NAMES = Object.keys(SPRITE_DEFS);

/** Flat frame table: entry per atlas cell. */
export const SPRITE_LAYOUT = (() => {
  const out = [];
  let index = 0;
  for (const name of SPRITE_NAMES) {
    const def = SPRITE_DEFS[name];
    for (let frame = 0; frame < def.frames; frame++) out.push({ name, frame, index: index++ });
  }
  return out;
})();

/** Total number of atlas cells in use. */
export const SPRITE_COUNT = SPRITE_LAYOUT.length;

const BASE_INDEX = (() => {
  const map = new Map();
  for (const entry of SPRITE_LAYOUT) if (!map.has(entry.name)) map.set(entry.name, entry.index);
  return map;
})();

/* ---------------------------------------------------------------- pure math */

/** @returns {number} first atlas cell of a sprite, or -1 when unknown. */
export function spriteIndex(name, frame = 0) {
  const base = BASE_INDEX.get(name);
  if (base === undefined) return -1;
  const frames = SPRITE_DEFS[name].frames;
  return base + (((frame % frames) + frames) % frames);
}

/** @returns {{x:number,y:number,w:number,h:number}} pixel rect of a cell. */
export function spriteCell(name, frame = 0, cell = CELL_SIZE, columns = ATLAS_COLUMNS) {
  const index = spriteIndex(name, frame);
  const i = index < 0 ? 0 : index;
  return { x: (i % columns) * cell, y: Math.floor(i / columns) * cell, w: cell, h: cell, index: i };
}

/**
 * Texture coordinates of a cell, already flipped for `CanvasTexture` (flipY).
 * @returns {{u0:number,v0:number,u1:number,v1:number,uc:number,vc:number,x:number,y:number,w:number,h:number}}
 */
export function spriteUv(name, frame = 0, atlasWidth = ATLAS_WIDTH, atlasHeight = ATLAS_HEIGHT, cell = CELL_SIZE, columns = ATLAS_COLUMNS) {
  const r = spriteCell(name, frame, cell, columns);
  const u0 = r.x / atlasWidth;
  const u1 = (r.x + r.w) / atlasWidth;
  const v1 = 1 - r.y / atlasHeight;
  const v0 = 1 - (r.y + r.h) / atlasHeight;
  return { u0, v0, u1, v1, uc: (u0 + u1) / 2, vc: (v0 + v1) / 2, x: r.x, y: r.y, w: r.w, h: r.h };
}

/** On-screen edge length of a sprite, in playfield pixels. */
export function spriteDisplaySize(name) {
  const def = SPRITE_DEFS[name];
  return def ? def.size : CELL_SIZE;
}

/** Atlas cell count a sprite consumes. */
export function spriteFrameCount(name) {
  const def = SPRITE_DEFS[name];
  return def ? def.frames : 0;
}

/** True when the name exists in the atlas. */
export function hasSprite(name) {
  return Object.prototype.hasOwnProperty.call(SPRITE_DEFS, name);
}

/* ------------------------------------------------------------------ painting */

/**
 * Paint every sprite into a 2D context (transparent background).
 * Coordinates: each cell is drawn in a 64×64 design space, top-left origin.
 */
export function paintAtlas(g, opts = {}) {
  const cell = opts.cell ?? CELL_SIZE;
  const columns = opts.columns ?? ATLAS_COLUMNS;
  if (!g || typeof g.fillRect !== 'function') return false;
  if (typeof g.clearRect === 'function') g.clearRect(0, 0, opts.width ?? ATLAS_WIDTH, opts.height ?? ATLAS_HEIGHT);
  for (const entry of SPRITE_LAYOUT) {
    const def = SPRITE_DEFS[entry.name];
    if (!def || typeof def.draw !== 'function') continue;
    const r = spriteCell(entry.name, entry.frame, cell, columns);
    g.save();
    g.translate(r.x, r.y);
    withUnit(g, cell, () => def.draw(g, cell, entry.frame));
    g.restore();
  }
  return true;
}

/** Paint a single sprite cell at (x, y) with an explicit edge length. */
export function drawSprite(g, name, x, y, size = CELL_SIZE, frame = 0) {
  const def = SPRITE_DEFS[name];
  if (!def || typeof g?.save !== 'function') return false;
  g.save();
  g.translate(x, y);
  withUnit(g, size, () => def.draw(g, size, frame));
  g.restore();
  return true;
}

/* ------------------------------------------------------------------- texture */

/**
 * Build the atlas texture.
 *
 * Accepts injected collaborators so the module stays usable outside a browser:
 *   `{ THREE, doc, cell, columns, filter }`
 * Without a DOM canvas and three it still returns a fully populated metadata
 * view (`ok: false`, `texture: null`), so UV lookup never depends on the GPU.
 */
export function createSpriteAtlas(opts = {}) {
  const three = opts.THREE || THREE;
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  const cell = opts.cell ?? CELL_SIZE;
  const columns = opts.columns ?? ATLAS_COLUMNS;
  const width = opts.width ?? ATLAS_WIDTH;
  const height = opts.height ?? ATLAS_HEIGHT;

  let canvas = null;
  let texture = null;

  if (doc && typeof doc.createElement === 'function') {
    canvas = doc.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    paintAtlas(g, { cell, columns, width, height });
    if (three && typeof three.CanvasTexture === 'function') {
      texture = new three.CanvasTexture(canvas);
      texture.magFilter = opts.filter ?? three.NearestFilter;
      texture.minFilter = three.LinearMipMapLinearFilter ?? three.LinearFilter;
      texture.generateMipmaps = true;
      texture.colorSpace = three.SRGBColorSpace ?? undefined;
      texture.needsUpdate = true;
    }
  }

  return {
    /** True when the GPU texture exists. */
    get ok() {
      return !!texture;
    },
    get canvas() {
      return canvas;
    },
    get texture() {
      return texture;
    },
    width,
    height,
    cell,
    columns,
    names: SPRITE_NAMES,
    count: SPRITE_COUNT,
    /** UV rect of a sprite frame, always available. */
    uv: (name, frame = 0) => spriteUv(name, frame, width, height, cell, columns),
    /** Pixel rect of a sprite frame. */
    rect: (name, frame = 0) => spriteCell(name, frame, cell, columns),
    displaySize: spriteDisplaySize,
    frameCount: spriteFrameCount,
    has: hasSprite,
    /** Re-paint into the existing canvas (used by stage-tinted atlases). */
    repaint() {
      if (!canvas) return false;
      const g = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      paintAtlas(g, { cell, columns, width, height });
      if (texture) texture.needsUpdate = true;
      return true;
    },
    dispose() {
      if (texture && typeof texture.dispose === 'function') texture.dispose();
      texture = null;
      canvas = null;
    },
  };
}

/** Alias kept for call sites that read better as `createAtlas()`. */
export const createAtlas = createSpriteAtlas;

export default {
  PALETTE,
  SPRITE_DEFS,
  SPRITE_NAMES,
  SPRITE_LAYOUT,
  SPRITE_COUNT,
  ATLAS_COLUMNS,
  CELL_SIZE,
  ATLAS_WIDTH,
  ATLAS_HEIGHT,
  ATLAS_SIZE,
  spriteIndex,
  spriteCell,
  spriteUv,
  spriteDisplaySize,
  spriteFrameCount,
  hasSprite,
  paintAtlas,
  drawSprite,
  createSpriteAtlas,
  createAtlas,
};
