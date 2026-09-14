/**
 * waves.mjs — the stage timeline: a deterministic, hand-authored spawn schedule.
 *
 * Pure simulation code: no DOM, no three, no timers. `createStage(n)` compiles
 * the authored plan for a stage into a fixed schedule of spawn events and hands
 * the game layer a single lookup:
 *
 *   for (let f = 0; f < stage.durationFrames; f++)
 *     for (const ev of stage.at(f)) spawn(ev);
 *
 * The timeline is *not* a uniform bar-grid any more: each stage is a sequence of
 * named sections (opening -> build -> ramp -> midboss -> press -> crescendo),
 * and every wave inside a section is written out by hand — enemy kind, formation,
 * lane, member count, member spacing and danmaku tuning. That gives the stage a
 * deliberate difficulty curve (sparse opening, ramping mid-game, a mid-stage
 * midboss spike, a boss finale) instead of a constant drip.
 *
 * Timing is authored in **bars** (one second of stage music at the sim's 60 Hz);
 * a wave's members can be staggered across several bars via `gap`, so a single
 * authored entry can keep pressure on for two or three seconds without drifting
 * into dead air.
 *
 * Event shapes (`kind` is the discriminator the tests pin):
 *   { kind: 'enemy',   type, enemy, x, y, opts }   regular spawn
 *   { kind: 'midboss', type: 'midboss', x, y, opts }
 *   { kind: 'boss',    type: 'boss', stage, x, opts }
 *
 * `type` and `enemy` carry the same archetype name, and `opts` is exactly the bag
 * `createEnemy(kind, x, y, opts)` accepts, so a spawn reduces to
 * `createEnemy(ev.type, ev.x, ev.y, ev.opts)`.
 *
 * Stage objects also expose the timeline metadata the renderer/HUD wants:
 * `progress(frame)`, `bossFrame`, `midbossFrame`, `marks`, `waves`, `tint`.
 */
import { BALANCE, STAGE_TABLE, ENEMY_TABLE } from './config.mjs';
import { createRng } from '../core/rng.mjs';

/** Frames per bar: one second of stage music at the 60 Hz simulation rate. */
export const BAR_FRAMES = 60;

/** Shared immutable result for frames with nothing scheduled. */
export const EMPTY_EVENTS = Object.freeze([]);

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const fieldCfg = () =>
  BALANCE && BALANCE.field
    ? BALANCE.field
    : { width: 1024, height: 768, centerX: 512, centerY: 384, spawnY: -48, cullMargin: 96 };

const pacingCfg = () => (BALANCE && BALANCE.pacing ? BALANCE.pacing : {});

/** Movement scripts waves.mjs is allowed to hand to enemies.mjs. */
export const WAVE_SCRIPTS = ['dive', 'crossDown', 'weave', 'hover', 'swoop', 'crossHold', 'hold'];

/** Formation recipes. All place at least one enemy on the wave's own frame. */
export const FORMATION_SHAPES = [
  'line',
  'wall',
  'stream',
  'pincer',
  'vee',
  'weaveLane',
  'column',
  'flank',
  'arc',
  'ring',
  'echelon',
  'sweep',
];

/** Default firing-window height (fraction of the field) per formation. */
const FORM_HOLD = {
  line: 0.26,
  wall: 0.22,
  stream: 0.3,
  pincer: 0.26,
  vee: 0.26,
  weaveLane: 0.34,
  column: 0.3,
  flank: 0.3,
  arc: 0.22,
  ring: 0.18,
  echelon: 0.26,
  sweep: 0.2,
};

/** Default frames between formation members when an entry omits `gap`. */
const FORM_GAP = {
  line: 0,
  wall: 0,
  stream: 14,
  pincer: 12,
  vee: 6,
  weaveLane: 12,
  column: 8,
  flank: 10,
  arc: 8,
  ring: 4,
  echelon: 8,
  sweep: 0,
};

/** Per-enemy opt keys a wave may author straight through to `createEnemy`. */
const PASSTHROUGH = ['pattern', 'bulletSpeed', 'fireCd', 'burst', 'spreadDeg', 'drop', 'speed', 'hp', 'points'];

const HEAVY_KINDS = ['turret', 'heavy', 'midboss', 'boss'];

/* ------------------------------------------------------------------ helpers */

function tableFor(stage) {
  const table = Array.isArray(STAGE_TABLE) && STAGE_TABLE.length ? STAGE_TABLE : [];
  if (typeof stage === 'object' && stage) {
    const idx = clamp(Math.floor(num(stage.stage, 1)), 1, Math.max(1, table.length)) - 1;
    return { ...(table[idx] || {}), ...stage };
  }
  const idx = clamp(Math.floor(num(stage, 1)), 1, Math.max(1, table.length)) - 1;
  return table[idx] || {
    stage: 1,
    name: 'ORBITAL SHELF',
    durationFrames: 5400,
    midbossAt: 0.55,
    bossAt: 1,
    bossPhases: num(BALANCE && BALANCE.bossPhases, 3),
    bossHp: 3200,
    spawnInterval: 42,
    density: 1,
    rankStart: 0.15,
    enemyMix: { popcorn: 5, grunt: 3, turret: 1 },
    backdrop: 'shelf',
    tint: '#7dff8a',
    tempo: 132,
  };
}

