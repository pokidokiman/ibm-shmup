/**
 * src/audio/sfx.mjs — the 5153's one-watt speaker, synthesised in software.
 *
 * Every sound in the game is a handful of WebAudio oscillators, a shared noise
 * buffer and a couple of envelope ramps. There is no sample data anywhere: the
 * module owns one `AudioContext`, one noise buffer and one software tube
 * saturator, and it builds short-lived voices on top of them.
 *
 * Signal flow (built lazily, on the first sound or on `unlock()`):
 *
 *   voice -> [ stereo panner ] -> bus -> duck -> master -> shaper -> limiter -> out
 *
 *   • `bus`    fixed unity sum point for every voice.
 *   • `duck`   briefly pulls the whole mix down so bombs and deaths stay clear.
 *   • `master` user volume, and the mute switch (0 while muted).
 *   • `shaper` `tanh` curve: the soft, slightly fuzzy edge of a small speaker.
 *   • `limiter` a compressor so a wall of popcorn deaths cannot clip the output.
 *
 * The module is browser-only (it is part of `src/audio`), but it never touches
 * the document and it degrades to a silent no-op if no WebAudio implementation
 * exists, so a headless shell can hold onto an `sfx` handle safely.
 *
 * Wiring from the shell:
 *
 *   const sfx = createSfx({ volume: 0.7 });
 *   input.onFirstGesture(() => sfx.unlock());
 *   // once per rendered frame, after the simulation has run:
 *   sfx.drain(game.events);          // reads only; the shell still clears the queue
 *
 * Individual voices are also callable directly (`sfx.shot({ power: 3 })`), and
 * the first positional argument of each is the playfield x it happened at, so
 * the mix pans with the action.
 */
import { MathUtils } from 'three';
import { FIELD } from '../game/config.mjs';

/** Voices the shell may trigger by name; also the event-name fallback. */
export const SFX_NAMES = Object.freeze([
  'shot',
  'hit',
  'boom',
  'pickup',
  'bomb',
  'graze',
  'extend',
  'bossPhase',
  'playerHit',
]);

/**
 * Minimum spacing between two instances of the same voice, in seconds. Popcorn
 * enemies die in clusters; without this a single frame would spawn dozens of
 * identical explosions and the limiter would pump.
 */
export const SFX_MIN_GAP = Object.freeze({
  shot: 0.02,
  hit: 0.025,
  boom: 0.05,
  pickup: 0.04,
  bomb: 0,
  graze: 0.035,
  extend: 0.2,
  bossPhase: 0.25,
  playerHit: 0.15,
});

/** Tuning defaults; every value is overridable through `createSfx(options)`. */
export const SFX_DEFAULTS = Object.freeze({
  /** Master volume, 0..1. */
  volume: 0.7,
  /** Amount of `tanh` drive on the master bus, 0 = clean. */
  saturation: 0.35,
  /** Hard ceiling on simultaneously sounding voices. */
  maxVoices: 24,
  /** Scheduling head-room in seconds, keeps ramps out of the past. */
  lookahead: 0.0015,
  /** Length of the shared noise buffer, in seconds. */
  noiseSeconds: 2,
  /** Start muted (the shell unmutes after the first user gesture). */
  muted: false,
});

/**
 * Map simulation event types (`game.events[].type`) onto voices. Anything the
 * simulation emits that has no sound simply maps to `undefined` and is skipped.
 */
export const EVENT_VOICES = Object.freeze({
  shot: 'shot',
  enemyHit: 'hit',
  enemyKilled: 'boom',
  playerHit: 'playerHit',
  powerup: 'pickup',
  bomb: 'bomb',
  bossPhase: 'bossPhase',
  extend: 'extend',
  graze: 'graze',
});

/* ------------------------------------------------------------------ helpers */

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Soft-clipping transfer curve for the master `WaveShaperNode`. `amount` 0
 * leaves the signal alone (identity-ish slope), 1 is a hard-ish squelch.
 */
