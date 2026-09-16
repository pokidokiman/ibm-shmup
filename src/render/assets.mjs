/**
 * assets.mjs — binary sprite manifest and texture loader.
 *
 * The rest of the render layer paints its sprites procedurally (`./sprites.mjs`),
 * but the shipped art under `assets/` (bullets, enemies, ships, boss parts,
 * pickups, explosions and the scenery tiles) still has to be uploaded to the
 * GPU. This module is the single place that knows about those PNG files:
 *
 *   • `ASSET_MANIFEST` — a frozen `{ name -> relative path }` table of every PNG
 *     under `assets/` and `assets/scenery/`, keyed by filename without its
 *     extension. The table is a literal so the manifest is identical in the
 *     browser and in Node (there is no filesystem to enumerate client-side);
 *   • `ALIASES` — the sprite vocabulary used by the rest of the game
 *     (`player`, `shot`, `enemyGrunt`, …) mapped onto the file that backs it
 *     (`s_player.png`, `b_shot_player.png`, `e_drone.png`, …), so the atlas can
 *     resolve a name to its art before it falls back to a procedural painter;
 *   • `loadAssets()` — turns that table into `{ name -> THREE.Texture }`.
 *
 * Every texture is configured for crisp pixel art: nearest-neighbour
 * magnification *and* minification, mipmaps disabled. Paths are resolved
 * against a caller-supplied base URL (defaulting to the site root that holds
 * `assets/`), and a failure on any single file is swallowed so one missing PNG
 * can never take the whole boot down.
 *
 * `three` is imported lazily (there is no static `import ... from 'three'` here)
 * so this module can be inspected and imported in a bare Node process (where
 * the browser `three` import map does not exist). Tests may also inject a
 * `three`-compatible namespace via `loadAssets({ three })`.
 */

/** Directory holding the loose sprite PNGs, relative to the site root. */
export const ROOT_ASSET_DIR = 'assets';
/** Directory holding the scenery tile PNGs, relative to the site root. */
export const SCENERY_ASSET_DIR = 'assets/scenery';

/** @type {readonly string[]} sprite names living directly in `assets/`. */
const ROOT_SPRITES = Object.freeze([
  // bullets
  'b_bubble',
  'b_needle',
  'b_orb_large',
  'b_orb_small',
  'b_plasma',
  'b_ring',
  'b_shot_player',
  'b_sword',
  // enemies
  'e_drone',
  'e_midboss',
  'e_popcorn',
  'e_turret',
  // boss parts
  'bs_core',
  'bs_pod',
  // pickups
  'p_bomb',
  'p_life',
  'p_power',
  'p_star',
  // ships / engine flames
  's_flame',
  's_player',
  // explosions
  'x_1',
  'x_2',
  'x_3',
  'x_4',
  // player laser beam
  'l_beam',
]);

/** @type {readonly string[]} scenery tile names living in `assets/scenery/`. */
const SCENERY_SPRITES = Object.freeze([
  // atmosphere
  'a_cloud',
  'a_nebula',
  'a_nebula2',
  // city
  'c_block_a',
  'c_block_b',
  'c_bridge',
  'c_neon',
  'c_park',
  'c_roof_c',
  'c_street',
  // desert
  'd_canyon',
  'd_drybed',
  'd_mesa',
  'd_road',
  'd_rocks',
  // interior
  'i_floor',
  'i_girder',
  'i_hatch',
  'i_pipes',
  'i_tank',
  'i_wall',
  // ocean
  'o_deck',
  'o_rig',
  'o_shore',
  'o_turret',
  'o_waves',
  // orbit / space
  'x_arm',
  'x_asteroid_a',
  'x_asteroid_b',
  'x_debris',
  'x_module',
  'x_panel',
  'x_stars',
]);

/**
 * Build the manifest: every PNG keyed by its bare filename, valued by the path
 * relative to the assets base URL.
 * @returns {Readonly<Record<string, string>>}
 */
function buildManifest() {
  /** @type {Record<string, string>} */
  const manifest = {};
  for (const name of ROOT_SPRITES) manifest[name] = `${ROOT_ASSET_DIR}/${name}.png`;
  for (const name of SCENERY_SPRITES) manifest[name] = `${SCENERY_ASSET_DIR}/${name}.png`;
  return Object.freeze(manifest);
}

/**
 * Every sprite the game ships, keyed by filename without extension.
 * @type {Readonly<Record<string, string>>}
 */
export const ASSET_MANIFEST = buildManifest();

/** Number of files in the manifest. */
export const ASSET_COUNT = Object.keys(ASSET_MANIFEST).length;