/** Mix weights, pruned to archetypes the balance table actually defines. */
function mixOf(rec) {
  const raw = rec.enemyMix && typeof rec.enemyMix === 'object' ? rec.enemyMix : {};
  const known = ENEMY_TABLE || {};
  const mix = [];
  for (const kind in raw) {
    const weight = num(raw[kind], 0);
    if (weight > 0 && known[kind]) mix.push({ kind, weight });
  }
  if (mix.length === 0) mix.push({ kind: 'popcorn', weight: 1 }, { kind: 'grunt', weight: 1 });
  return mix;
}

function pickWeighted(mix, rng) {
  let total = 0;
  for (const entry of mix) total += entry.weight;
  let roll = rng.float(0, total);
  for (const entry of mix) {
    roll -= entry.weight;
    if (roll < 0) return entry.kind;
  }
  return mix[mix.length - 1].kind;
}

/** One formation member: an enemy event ready for `createEnemy`. */
function enemyEvent(kind, x, y, opts, frame) {
  const bag = {};
  for (const key in opts) {
    const value = opts[key];
    if (value !== undefined && value !== null) bag[key] = value;
  }
  bag.frame = frame;
  return { kind: 'enemy', type: kind, enemy: kind, x, y, frame, opts: bag };
}

/* ------------------------------------------------------------------ plans -- */

/**
 * Authored wave rows. A row is
 *   [atBar, formation, kind, count, extra]
 * where `kind` may be a single archetype or an array cycled across members, and
 * `extra` carries any of:
 *   gap         frames between members (defaults per formation)
 *   spread      fraction of the field width the formation covers (0.12..1)
 *   lane        0..1 x anchor for stream/column waves
 *   hold        firing-window height as a fraction of the field
 *   holdFrames  frames spent in the firing window
 *   sway/drift  extra movement flavour
 *   script      movement-script override
 *   pattern / bulletSpeed / fireCd / burst / spreadDeg  danmaku overrides
 *   drop        per-enemy drop chance (used to reward aggressive clears)
 *   section     hand-authored section label (also surfaced in `stage.waves`)
 *   tune        per-kind override bag, e.g. { grunt: { drop: 0.5 } }
 *
 * Numbers are authored, not generated: the opening deliberately places 1-2
 * enemies per second, the ramp doubles that, the midboss escorts more than
 * double it again, and the crescendo is a continuous wall.
 */
