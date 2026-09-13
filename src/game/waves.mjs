/**
 * waves.mjs — the stage timeline: a deterministic spawn schedule.
 *
 * Pure simulation code: no DOM, no three, no timers. `createStage(n)` compiles
 * STAGE_TABLE[n] into a fixed schedule of spawn events and hands the game layer a
 * single lookup:
 *
 *   for (let f = 0; f < stage.durationFrames; f++)
 *     for (const ev of stage.at(f)) spawn(ev);
 *
 * The schedule is authored on a **one-second bar grid** (60 frames at the sim's
 * 60 Hz). Every bar opens with a formation, and further beats land on multiples of
 * the stage's `spawnInterval` inside the bar, which keeps pressure continuous —
 * a stage never drifts into dead air — while staying trivially replayable: the
 * same stage number and seed always produce byte-identical events.
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
export const WAVE_SCRIPTS = ['dive', 'crossDown', 'weave', 'hover', 'swoop', 'crossHold'];

/** Formation recipes, all of which place at least one enemy on the beat frame. */
export const FORMATION_SHAPES = ['line', 'stream', 'pincer', 'vee', 'weaveLane', 'column'];

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

const HEAVY_KINDS = ['turret', 'heavy', 'midboss', 'boss'];

/** One formation member: an enemy event ready for `createEnemy`. */
function enemyEvent(kind, x, y, opts, frame) {
  const spec = (ENEMY_TABLE && ENEMY_TABLE[kind]) || {};
  return {
    kind: 'enemy',
    type: kind,
    enemy: kind,
    x,
    y,
    frame,
    opts: {
      sprite: spec.sprite || kind,
      frame,
      hp: spec.hp,
      points: spec.points,
      script: opts.script,
      entryX: opts.entryX,
      holdY: opts.holdY,
      turnY: opts.turnY,
      holdFrames: opts.holdFrames,
      sway: opts.sway,
      swayPhase: opts.swayPhase,
      drift: opts.drift,
      exitDir: opts.exitDir,
      fireDelay: opts.fireDelay,
      wave: opts.wave,
      lane: opts.lane,
      formation: opts.formation,
    },
  };
}

/**
 * Expand one formation into concrete events. Members are spread over a handful of
 * consecutive frames so entries read as a stream rather than a wall; the first
 * member always sits on the beat frame itself, which is what keeps a stage busy at
 * every sampled second.
 */