export function saturationCurve(amount) {
  const drive = 1 + MathUtils.clamp(num(amount, SFX_DEFAULTS.saturation), 0, 1) * 14;
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

/**
 * A reusable noise buffer: mostly white, with a slow brown component folded in
 * so it reads as "dust and debris" rather than pure hiss. Normalised to just
 * under unity so the per-voice gains stay meaningful.
 */
export function createNoiseBuffer(ctx, seconds = SFX_DEFAULTS.noiseSeconds) {
  const length = Math.max(1, Math.floor(num(seconds, 1) * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let brown = 0;
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    brown = (brown + 0.016 * white) / 1.016;
    const v = white * 0.82 + brown * 4.5;
    data[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const k = 0.94 / peak;
    for (let i = 0; i < length; i++) data[i] *= k;
  }
  return buffer;
}

/** Find the platform's AudioContext constructor, or null outside a browser. */
function audioContextCtor() {
  if (typeof window !== 'undefined') return window.AudioContext || window.webkitAudioContext || null;
  if (typeof AudioContext !== 'undefined') return AudioContext;
  if (typeof webkitAudioContext !== 'undefined') return webkitAudioContext;
  return null;
}

/* --------------------------------------------------------------------- sfx */

/**
 * Build the sound engine.
 *
 * @param {object} [options]
 * @param {number} [options.volume=0.7] master volume, 0..1
 * @param {number} [options.saturation=0.35] master tube drive, 0..1
 * @param {number} [options.maxVoices=24] simultaneous voice cap
 * @param {boolean} [options.muted=false] start silent
 * @param {number} [options.fieldWidth=FIELD.width] playfield width used to pan
 * @returns {{
 *   context: AudioContext|null,
 *   names: readonly string[],
 *   unlock(): Promise<boolean>,
 *   suspend(): Promise<boolean>,
 *   isReady(): boolean,
 *   isMuted(): boolean,
 *   setMuted(on: boolean): boolean,
 *   toggleMute(): boolean,
 *   getVolume(): number,
 *   setVolume(v: number): number,
 *   play(name: string, spec?: object): boolean,
 *   handleEvent(evt: object): boolean,
 *   drain(events: Array<object>): number,
 *   shot(spec?: object): boolean,
 *   hit(spec?: object): boolean,
 *   boom(spec?: object): boolean,
 *   pickup(spec?: object): boolean,
 *   bomb(spec?: object): boolean,
 *   graze(spec?: object): boolean,
 *   extend(spec?: object): boolean,
 *   bossPhase(spec?: object): boolean,
 *   playerHit(spec?: object): boolean,
 *   dispose(): void,
 * }}
 */
export function createSfx(options = {}) {
  const opts = {
    volume: MathUtils.clamp(num(options.volume, SFX_DEFAULTS.volume), 0, 1),
    saturation: MathUtils.clamp(num(options.saturation, SFX_DEFAULTS.saturation), 0, 1),
    maxVoices: Math.max(1, Math.floor(num(options.maxVoices, SFX_DEFAULTS.maxVoices))),
    lookahead: Math.max(0, num(options.lookahead, SFX_DEFAULTS.lookahead)),
    noiseSeconds: Math.max(0.25, num(options.noiseSeconds, SFX_DEFAULTS.noiseSeconds)),
    fieldWidth: Math.max(1, num(options.fieldWidth, FIELD.width)),
    muted: options.muted === true,
  };

  /** The playfield x that corresponds to the right speaker; pans are centred on it. */
  const halfField = opts.fieldWidth / 2;

  let ctx = null;
  let bus = null;
  let duckGain = null;
  let master = null;
  let shaper = null;
  let limiter = null;
  let noiseBuffer = null;

  const live = new Set();
  const lastAt = Object.create(null);
  let volume = opts.volume;
  let muted = opts.muted;
  let disposed = false;

  /* ------------------------------------------------------------- bus build */

  function buildGraph() {
    bus = ctx.createGain();
    bus.gain.value = 1;

    duckGain = ctx.createGain();
    duckGain.gain.value = 1;

    master = ctx.createGain();
    master.gain.value = muted ? 0.0001 : volume;

    shaper = ctx.createWaveShaper();
    shaper.curve = saturationCurve(opts.saturation);
    shaper.oversample = '2x';

    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;

    bus.connect(duckGain);
    duckGain.connect(master);
    master.connect(shaper);
    shaper.connect(limiter);
    limiter.connect(ctx.destination);

    noiseBuffer = createNoiseBuffer(ctx, opts.noiseSeconds);
  }

  function ensure() {
    if (disposed) return null;
    if (ctx) return ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (err) {
      ctx = null;
      return null;
    }
    buildGraph();
    return ctx;
  }

  /** Apply the current volume/mute state to an already-built master gain. */
  function applyLevel(glide = 0.02) {
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const target = muted ? 0.0001 : Math.max(0.0001, volume);
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(target, t, Math.max(0.005, glide));
  }

  /* --------------------------------------------------------------- routing */

  /** Per-voice output node: a stereo panner when the platform has one. */
  function panTo(pan) {
    const p = MathUtils.clamp(num(pan, 0), -1, 1);
    if (p === 0 || typeof ctx.createStereoPanner !== 'function') return bus;
    const node = ctx.createStereoPanner();
    node.pan.value = p;
    node.connect(bus);
    return node;
  }

  function track(source) {
    live.add(source);
    source.onended = () => {
      live.delete(source);
      if (typeof source.disconnect === 'function') source.disconnect();
    };
  }

  function makeFilter(spec, t0, dur) {
    const filter = ctx.createBiquadFilter();
    filter.type = spec.type || 'lowpass';
    const f0 = Math.max(20, num(spec.freq, 1000));
    filter.frequency.setValueAtTime(f0, t0);
    if (spec.freqEnd !== undefined) {
      const f1 = Math.max(20, num(spec.freqEnd, f0));
      filter.frequency.exponentialRampToValueAtTime(f1, t0 + Math.max(0.01, dur));
    }
    if (spec.q !== undefined) filter.Q.value = Math.max(0.0001, num(spec.q, 1));
    if (spec.gain !== undefined) filter.gain.value = num(spec.gain, 0);
    return filter;
  }

  /** Attack/decay gain shape shared by every voice. */
  function envelope(param, t0, spec) {
    const peak = MathUtils.clamp(num(spec.peak, 0.2), 0.0001, 1);
    const attack = Math.max(0.001, num(spec.attack, 0.004));
    const hold = Math.max(0, num(spec.hold, 0));
    const end = Math.max(attack + 0.012, attack + hold + Math.max(0.012, num(spec.dur, 0.1)));
    param.setValueAtTime(0.0001, t0);
    param.linearRampToValueAtTime(peak, t0 + attack);
    if (hold > 0) param.setValueAtTime(peak, t0 + attack + hold);
    param.exponentialRampToValueAtTime(0.0001, t0 + end);
    return end;
  }

  function startTime(spec) {
    return ctx.currentTime + opts.lookahead + Math.max(0, num(spec.delay, 0));
  }

  /** One oscillator voice with an optional moving filter. */
  function blip(spec) {
    const t0 = startTime(spec);
    const dur = Math.max(0.015, num(spec.dur, 0.08));
    const osc = ctx.createOscillator();
    osc.type = spec.wave || 'square';
    const f0 = Math.max(8, num(spec.freq, 440));
    osc.frequency.setValueAtTime(f0, t0);
    if (spec.freqEnd !== undefined && num(spec.freqEnd, f0) !== f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(8, num(spec.freqEnd, f0)), t0 + dur);
    }
    if (spec.detune !== undefined) osc.detune.value = num(spec.detune, 0);

    let head = osc;
    if (spec.filter) {
      const filter = makeFilter(spec.filter, t0, dur);
      head.connect(filter);
      head = filter;
    }
    const gain = ctx.createGain();
    envelope(gain.gain, t0, { ...spec, dur });
    head.connect(gain);
    gain.connect(panTo(spec.pan));

    track(osc);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /** One noise voice (looping slice of the shared buffer) through a filter. */
  function noiseBurst(spec) {
    const t0 = startTime(spec);
    const dur = Math.max(0.015, num(spec.dur, 0.12));
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    if (spec.playbackRate !== undefined) src.playbackRate.value = Math.max(0.05, num(spec.playbackRate, 1));

    let head = src;
    if (spec.filter) {
      const filter = makeFilter(spec.filter, t0, dur);
      head.connect(filter);
      head = filter;
    }
    const gain = ctx.createGain();
    envelope(gain.gain, t0, { ...spec, dur });
    head.connect(gain);
    gain.connect(panTo(spec.pan));

    track(src);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.03);
  }

  /** Pull the whole mix down and let it swell back: used by bombs and deaths. */
  function duck(amount, seconds) {
    if (!duckGain) return;
    const t = ctx.currentTime;
    const floor = MathUtils.clamp(num(amount, 0.4), 0.0001, 1);
    const span = Math.max(0.08, num(seconds, 0.5));
    duckGain.gain.cancelScheduledValues(t);
    duckGain.gain.setValueAtTime(duckGain.gain.value, t);
    duckGain.gain.linearRampToValueAtTime(floor, t + 0.02);
    duckGain.gain.linearRampToValueAtTime(1, t + span);
  }

  /**
   * Gate a voice: guarantees a context, honours the voice ceiling, and applies
   * the per-name minimum spacing. Returns false when the voice is dropped.
   */
  function begin(name, gap) {
    if (!ensure()) return false;
    if (live.size >= opts.maxVoices) return false;
    const t = ctx.currentTime;
    const prev = lastAt[name];
    if (gap > 0 && prev !== undefined && t - prev < gap) return false;
    lastAt[name] = t;
    return true;
  }

  /* ---------------------------------------------------------------- voices */

  /** Player shot: a bright two-oscillator chirp that rises with the power tier. */
  function shot(spec = {}) {
    if (!begin('shot', SFX_MIN_GAP.shot)) return false;
    const power = MathUtils.clamp(num(spec.power, 1), 1, 4);
    const pan = num(spec.pan, 0) * 0.5;
    const f = 640 + power * 118;
    blip({ wave: 'square', freq: f, freqEnd: f * 0.46, dur: 0.055, peak: 0.15, attack: 0.002, pan });
    blip({
      wave: 'triangle',
      freq: f * 2.4,
      freqEnd: f * 1.15,
      dur: 0.035,
      peak: 0.055,
      attack: 0.001,
      pan,
      filter: { type: 'highpass', freq: 900 },
    });
    noiseBurst({ dur: 0.018, peak: 0.04, attack: 0.001, pan, filter: { type: 'highpass', freq: 2600 } });
    return true;
  }

  /** Bullet impact on an enemy: dry, mid-band tick. */
  function hit(spec = {}) {
    if (!begin('hit', SFX_MIN_GAP.hit)) return false;
    const pan = num(spec.pan, 0) * 0.6;
    blip({
      wave: 'sawtooth',
      freq: 320,
      freqEnd: 130,
      dur: 0.075,
      peak: 0.1,
      attack: 0.001,
      pan,
      filter: { type: 'bandpass', freq: 900, q: 2.2 },
    });
    noiseBurst({ dur: 0.05, peak: 0.07, attack: 0.001, pan, filter: { type: 'highpass', freq: 1800 } });
    return true;
  }

  /** Explosion. `size` (0.4..3) scales length, weight and level. */
  function boom(spec = {}) {
    if (!begin('boom', SFX_MIN_GAP.boom)) return false;
    const size = MathUtils.clamp(num(spec.size, 1), 0.4, 3);
    const pan = num(spec.pan, 0) * 0.8;
    const dur = 0.26 + 0.2 * size;
    noiseBurst({
      dur,
      peak: Math.min(0.4, 0.22 * size),
      attack: 0.005,
      pan,
      filter: { type: 'lowpass', freq: 2400, freqEnd: 140, q: 0.9 },
    });
    blip({
      wave: 'sine',
      freq: 130 / size,
      freqEnd: 32,
      dur: dur * 1.15,
      peak: Math.min(0.32, 0.24 * size),
      attack: 0.004,
      pan,
      filter: { type: 'lowpass', freq: 320 },
    });
    return true;
  }

  /** Pickup jingle whose shape depends on the drop kind. */
  function pickup(spec = {}) {
    if (!begin('pickup', SFX_MIN_GAP.pickup)) return false;
    const pan = num(spec.pan, 0) * 0.5;
    const kind = typeof spec.kind === 'string' ? spec.kind : 'power';
    const seq =
      kind === 'life'
        ? [523, 659, 784, 1047, 1319]
        : kind === 'bomb'
          ? [330, 440, 587]
          : kind === 'score'
            ? [988, 1319]
            : [660, 880, 1320];
    const step = kind === 'life' ? 0.072 : 0.048;
    for (let i = 0; i < seq.length; i++) {
      blip({
        wave: 'triangle',
        freq: seq[i],
        freqEnd: seq[i] * 1.02,
        dur: step * 1.6,
        peak: 0.11,
        attack: 0.002,
        delay: i * step,
        pan,
        filter: { type: 'lowpass', freq: 5200 },
      });
    }
    return true;
  }

  /** Screen-clearing bomb: long filtered sweep plus a sub-bass drop and duck. */
  function bomb(spec = {}) {
    if (!begin('bomb', SFX_MIN_GAP.bomb)) return false;
    const pan = num(spec.pan, 0) * 0.3;
    noiseBurst({
      dur: 0.9,
      peak: 0.38,
      attack: 0.01,
      pan,
      filter: { type: 'lowpass', freq: 6000, freqEnd: 90, q: 1.1 },
    });
    blip({
      wave: 'sawtooth',
      freq: 1400,
      freqEnd: 46,
      dur: 0.85,
      peak: 0.2,
      attack: 0.006,
      pan,
      filter: { type: 'lowpass', freq: 2600, freqEnd: 220 },
    });
    blip({ wave: 'sine', freq: 90, freqEnd: 28, dur: 1.1, peak: 0.28, attack: 0.01, pan });
    duck(0.3, 0.75);
    return true;
  }

  /** Graze: the faintest voice in the mix, deliberately easy to miss. */
  function graze(spec = {}) {
    if (!begin('graze', SFX_MIN_GAP.graze)) return false;
    const pan = num(spec.pan, 0);
    blip({
      wave: 'sine',
      freq: 2400,
      freqEnd: 3100,
      dur: 0.03,
      peak: 0.05,
      attack: 0.001,
      pan,
      filter: { type: 'highpass', freq: 1600 },
    });
    noiseBurst({ dur: 0.018, peak: 0.028, attack: 0.001, pan, filter: { type: 'highpass', freq: 5200 } });
    return true;
  }

  /** Extend (extra life) fanfare: a rising square arpeggio. */
  function extend(spec = {}) {
    if (!begin('extend', SFX_MIN_GAP.extend)) return false;
    const pan = num(spec.pan, 0) * 0.4;
    const seq = [523, 659, 784, 1047, 1319, 1568];
    for (let i = 0; i < seq.length; i++) {
      blip({
        wave: 'square',
        freq: seq[i],
        dur: 0.09,
        peak: 0.095,
        attack: 0.003,
        hold: 0.03,
        delay: i * 0.085,
        pan,
        filter: { type: 'lowpass', freq: 4200 },
      });
    }
    return true;
  }

  /** Boss phase change: two-tone alarm under a rising noise swell. */
  function bossPhase(spec = {}) {
    if (!begin('bossPhase', SFX_MIN_GAP.bossPhase)) return false;
    const pan = num(spec.pan, 0) * 0.3;
    blip({
      wave: 'sawtooth',
      freq: 466,
      freqEnd: 420,
      dur: 0.14,
      peak: 0.15,
      attack: 0.004,
      hold: 0.05,
      pan,
      filter: { type: 'lowpass', freq: 1800 },
    });
    blip({
      wave: 'sawtooth',
      freq: 330,
      freqEnd: 300,
      dur: 0.14,
      peak: 0.15,
      attack: 0.004,
      hold: 0.05,
      delay: 0.16,
      pan,
      filter: { type: 'lowpass', freq: 1800 },
    });
    noiseBurst({
      dur: 0.4,
      peak: 0.14,
      attack: 0.12,
      pan,
      filter: { type: 'bandpass', freq: 700, freqEnd: 2200, q: 0.7 },
    });
    return true;
  }

  /** Player death / hit: descending saw, crash noise, and a mix duck. */
  function playerHit(spec = {}) {
    if (!begin('playerHit', SFX_MIN_GAP.playerHit)) return false;
    const pan = num(spec.pan, 0) * 0.2;
    blip({
      wave: 'sawtooth',
      freq: 520,
      freqEnd: 58,
      dur: 0.42,
      peak: 0.2,
      attack: 0.002,
      pan,
      filter: { type: 'lowpass', freq: 2400, freqEnd: 400 },
    });
    noiseBurst({
      dur: 0.45,
      peak: 0.28,
      attack: 0.004,
      pan,
      filter: { type: 'lowpass', freq: 3200, freqEnd: 180, q: 0.8 },
    });
    blip({ wave: 'square', freq: 200, freqEnd: 120, dur: 0.16, peak: 0.11, attack: 0.002, pan });
    duck(0.45, 0.5);
    return true;
  }

  const voices = { shot, hit, boom, pickup, bomb, graze, extend, bossPhase, playerHit };

  /* --------------------------------------------------------------- dispatch */

  /**
   * Trigger a voice by name.
   *
   * @param {string} name one of `SFX_NAMES`
   * @param {object} [spec] voice options (`pan`, `power`, `kind`, `size`)
   * @returns {boolean} true when the voice actually sounded
   */
  function play(name, spec) {
    const voice = voices[name];
    if (typeof voice !== 'function') return false;
    return voice(spec || {});
  }

  /** Turn a `game.events[]` entry into voice options. */
  function specForEvent(evt) {
    const spec = {};
    if (typeof evt.pan === 'number') {
      spec.pan = MathUtils.clamp(evt.pan, -1, 1);
    } else if (typeof evt.x === 'number') {
      // Playfield x -> pan, pushed toward the centre so nothing sits hard left.
      const p = (evt.x - halfField) / halfField;
      spec.pan = MathUtils.clamp(p, -1, 1) * 0.7;
    }
    if (typeof evt.kind === 'string') spec.kind = evt.kind;
    if (typeof evt.size === 'number') spec.size = evt.size;
    if (typeof evt.power === 'number') spec.power = evt.power;
    return spec;
  }

  /**
   * React to a single simulation event. Unknown types are ignored, so the shell
   * can forward the raw event queue without filtering.
   */
  function handleEvent(evt) {
    if (!evt || typeof evt !== 'object') return false;
    const name = EVENT_VOICES[evt.type];
    if (!name) return false;
    return play(name, specForEvent(evt));
  }

  /**
   * Play everything in an event queue. The queue is only read, never cleared —
   * the renderer owns draining it, so audio never steals a frame's events.
   *
   * @returns {number} how many events produced sound
   */
  function drain(events) {
    if (!Array.isArray(events)) return 0;
    let played = 0;
    for (let i = 0; i < events.length; i++) if (handleEvent(events[i])) played++;
    return played;
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Create (or resume) the context. Call from the first user gesture. */
  function unlock() {
    const c = ensure();
    if (!c) return Promise.resolve(false);
    if (c.state === 'suspended' && typeof c.resume === 'function') {
      const p = c.resume();
      if (p && typeof p.then === 'function') return p.then(() => true, () => false);
    }
    return Promise.resolve(c.state !== 'closed');
  }

  /** Park the context (tab hidden, menus) without losing the graph. */
  function suspend() {
    if (!ctx || typeof ctx.suspend !== 'function' || ctx.state !== 'running') return Promise.resolve(false);
    const p = ctx.suspend();
    if (p && typeof p.then === 'function') return p.then(() => true, () => false);
    return Promise.resolve(true);
  }

  function isReady() {
    return !!ctx && ctx.state !== 'closed';
  }

  function isMuted() {
    return muted;
  }

  function setMuted(on) {
    muted = on === true;
    applyLevel();
    return muted;
  }

  function toggleMute() {
    return setMuted(!muted);
  }

  function getVolume() {
    return volume;
  }

  function setVolume(v) {
    volume = MathUtils.clamp(num(v, volume), 0, 1);
    applyLevel();
    return volume;
  }

  /** Tear everything down: stop voices, close the context, drop the graph. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const source of live) {
      try {
        source.stop();
      } catch (err) {
        // Already stopped by its own scheduled end: nothing to do.
      }
      if (typeof source.disconnect === 'function') source.disconnect();
    }
    live.clear();
    for (const key of Object.keys(lastAt)) delete lastAt[key];
    if (ctx && typeof ctx.close === 'function' && ctx.state !== 'closed') {
      const p = ctx.close();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
    ctx = null;
    bus = null;
    duckGain = null;
    master = null;
    shaper = null;
    limiter = null;
    noiseBuffer = null;
  }

  return {
    get context() {
      return ctx;
    },
    get capacity() {
      return opts.maxVoices;
    },
    get activeVoices() {
      return live.size;
    },
    names: SFX_NAMES,
    unlock,
    suspend,
    isReady,
    isMuted,
    setMuted,
    toggleMute,
    getVolume,
    setVolume,
    play,
    handleEvent,
    drain,
    shot,
    hit,
    boom,
    pickup,
    bomb,
    graze,
    extend,
    bossPhase,
    playerHit,
    dispose,
  };
}

export default createSfx;