const STAGE1_PLAN = [
  /* ---- open: sparse, popcorn-led streams. Few shots, lots of scoring. ---- */
  [0, 'stream', 'popcorn', 5, { lane: 0.3, gap: 60, section: 'open' }],
  [2, 'stream', 'popcorn', 5, { lane: 0.7, gap: 60, section: 'open' }],
  [4, 'line', 'grunt', 2, { spread: 0.36, hold: 0.24, section: 'open' }],
  [6, 'stream', 'popcorn', 5, { lane: 0.5, gap: 60, section: 'open' }],
  [8, 'vee', 'grunt', 3, { spread: 0.5, gap: 30, section: 'open' }],
  [10, 'weaveLane', 'popcorn', 5, { spread: 0.62, gap: 30, section: 'open' }],

  /* ---- build: first real formations, one anchor turret per phrase. ---- */
  [12, 'echelon', 'grunt', 5, { gap: 30, spread: 0.6, section: 'build' }],
  [14, 'stream', 'popcorn', 6, { lane: 0.25, gap: 30, section: 'build' }],
  [16, 'pincer', 'grunt', 5, { gap: 30, spread: 0.8, section: 'build' }],
  [18, 'line', 'grunt', 3, { spread: 0.68, section: 'build' }],
  [19, 'stream', 'popcorn', 5, { lane: 0.75, gap: 30, section: 'build' }],
  [21, 'flank', 'grunt', 5, { gap: 24, spread: 0.72, section: 'build' }],
  [23, 'line', 'popcorn', 4, { spread: 0.6, gap: 12, section: 'build' }],
  [23, 'column', 'turret', 1, { hold: 0.18, holdFrames: 300, drop: 0.75, fireCd: 78, section: 'build' }],
  [25, 'vee', 'grunt', 5, { gap: 18, spread: 0.6, section: 'build' }],
  [27, 'weaveLane', 'popcorn', 6, { gap: 24, spread: 0.7, section: 'build' }],

  /* ---- ramp: pressure climbs, heavies arrive, slow/fast bullets meet. ---- */
  [28, 'arc', 'grunt', 6, { gap: 20, spread: 0.62, section: 'ramp' }],
  [30, 'stream', 'popcorn', 8, { lane: 0.4, gap: 20, section: 'ramp' }],
  [31, 'echelon', 'grunt', 6, { gap: 18, spread: 0.7, section: 'ramp' }],
  [33, 'pincer', 'grunt', 6, { gap: 16, section: 'ramp' }],
  [33, 'line', 'heavy', 1, { hold: 0.2, holdFrames: 260, drop: 0.8, fireCd: 70, section: 'ramp' }],
  [35, 'stream', 'popcorn', 8, { lane: 0.6, gap: 18, section: 'ramp' }],
  [36, 'flank', 'grunt', 6, { gap: 16, spread: 0.72, section: 'ramp' }],
  [38, 'line', 'grunt', 5, { gap: 12, spread: 0.6, section: 'ramp' }],
  [38, 'column', 'turret', 1, { hold: 0.18, holdFrames: 300, drop: 0.8, pattern: 'ring', section: 'ramp' }],
  [40, 'sweep', 'popcorn', 7, { spread: 0.82, gap: 10, section: 'ramp' }],
  [41, 'echelon', 'grunt', 7, { gap: 14, pattern: 'aimed', section: 'ramp' }],
  [43, 'stream', 'popcorn', 8, { lane: 0.5, gap: 14, section: 'ramp' }],
  [43, 'line', 'heavy', 2, { spread: 0.5, hold: 0.2, drop: 0.85, section: 'ramp' }],
  [44, 'pincer', 'grunt', 7, { gap: 12, section: 'ramp' }],

  /* ---- midboss: the spike. Escorts before and after the anchor, plus a
     slow-lane / fast-lane grunt pair so the two bullet speeds overlap. ---- */
  [45, 'ring', 'popcorn', 8, { hold: 0.18, gap: 6, drop: 0.5, section: 'midboss' }],
  [46, 'stream', 'grunt', 6, { lane: 0.3, gap: 20, drop: 0.5, bulletSpeed: 3.4, section: 'midboss' }],
  [46, 'stream', 'grunt', 6, { lane: 0.7, gap: 20, drop: 0.5, bulletSpeed: 6.6, section: 'midboss' }],
  [48, 'ring', 'popcorn', 10, { hold: 0.16, gap: 4, drop: 0.55, section: 'midboss' }],
  [49, 'flank', 'grunt', 8, { gap: 12, drop: 0.5, spread: 0.78, section: 'midboss' }],
  [51, 'pincer', 'grunt', 8, { gap: 12, section: 'midboss' }],
  [52, 'wall', 'popcorn', 10, { spread: 0.88, gap: 4, section: 'midboss' }],
  [52, 'line', 'turret', 2, { spread: 0.5, hold: 0.17, drop: 0.85, section: 'midboss' }],
  [54, 'echelon', 'grunt', 8, { gap: 12, section: 'midboss' }],
  [55, 'stream', 'popcorn', 10, { lane: 0.5, gap: 12, section: 'midboss' }],
  [55, 'line', 'heavy', 2, { spread: 0.6, drop: 0.85, section: 'midboss' }],
  [56, 'pincer', 'grunt', 8, { gap: 10, section: 'midboss' }],

  /* ---- press: post-midboss aggression. Overlapping streams, denser walls. ---- */
  [57, 'arc', 'grunt', 8, { gap: 12, section: 'press' }],
  [58, 'stream', 'popcorn', 10, { lane: 0.5, gap: 14, section: 'press' }],
  [59, 'echelon', 'grunt', 8, { gap: 12, drop: 0.4, pattern: 'spread', spreadDeg: 26, section: 'press' }],
  [60, 'wall', 'popcorn', 10, { spread: 0.88, gap: 4, section: 'press' }],
  [60, 'line', 'heavy', 2, { spread: 0.55, drop: 0.85, section: 'press' }],
  [62, 'stream', 'grunt', 6, { lane: 0.35, gap: 14, bulletSpeed: 3.2, section: 'press' }],
  [62, 'stream', 'grunt', 6, { lane: 0.65, gap: 14, bulletSpeed: 7.4, section: 'press' }],
  [63, 'pincer', 'grunt', 10, { gap: 8, section: 'press' }],
  [64, 'stream', 'grunt', 8, { lane: 0.5, gap: 12, drop: 0.45, section: 'press' }],
  [64, 'line', 'turret', 2, { spread: 0.5, drop: 0.85, section: 'press' }],
  [66, 'sweep', 'popcorn', 8, { spread: 0.82, gap: 6, section: 'press' }],
  [67, 'echelon', 'grunt', 10, { gap: 10, section: 'press' }],
  [68, 'stream', 'popcorn', 10, { lane: 0.4, gap: 12, section: 'press' }],
  [68, 'stream', 'popcorn', 10, { lane: 0.6, gap: 12, section: 'press' }],
  [70, 'line', 'heavy', 2, { spread: 0.6, drop: 0.85, section: 'press' }],
  [70, 'pincer', 'grunt', 8, { gap: 10, section: 'press' }],
  [71, 'arc', 'grunt', 8, { gap: 10, section: 'press' }],
  [72, 'wall', 'popcorn', 10, { spread: 0.9, gap: 4, section: 'press' }],
  [72, 'line', 'turret', 3, { spread: 0.6, drop: 0.9, section: 'press' }],
  [74, 'pincer', 'grunt', 10, { gap: 8, section: 'press' }],

  /* ---- crescendo: the run-in to the boss. Continuous walls + anchors. ---- */
  [75, 'wall', 'popcorn', 12, { spread: 0.9, gap: 3, section: 'crescendo' }],
  [76, 'echelon', 'grunt', 10, { gap: 9, section: 'crescendo' }],
  [77, 'stream', 'grunt', 10, { lane: 0.3, gap: 10, drop: 0.45, section: 'crescendo' }],
  [78, 'stream', 'popcorn', 10, { lane: 0.5, gap: 10, section: 'crescendo' }],
  [78, 'line', 'heavy', 3, { spread: 0.6, drop: 0.9, section: 'crescendo' }],
  [80, 'pincer', 'grunt', 12, { gap: 7, section: 'crescendo' }],
  [81, 'wall', 'popcorn', 12, { spread: 0.9, gap: 4, section: 'crescendo' }],
  [81, 'line', 'turret', 3, { spread: 0.6, drop: 0.9, section: 'crescendo' }],
  [82, 'arc', 'grunt', 10, { gap: 9, section: 'crescendo' }],
  [83, 'echelon', 'grunt', 10, { gap: 8, section: 'crescendo' }],
  [84, 'sweep', 'popcorn', 10, { spread: 0.86, gap: 5, section: 'crescendo' }],
  [85, 'pincer', 'grunt', 10, { gap: 7, section: 'crescendo' }],
  [85, 'line', 'heavy', 3, { spread: 0.6, drop: 0.9, section: 'crescendo' }],
  [86, 'wall', 'grunt', 10, { gap: 6, drop: 0.45, section: 'crescendo' }],
  [87, 'stream', 'grunt', 10, { lane: 0.5, gap: 8, drop: 0.45, section: 'crescendo' }],
  [88, 'pincer', 'grunt', 12, { gap: 6, section: 'crescendo' }],
  [89, 'line', 'heavy', 3, { spread: 0.6, drop: 0.9, section: 'crescendo' }],
];