function buildFormation(rec, beat, opts) {
  const field = fieldCfg();
  const rng = opts.rng;
  const mix = opts.mix;
  const density = clamp(num(rec.density, 1), 0.4, 3);
  const primary = opts.primary;
  const shape = primary ? rng.pick(FORMATION_SHAPES) : rng.pick(['stream', 'column', 'weaveLane']);
  const script = rng.pick(WAVE_SCRIPTS);
  const spawnY = num(field.spawnY, -48);
  const span = field.width * 0.72;
  const events = [];

  const size = primary
    ? clamp(Math.round(num(opts.size, 3) * density), 1, 8)
    : clamp(Math.round(1 + density * 0.5), 1, 3);

  const laneAt = (i, n) => {
    const t = n <= 1 ? 0.5 : i / (n - 1);
    return field.centerX - span / 2 + span * t;
  };

  let turrets = 0;
  const kindFor = (i) => {
    let kind = pickWeighted(mix, rng);
    if (HEAVY_KINDS.includes(kind)) {
      // One anchor unit per formation at most, and never a boss-class enemy
      // outside the boss pipeline.
      if (turrets >= 1 || kind === 'midboss' || kind === 'boss') {
        const light = mix.filter((m) => !HEAVY_KINDS.includes(m.kind));
        kind = pickWeighted(light.length ? light : [{ kind: 'grunt', weight: 1 }], rng);
      } else {
        turrets++;
      }
    }
    return kind;
  };

  for (let i = 0; i < size; i++) {
    let x = field.centerX;
    let delay = 0;
    let memberScript = script;

    switch (shape) {
      case 'line':
        x = laneAt(i, size);
        delay = 0;
        break;
      case 'stream':
        x = laneAt(i % Math.max(1, size), Math.max(1, size)) + field.width * 0.08 * (i % 2 ? 1 : -1);
        delay = i * 6;
        memberScript = 'dive';
        break;
      case 'pincer': {
        const side = i % 2 === 0 ? -1 : 1;
        const step = Math.floor(i / 2) + 1;
        x = field.centerX + side * Math.min(field.width * 0.42, step * field.width * 0.16);
        delay = 0;
        memberScript = 'crossDown';
        break;
      }
      case 'vee':
        x = field.centerX + (i - (size - 1) / 2) * field.width * 0.11;
        delay = Math.abs(i - (size - 1) / 2) * 3;
        memberScript = 'crossDown';
        break;
      case 'weaveLane':
        x = laneAt(i, size);
        delay = i * 8;
        memberScript = 'weave';
        break;
      default: // column: single-file entry that reads as a conga line
        x = laneAt((opts.index + i) % 5, 5);
        delay = i * 4;
        memberScript = 'crossDown';
        break;
    }

    const kind = kindFor(i);
    const spec = (ENEMY_TABLE && ENEMY_TABLE[kind]) || {};
    const holdY = clamp(
      num(field.height, 768) * (0.16 + 0.22 * rng.next()) + (spec.r || 12),
      spec.r || 12,
      num(field.height, 768) * 0.62,
    );
    const event = enemyEvent(
      kind,
      clamp(x, spec.r || 12, field.width - (spec.r || 12)),
      spawnY - delay * 0.5,
      {
        script: memberScript,
        entryX: clamp(x, spec.r || 12, field.width - (spec.r || 12)),
        holdY,
        turnY: holdY * 0.85,
        holdFrames: Math.round(150 + 90 * rng.next()),
        sway: 1.1 + rng.next() * 1.9,
        swayPhase: rng.angle(),
        drift: (rng.next() - 0.5) * 0.9 * (spec.speed || 2),
        exitDir: x < field.centerX ? -1 : 1,
        fireDelay: Math.round(num(spec.fireCd, 60) * 0.45 + rng.next() * 30),
        wave: opts.index,
        lane: i,
        formation: shape,
      },
      beat + delay,
    );
    events.push(event);
  }
  return events;
}

/* ------------------------------------------------------------------- stage */

/**
 * Compile a stage record into a deterministic timeline.
 *
 * @param {number|object} stage 1-based stage number (or a full record)
 * @param {object} [opts] `{ seed }` lets the caller fold the game seed into the
 *   formation lottery; the layout stays identical for an identical seed.
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

  const push = (frame, events) => {
    if (frame < 0 || frame >= durationFrames) return;
    const list = schedule.get(frame);
    if (list) {
      for (const ev of events) list.push(ev);
    } else {
      schedule.set(frame, events.slice());
    }
  };

  // Beat offsets inside a bar: the bar line first, then every spawnInterval.
  const beatOffsets = [0];
  for (let t = interval; t < BAR_FRAMES; t += interval) beatOffsets.push(t);

  let formationIndex = 0;
  for (let bar = 0; bar < bars; bar++) {
    const barFrame = bar * BAR_FRAMES;
    if (barFrame >= durationFrames) break;
    if (barFrame >= bossFrame) break; // the stage belongs to the boss from here on

    for (let b = 0; b < beatOffsets.length; b++) {
      const beat = barFrame + beatOffsets[b];
      if (beat >= bossFrame || beat >= durationFrames) continue;
      const primary = b === 0;
      const events = buildFormation(rec, beat, {
        rng,
        mix,
        primary,
        index: formationIndex,
        size: primary ? 2 + Math.round(rng.next() * 2) : 1,
      });
      formationIndex++;
      push(beat, events);
      waves.push({
        frame: beat,
        bar,
        beat: b,
        primary,
        count: events.length,
        shape: events[0] ? events[0].opts.formation : 'line',
      });
    }
  }

  // Midboss: the timeline keeps trickling escorts, then announces the anchor.
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
      wave: formationIndex,
      formation: 'midboss',
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
      wave: formationIndex,
      formation: 'boss',
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