/**
 * Sprite-name aliases: the name the rest of the game (and the procedural atlas
 * in `./sprites.mjs`) uses for a sprite, mapped onto the PNG file that backs it.
 *
 * The shipped art is named after *what it is* (`s_player.png`, `e_drone.png`,
 * `b_shot_player.png`, …) while the render layer names sprites after *what they
 * do* (`player`, `enemyGrunt`, `shot`, …); this table is the one place that
 * knows both spellings. `./sprites.mjs` resolves every incoming sprite name
 * through it before touching the atlas, so a name with art hits its file and a
 * name without one keeps its procedural cell.
 *
 * Names that are already file keys map to themselves, so the table is a total
 * lookup for everything with PNG art.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ALIASES = Object.freeze({
  // ships
  player: 's_player.png',
  // enemies
  enemyGrunt: 'e_drone.png',
  enemyPopcorn: 'e_popcorn.png',
  enemyTurret: 'e_turret.png',
  enemyMidboss: 'e_midboss.png',
  // shared danmaku
  bulletOrb: 'b_orb_small.png',
  shot: 'b_shot_player.png',
  laser: 'l_beam.png',
  // boss parts
  bossCore: 'bs_core.png',
  // pickups
  powerPow: 'p_power.png',
  powerBomb: 'p_bomb.png',
  powerLife: 'p_life.png',
  powerScore: 'p_star.png',
  star: 'p_star.png',
  power: 'p_power.png',
  bomb: 'p_bomb.png',
  // sprite names that already are file keys
  b_orb_large: 'b_orb_large.png',
  b_ring: 'b_ring.png',
  b_needle: 'b_needle.png',
  b_bubble: 'b_bubble.png',
  b_plasma: 'b_plasma.png',
  b_sword: 'b_sword.png',
  bs_pod: 'bs_pod.png',
  s_flame: 's_flame.png',
  x_1: 'x_1.png',
  x_2: 'x_2.png',
  x_3: 'x_3.png',
  x_4: 'x_4.png',
});

/** Number of entries in {@link ALIASES}. */
export const ALIAS_COUNT = Object.keys(ALIASES).length;

/**
 * Default base URL: the site root that sits two levels above this module
 * (`src/render/assets.mjs` -> `<root>/`), i.e. the directory `index.html` and
 * the `assets/` tree live in. Using `import.meta.url` keeps it correct no
 * matter what page or script tag booted the game; the manifest values are
 * already relative to this root (`assets/...`).
 */
export const DEFAULT_BASE_URL = (() => {
  try {
    return new URL('../../', import.meta.url).href;
  } catch {
    return './';
  }
})();

/* --------------------------------------------------------------- three glue */

/** @type {Promise<any> | null} */
let threePromise = null;

/**
 * Lazily import the `three` namespace (the browser maps the bare specifier via
 * `index.html`'s import map). Cached, and reset on failure so a later call can
 * retry.
 * @returns {Promise<any>}
 */
export function loadThree() {
  if (!threePromise) {
    threePromise = import('three').catch((err) => {
      threePromise = null;
      throw err;
    });
  }
  return threePromise;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Join a relative asset path onto a base URL. Absolute (scheme-ful) bases go
 * through `URL`, everything else is joined with a single slash so plain
 * directory prefixes (`assets/`, `./assets/`) work too.
 * @param {string} baseUrl
 * @param {string} relPath
 * @returns {string}
 */
export function resolveAssetUrl(baseUrl, relPath) {
  const rel = String(relPath).replace(/^\/+/, '');
  const base = baseUrl == null ? '' : String(baseUrl);
  if (!base) return rel;
  if (/^[a-z][a-z0-9+.-]*:/i.test(base) || base.startsWith('//')) {
    try {
      return new URL(rel, base.endsWith('/') ? base : `${base}/`).href;
    } catch {
      /* fall through to string joining */
    }
  }
  return `${base.replace(/\/+$/, '')}/${rel}`;
}

/**
 * Apply the pixel-art sampling contract to a texture.
 * @param {object} texture
 * @param {any} THREE
 * @returns {object}
 */
function configureTexture(texture, THREE) {
  if (!texture) return texture;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  if (THREE.ClampToEdgeWrapping !== undefined) {
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  if (THREE.SRGBColorSpace !== undefined) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Wrap `TextureLoader.load` in a promise that settles exactly once.
 * @param {{load: Function}} loader
 * @param {string} url
 * @returns {Promise<any>}
 */
function loadTexture(loader, url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err ?? new Error(`failed to load texture: ${url}`));
    };
    try {
      loader.load(url, done, undefined, fail);
    } catch (err) {
      fail(err);
    }
  });
}

/* ------------------------------------------------------------------- loader */

/**
 * Load every PNG in `ASSET_MANIFEST` as a nearest-filtered `THREE.Texture`.
 *
 * A file that fails to load is simply left out of the result — one broken or
 * missing asset never aborts the boot. When `three` itself is unavailable (or
 * has no `TextureLoader`) the returned map is empty rather than throwing.
 *
 * @param {{
 *   baseUrl?: string,
 *   three?: any,
 *   loader?: {load: Function},
 *   loadingManager?: any,
 *   onError?: (err: unknown, key: string, url: string) => void,
 * }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function loadAssets(options = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const report = typeof options.onError === 'function' ? options.onError : null;

  let THREE = options.three;
  if (!THREE) {
    try {
      THREE = await loadThree();
    } catch (err) {
      if (report) {
        try {
          report(err, '*', 'three');
        } catch {
          /* a broken reporter must not break the loader */
        }
      }
      return {};
    }
  }

  let loader = options.loader;
  if (!loader) {
    if (typeof THREE.TextureLoader !== 'function') return {};
    loader = options.loadingManager
      ? new THREE.TextureLoader(options.loadingManager)
      : new THREE.TextureLoader();
  }

  const textures = {};
  const keys = Object.keys(ASSET_MANIFEST);

  await Promise.all(
    keys.map(async (key) => {
      const url = resolveAssetUrl(baseUrl, ASSET_MANIFEST[key]);
      try {
        const texture = await loadTexture(loader, url);
        textures[key] = configureTexture(texture, THREE);
      } catch (err) {
        if (report) {
          try {
            report(err, key, url);
          } catch {
            /* swallow reporter failures too */
          }
        }
      }
    }),
  );

  return textures;
}

export default { ASSET_MANIFEST, loadAssets };