/**
 * Per-stage flavour: the authored base timeline is re-timed to the stage length
 * and re-skinned, then the stage's own accent waves are appended. Accents are
 * raw rows in that stage's own bar timeline, so each stage keeps a signature
 * (stage 2 = heavy beam pressure, stage 3 = dense ring curtains).
 */
const STAGE_VARIANTS = {
  2: {
    baseBars: 90,
    countScale: 1.15,
    gapScale: 0.85,
    kindMap: { popcorn: ['popcorn', 'grunt'], grunt: 'grunt', turret: 'turret', heavy: 'heavy' },
    accents: [
      [38, 'stream', 'grunt', 8, { lane: 0.3, gap: 14, pattern: 'sweep', bulletSpeed: 4.4, section: 'ramp' }],
      [40, 'ring', 'popcorn', 12, { hold: 0.18, gap: 4, drop: 0.5, section: 'ramp' }],
      [42, 'line', 'turret', 3, { spread: 0.6, drop: 0.85, pattern: 'ring', hold: 0.17, holdFrames: 300, section: 'ramp' }],
      [50, 'flank', 'heavy', 4, { spread: 0.7, drop: 0.9, gap: 14, section: 'midboss' }],
      [54, 'wall', 'grunt', 12, { spread: 0.9, gap: 5, drop: 0.45, section: 'midboss' }],
      [62, 'stream', 'grunt', 8, { lane: 0.35, gap: 12, bulletSpeed: 3.0, section: 'press' }],
      [62, 'stream', 'grunt', 8, { lane: 0.65, gap: 12, bulletSpeed: 7.6, section: 'press' }],
      [66, 'pincer', 'heavy', 6, { gap: 10, drop: 0.9, section: 'press' }],
      [72, 'line', 'turret', 3, { spread: 0.6, drop: 0.9, pattern: 'spiralStep', section: 'press' }],
      [80, 'wall', 'popcorn', 14, { spread: 0.92, gap: 3, section: 'crescendo' }],
      [84, 'echelon', 'grunt', 12, { gap: 8, drop: 0.45, section: 'crescendo' }],
      [88, 'line', 'heavy', 4, { spread: 0.65, drop: 0.9, section: 'crescendo' }],
      [91, 'ring', 'grunt', 14, { hold: 0.18, gap: 3, drop: 0.5, section: 'crescendo' }],
    ],
  },
  3: {
    baseBars: 90,
    countScale: 1.3,
    gapScale: 0.75,
    kindMap: { popcorn: 'popcorn', grunt: ['grunt', 'popcorn'], turret: 'turret', heavy: ['heavy', 'turret'] },
    accents: [
      [40, 'arc', 'grunt', 10, { gap: 8, section: 'ramp' }],
      [44, 'line', 'turret', 3, { spread: 0.6, drop: 0.85, section: 'ramp' }],
      [48, 'stream', 'grunt', 10, { lane: 0.4, gap: 10, bulletSpeed: 3.2, section: 'ramp' }],
      [48, 'stream', 'grunt', 10, { lane: 0.6, gap: 10, bulletSpeed: 8.0, section: 'ramp' }],
      [52, 'ring', 'popcorn', 14, { hold: 0.18, gap: 3, drop: 0.5, section: 'ramp' }],
      [56, 'pincer', 'heavy', 6, { gap: 9, drop: 0.9, section: 'ramp' }],
      [58, 'wall', 'grunt', 12, { spread: 0.9, gap: 5, drop: 0.45, section: 'ramp' }],
      [62, 'flank', 'heavy', 6, { gap: 10, drop: 0.9, section: 'midboss' }],
      [66, 'line', 'turret', 4, { spread: 0.7, drop: 0.9, section: 'midboss' }],
      [70, 'echelon', 'grunt', 12, { gap: 8, drop: 0.45, section: 'midboss' }],
      [76, 'wall', 'popcorn', 14, { spread: 0.92, gap: 3, section: 'press' }],
      [82, 'pincer', 'grunt', 14, { gap: 6, drop: 0.45, section: 'press' }],
      [86, 'line', 'heavy', 4, { spread: 0.65, drop: 0.9, section: 'crescendo' }],
      [90, 'stream', 'grunt', 12, { lane: 0.5, gap: 7, drop: 0.45, section: 'crescendo' }],
      [94, 'wall', 'popcorn', 14, { spread: 0.92, gap: 3, section: 'crescendo' }],
      [96, 'pincer', 'heavy', 6, { gap: 8, drop: 0.9, section: 'crescendo' }],
    ],
  },
};

