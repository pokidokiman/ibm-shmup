/**
 * scenery-registry.mjs — the catalogue of generated scenery art.
 *
 * The parallax stack draws *generated* artwork: every tile is a PNG under
 * `assets/scenery/` (produced by the art pipeline, loaded through
 * `./assets.mjs`). This module is the single place that knows which file belongs
 * to which stage theme, so `./parallax.mjs` never hard-codes a filename and a
 * new theme / tile is added here and nowhere else.
 *
 * Naming contract (matches `assets/scenery/`):
 *   `c_*` city        `i_*` industrial   `d_*` desert
 *   `o_*` ocean       `x_*` space        `a_*` atmosphere (shared, far layer)
 *
 * The module is deliberately dependency-free (no three, no DOM) so it can be
 * imported by the render layer *and* by plain Node tooling.
 */

/** Scenery PNG base names per stage theme (no extension). */
export const THEME_SCENERY = Object.freeze({
  city: Object.freeze(['c_block_a', 'c_block_b', 'c_bridge', 'c_neon', 'c_park', 'c_roof_c', 'c_street']),
  industrial: Object.freeze(['i_floor', 'i_girder', 'i_hatch', 'i_pipes', 'i_tank', 'i_wall']),
  desert: Object.freeze(['d_canyon', 'd_drybed', 'd_mesa', 'd_road', 'd_rocks']),
  ocean: Object.freeze(['o_deck', 'o_rig', 'o_shore', 'o_turret', 'o_waves']),
  space: Object.freeze(['x_arm', 'x_asteroid_a', 'x_asteroid_b', 'x_debris', 'x_module', 'x_panel', 'x_stars']),
});

/**
 * Atmosphere tiles shared by every theme. They are translucent sky furniture
 * (clouds, nebulae), so they only ever ride the far layer.
 */
export const ATMOSPHERE_SCENERY = Object.freeze(['a_cloud', 'a_nebula', 'a_nebula2']);

/** Every scenery base name the registry knows, theme art first. */
export const SCENERY_FILES = Object.freeze([
  ...Object.values(THEME_SCENERY).flat(),
  ...ATMOSPHERE_SCENERY,
]);

/** Theme ids the catalogue ships, in stage order. */
export const SCENERY_THEMES = Object.freeze(Object.keys(THEME_SCENERY));

/** Prefix that marks a file as theme scenery / atmosphere scenery. */
export const SCENERY_PREFIX = Object.freeze({
  city: 'c_',
  industrial: 'i_',
  desert: 'd_',
  ocean: 'o_',
  space: 'x_',
  atmosphere: 'a_',
});

/** Relative directory holding the scenery PNGs, mirrored by `./assets.mjs`. */
export const SCENERY_DIR = 'assets/scenery';

/**
 * Base name → path relative to the site root (`c_street` → `assets/scenery/c_street.png`).
 * @param {string} name
 * @returns {string}
 */
export function sceneryPath(name) {
  return `${SCENERY_DIR}/${String(name).replace(/\.png$/i, '')}.png`;
}

/**
 * The file list a layer draws from.
 *
 * `far` mixes the shared atmosphere tiles in front of the theme art so distant
 * stages read as sky; `mid` / `near` use the theme art alone, closest largest.
 *
 * @param {string} theme a theme id (`city`, `industrial`, `desert`, `ocean`, `space`)
 * @param {'far'|'mid'|'near'} [layer]
 * @returns {readonly string[]}
 */
export function sceneryFilesFor(theme, layer = 'mid') {
  const themed = THEME_SCENERY[theme] ?? THEME_SCENERY.space;
  if (layer === 'far') return Object.freeze([...ATMOSPHERE_SCENERY, ...themed]);
  return themed;
}

/** True when `name` is one of the registered scenery files. */
export function isSceneryFile(name) {
  return SCENERY_FILES.includes(String(name).replace(/\.png$/i, ''));
}

export default {
  THEME_SCENERY,
  ATMOSPHERE_SCENERY,
  SCENERY_FILES,
  SCENERY_THEMES,
  SCENERY_PREFIX,
  SCENERY_DIR,
  sceneryPath,
  sceneryFilesFor,
  isSceneryFile,
};