/** Flatten a (possibly nested) authored kind list into a cycle of names. */
function flattenKinds(kind) {
  if (!Array.isArray(kind)) return [kind];
  const out = [];
  for (const k of kind) for (const kk of flattenKinds(k)) out.push(kk);
  return out;
}

/** Rewrite authored kind names through a stage's flavour map. */
function mapKind(kind, map) {
  if (Array.isArray(kind)) return kind.map((k) => mapKind(k, map));
  if (!map) return kind;
  const mapped = map[kind];
  return mapped === undefined ? kind : mapped;
}

/** Re-time the authored base rows onto a longer/shorter stage, then add accents. */
function derivePlan(base, variant, rec) {
  const bars = Math.max(4, Math.ceil(num(rec.durationFrames, 5400) / BAR_FRAMES));
  const baseBars = Math.max(1, num(variant.baseBars, 90));
  const stretch = bars / baseBars;
  const rows = [];
  for (const row of base) {
    const [atBar, form, kind, count, extra] = row;
    const e = { ...(extra || {}) };
    if (Number.isFinite(e.gap)) e.gap = Math.max(3, Math.round(e.gap * num(variant.gapScale, 1)));
    if (Number.isFinite(e.holdFrames)) e.holdFrames = Math.round(e.holdFrames * 1.15);
    rows.push([
      atBar * stretch,
      form,
      flattenKinds(mapKind(kind, variant.kindMap)),
      clamp(Math.round(num(count, 4) * num(variant.countScale, 1)), 1, 24),
      e,
    ]);
  }
  for (const accent of variant.accents || []) rows.push(accent);
  return rows;
}

/**
 * Fallback plan for a stage record that has no authored timeline (a custom
 * stage object). Reads the record's own mix so it still escalates rather than
 * producing uniform noise.
 */
function fallbackPlan(rec) {
  const bars = Math.max(8, Math.ceil(num(rec.durationFrames, 5400) / BAR_FRAMES) - 1);
  const mix = mixOf(rec);
  const kinds = mix.map((m) => m.kind);
  const forms = ['stream', 'pincer', 'vee', 'echelon', 'flank', 'weaveLane', 'arc'];
  const rows = [];
  let n = 0;
  for (let bar = 0; bar < bars; bar += 3) {
    const early = bar < bars * 0.34;
    const mid = bar < bars * 0.7;
    const form = forms[n % forms.length];
    const kind = kinds[n % kinds.length];
    rows.push([bar, form, kind, early ? 3 : mid ? 5 : 6, { gap: early ? 30 : mid ? 20 : 14 }]);
    if (!early && bar % 6 === 0) rows.push([bar, 'wall', kinds[0], 6 + (mid ? 0 : 2), { gap: 8 }]);
    n++;
  }
  rows.push([bars * num(rec.midbossAt, 0.55) - 2, 'ring', kinds[0], 8, { gap: 5 }]);
  return rows;
}

/** The raw authored rows a stage number compiles from. */
function planRowsFor(index, rec) {
  if (index === 1) return STAGE1_PLAN;
  const variant = STAGE_VARIANTS[index];
  if (variant) return derivePlan(STAGE1_PLAN, variant, rec);
  return fallbackPlan(rec);
}

/** Turn `[atBar, form, kind, count, extra]` rows into objects. */
function parseRows(rows) {
  const out = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      const [atBar, form, kind, count, extra] = row;
      out.push({ atBar, form, kind, count: count ?? 4, ...(extra || {}) });
    } else if (row && typeof row === 'object') {
      out.push({ ...row });
    }
  }
  return out;
}

/* ------------------------------------------------------------- formations -- */

/**
 * Expand one wave entry into member slots: `{ x, delay, script, exitDir, lane }`.
 * The first member always lands on the wave's own frame, which is what keeps a
 * stage busy at every sampled second.
 */
function memberSlots(shape, count, entry, field) {
  const cx = num(field.centerX, 512);
  const width = num(field.width, 1024);
  const spread = clamp(num(entry.spread, 0.72), 0.12, 1);
  const half = (width * spread) / 2;
  const gap = Math.max(2, Math.round(num(entry.gap, FORM_GAP[shape] ?? 10)));
  const posAt = (i, n) => (n <= 1 ? cx : cx - half + (2 * half * i) / (n - 1));
  const lanePos = (t) => cx - half + 2 * half * clamp(num(t, 0.5), 0, 1);
  const slots = [];

  for (let i = 0; i < count; i++) {
    let x = cx;
    let delay = 0;
    let script = null;
    let exitDir = 0;

    switch (shape) {
      case 'stream': {
        // Single-file lane with a widening stagger so it reads as a column.
        const wobble = (i % 2 ? 1 : -1) * width * 0.05 * (1 + Math.floor(i / 2) * 0.18);
        x = lanePos(entry.lane) + wobble;
        delay = i * gap;
        script = 'dive';
        break;
      }
      case 'pincer': {
        // Paired entries from both flanks, converging on the centre.
        const side = i % 2 ? 1 : -1;
        const step = Math.floor(i / 2) + 1;
        x = cx + side * Math.min(width * 0.44, step * width * 0.16);
        delay = Math.floor(i / 2) * gap;
        script = 'crossDown';
        exitDir = side;
        break;
      }
      case 'vee': {
        const mid = (count - 1) / 2;
        x = cx + (i - mid) * width * 0.085;
        delay = Math.abs(i - mid) * gap;
        script = 'crossDown';
        break;
      }
      case 'weaveLane': {
        x = posAt(i, count);
        delay = i * gap;
        script = 'weave';
        break;
      }
      case 'column': {
        // Conga line cycling through five lanes.
        x = posAt(i % 5, 5);
        delay = i * gap;
        script = 'crossDown';
        break;
      }
      case 'flank': {
        const side = i % 2 ? 1 : -1;
        x = cx + side * half * 0.62;
        delay = Math.floor(i / 2) * gap;
        script = 'crossHold';
        exitDir = side;
        break;
      }
      case 'arc': {
        x = posAt(i, count);
        delay = i * gap;
        script = 'swoop';
        exitDir = x < cx ? -1 : 1;
        break;
      }
      case 'ring': {
        // Spawn points around an ellipse; small `gap` bursts them as a curtain.
        const angle = (Math.PI * 2 * i) / count + num(entry.phase, 0);
        x = cx + Math.cos(angle) * half;
        delay = i * gap;
        script = 'hover';
        break;
      }
      case 'echelon': {
        x = posAt(i, count);
        delay = i * gap;
        script = 'crossDown';
        break;
      }
      case 'sweep': {
        // Whole line at once, cutting across the screen.
        x = posAt(i, count);
        delay = 0;
        script = 'swoop';
        exitDir = x < cx ? -1 : 1;
        break;
      }
      case 'wall':
      case 'line':
      default: {
        x = posAt(i, count);
        delay = 0;
        script = 'crossDown';
        break;
      }
    }

    const r = 12;
    slots.push({
      x: clamp(x, r, width - r),
      delay,
      script,
      exitDir: exitDir || (x < cx ? -1 : 1),
      lane: i,
    });
  }
  return slots;
}

/** Build every enemy event for one authored wave. */
function buildWave(frame, entry, waveIndex, rng, field, section) {
  const kinds = flattenKinds(entry.kind && (Array.isArray(entry.kind) || typeof entry.kind === 'string')
    ? entry.kind
    : 'popcorn');
  const count = clamp(Math.round(num(entry.count, 4)), 1, 24);
  const shape = FORMATION_SHAPES.includes(entry.form) ? entry.form : 'line';
  const slots = memberSlots(shape, count, entry, field);
  const spawnY = num(field.spawnY, -48);
  const cx = num(field.centerX, 512);
  const height = num(field.height, 768);
  const events = [];

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const kind = kinds[i % kinds.length];
    const spec = (ENEMY_TABLE && ENEMY_TABLE[kind]) || {};
    const tune = (entry.tune && entry.tune[kind]) || {};
    const pick = (key) => (tune[key] !== undefined ? tune[key] : entry[key]);
    const radius = num(spec.r, 12);
    const x = clamp(slot.x, radius, num(field.width, 1024) - radius);
    const holdY = clamp(
      height * num(pick('hold'), FORM_HOLD[shape] ?? 0.26) + rng.float(-12, 20) + radius,
      radius,
      height * 0.62,
    );

    const opts = {
      script: entry.script || slot.script || 'dive',
      entryX: x,
      holdY,
      turnY: holdY * num(pick('turn'), 0.85),
      holdFrames: Math.round(num(pick('holdFrames'), 150 + rng.next() * 70)),
      sway: num(pick('sway'), shape === 'weaveLane' ? 2.2 : 1.1 + rng.next() * 1.4),
      swayPhase: rng.angle(),
      drift: num(pick('drift'), (x < cx ? -1 : 1) * (0.15 + rng.next() * 0.5) * num(spec.speed, 2) * 0.4),
      exitDir: num(pick('exitDir'), slot.exitDir),
      fireDelay: Math.round(num(pick('fireDelay'), num(spec.fireCd, 60) * 0.35 + rng.next() * 20)),
      wave: waveIndex,
      lane: i,
      formation: shape,
      section,
    };
    for (const key of PASSTHROUGH) {
      if (entry[key] !== undefined || tune[key] !== undefined) opts[key] = pick(key);
    }

    events.push(enemyEvent(kind, x, spawnY - slot.delay * 0.5, opts, frame + slot.delay));
  }
  return events;
}

/* ------------------------------------------------------------------- stage */

/**
 * Compile a stage record into a deterministic timeline.
 *
 * @param {number|object} stage 1-based stage number (or a full record)
 * @param {object} [opts] `{ seed }` lets the caller fold the game seed into the
 *   per-member jitter; the layout stays identical for an identical seed.
 */
export function createStage(stage = 1, opts = {}) {
  const rec = tableFor(stage);
  const field = fieldCfg();
  const index = Math.max(1, Math.floor(num(rec.stage, 1)));
  const durationFrames = Math.max(BAR_FRAMES, Math.floor(num(rec.durationFrames, 5400)));
  const midbossAt = clamp(num(rec.midbossAt, 0.55), 0.05, 0.95);
  const bossAt = clamp(num(rec.bossAt, 1), 0.2, 1);

  const midbossFrame = Math.min(durationFrames - 1, Math.floor(durationFrames * midbossAt));
  // The boss must land *inside* the loop `f < durationFrames`, so it sits on the
  // final frame of the stage rather than one past it.
  const bossFrame = Math.min(durationFrames - 1, Math.max(midbossFrame + BAR_FRAMES, Math.floor(durationFrames * bossAt) - 1));
  const bars = Math.max(1, Math.ceil(durationFrames / BAR_FRAMES));

  const seed = (num(opts.seed, 0) ^ Math.imul(index, 0x9e3779b1)) >>> 0;
  const rng = createRng(seed);
  const mix = mixOf(rec);
  const interval = clamp(
    Math.round(num(rec.spawnInterval, 42)),
    num(pacingCfg().minSpawnGapFrames, 12),
    num(pacingCfg().maxSpawnGapFrames, 96),
  );

  /** frame -> events, built once; `at()` is a pure lookup afterwards. */
  const schedule = new Map();
  const waves = [];
  const marks = [];
  const sectionMarks = new Set();

  const push = (frame, events) => {
    if (frame < 0 || frame >= durationFrames) return;
    const list = schedule.get(frame);
    if (list) {
      for (const ev of events) list.push(ev);
    } else {
      schedule.set(frame, events.slice());
    }
  };

  const plan = parseRows(planRowsFor(index, rec));
  let waveIndex = 0;

  for (const entry of plan) {
    const frame = Math.max(0, Math.round(num(entry.atBar, 0) * BAR_FRAMES));
    if (frame >= bossFrame) continue; // the stage belongs to the boss from here on
    const section = typeof entry.section === 'string' ? entry.section : 'wave';
    const events = buildWave(frame, entry, waveIndex, rng, field, section);
    if (events.length === 0) continue;
    push(frame, events);
    waves.push({
      frame,
      bar: Math.round(frame / BAR_FRAMES),
      wave: waveIndex,
      label: section,
      section,
      form: events[0] ? events[0].opts.formation : 'line',
      kinds: flattenKinds(entry.kind || 'popcorn').join('/'),
      count: events.length,
    });
    if (!sectionMarks.has(section)) {
      sectionMarks.add(section);
      marks.push({ frame, kind: 'section', label: section });
    }
    waveIndex++;
  }

  // Fallback pressure: if an authored plan is sparse (custom stage records), make
  // sure every bar before the boss still sees at least a straggler.
  const minGap = num(pacingCfg().minSpawnGapFrames, 12);
  if (waves.length < bars * 0.5) {
    const kinds = mixOf(rec).map((m) => m.kind);
    for (let bar = 0; bar < bars; bar++) {
      const frame = bar * BAR_FRAMES;
      if (frame >= bossFrame) break;
      if (schedule.has(frame)) continue;
      const kind = kinds[bar % kinds.length];
      const fallback = buildWave(
        frame,
        { form: 'stream', kind, count: 1, gap: minGap, lane: 0.35 + 0.3 * ((bar % 3) / 2) },
        waveIndex++,
        rng,
        field,
        'trickle',
      );
      push(frame, fallback);
      waves.push({ frame, bar, wave: waveIndex - 1, label: 'trickle', section: 'trickle', form: 'stream', kinds: kind, count: fallback.length });
    }
  }

  // Midboss: the timeline keeps trickling escorts (authored in the plan), then
  // announces the anchor.
  const midboss = {
    kind: 'midboss',
    type: 'midboss',
    enemy: 'midboss',
    x: field.centerX,
    y: num(field.spawnY, -48) - 48,
    frame: midbossFrame,
    opts: {
      script: 'midboss',
      entryX: field.centerX,
      holdY: num(field.height, 768) * 0.18,
      holdFrames: Math.round(BAR_FRAMES * 12),
      sway: 2.6,
      swayPhase: 0,
      pattern: 'spiralStep',
      drop: 1,
      wave: waveIndex,
      formation: 'midboss',
      section: 'midboss',
    },
  };

  const boss = {
    kind: 'boss',
    type: 'boss',
    enemy: 'boss',
    stage: index,
    x: field.centerX,
    y: num(field.spawnY, -48) - 32,
    frame: bossFrame,
    opts: {
      stage: index,
      script: 'boss',
      phases: Math.max(num(rec.bossPhases, num(BALANCE && BALANCE.bossPhases, 3)), 3),
      hp: num(rec.bossHp, num(BALANCE && BALANCE.boss && BALANCE.boss.hp, 3200)),
      wave: waveIndex,
      formation: 'boss',
      section: 'boss',
    },
  };

  push(midbossFrame, [midboss]);
  push(bossFrame, [boss]);

  marks.push(
    { frame: Math.max(0, midbossFrame - 150), kind: 'midbossWarning' },
    { frame: Math.max(0, midbossFrame), kind: 'midboss' },
    { frame: Math.max(0, bossFrame - 180), kind: 'bossWarning' },
    { frame: bossFrame, kind: 'boss' },
  );
  marks.sort((a, b) => a.frame - b.frame);

  const scheduleList = [...schedule.entries()]
    .map(([frame, events]) => ({ frame, events }))
    .sort((a, b) => a.frame - b.frame);

  const bossPhases = Math.max(
    Math.round(num(rec.bossPhases, num(BALANCE && BALANCE.bossPhases, 3))),
    Math.round(num(BALANCE && BALANCE.bossPhases, 3)),
    3,
  );

  const stageObj = {
    /** 1-based stage number and presentation metadata. */
    stage: index,
    index,
    name: typeof rec.name === 'string' ? rec.name : `STAGE ${index}`,
    backdrop: rec.backdrop || 'shelf',
    tint: rec.tint || '#7dff8a',
    tempo: num(rec.tempo, 132),

    /** Timeline metrics. */
    durationFrames,
    durationSeconds: durationFrames / 60,
    barFrames: BAR_FRAMES,
    bars,
    spawnInterval: interval,
    midbossAt,
    bossAt,
    midbossFrame,
    bossFrame,
    bossPhases,
    bossHp: num(rec.bossHp, 3200),
    rankStart: clamp(num(rec.rankStart, num(BALANCE && BALANCE.rank && BALANCE.rank.start, 0.15)), 0, 1),
    density: num(rec.density, 1),
    seed,

    /** Data the renderer/HUD can read without touching the schedule. */
    waves,
    marks,
    schedule: scheduleList,
    midboss,
    boss,

    /**
     * Events scheduled on an exact frame. Always returns an array (never null),
     * and always the same array for the same frame.
     */
    at(frame) {
      const f = Math.floor(num(frame, -1));
      if (f < 0 || f >= durationFrames) return EMPTY_EVENTS;
      return schedule.get(f) || EMPTY_EVENTS;
    },

    /** Frame index a progress fraction maps to (clamped into the stage). */
    frameAt(progress) {
      return clamp(Math.floor(clamp(num(progress, 0), 0, 1) * (durationFrames - 1)), 0, durationFrames - 1);
    },

    /** 0..1 progress through the stage, used by the backdrop + boss timing. */
    progress(frame) {
      return clamp(num(frame, 0) / durationFrames, 0, 1);
    },

    /** True while the boss has been scheduled but the stage is still running. */
    bossDue(frame) {
      return num(frame, 0) >= bossFrame;
    },

    /** True while the midboss window is open (midboss through to the boss). */
    midbossActive(frame) {
      const f = num(frame, 0);
      return f >= midbossFrame && f < bossFrame;
    },

    /** Frames a stage runs for, as a plain timer helper for the game loop. */
    remaining(frame) {
      return Math.max(0, durationFrames - num(frame, 0));
    },
  };

  return stageObj;
}

/** Number of events a stage schedules in total (handy for tests + tooling). */
export function countEvents(stage) {
  let total = 0;
  for (let f = 0; f < stage.durationFrames; f++) total += stage.at(f).length;
  return total;
}

export default createStage;
