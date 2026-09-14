/**
 * src/core/clock.mjs — fixed-timestep accumulator with catch-up clamping and an FPS meter.
 *
 * The simulation must advance in identical slices no matter how fast the display
 * refreshes, so the renderer feeds real elapsed seconds into `tick()` and replays
 * `tick()`'s return value as that many fixed `step` updates:
 *
 *   const steps = clock.tick(realDt);       // seconds since the last rAF
 *   for (let i = 0; i < steps; i++) game.step(clock.step);
 *   render(game, clock.alpha);              // alpha = fraction into the next step
 *
 * A stall (tab throttling, breakpoint) can hand us seconds of backlog; the step
 * budget clamps that to `maxSteps` and discards the remainder so the game never
 * death-spirals trying to catch up.
 *
 * Pure ES module: no DOM, no three, no timers.
 */

const FPS_WINDOW = 0.25; // seconds of real time averaged into the FPS readout

/**
 * @param {number} [step=1/60] fixed simulation slice in seconds
 * @param {number} [maxSteps=8] hard cap on catch-up steps per `tick`
 */
export function createClock(step = 1 / 60, maxSteps = 8) {
  const dt = Number.isFinite(step) && step > 0 ? step : 1 / 60;
  const budget = Number.isFinite(maxSteps) && maxSteps >= 1 ? Math.floor(maxSteps) : 8;

  let accumulator = 0;
  let elapsed = 0;
  let realTime = 0;
  let frames = 0;
  let totalSteps = 0;
  let dropped = 0;
  let fpsFrames = 0;
  let fpsTime = 0;
  let fps = 0;

  /**
   * Advance the accumulator by `seconds` of real time.
   * @returns {number} how many fixed steps the caller must run (0..maxSteps)
   */
  const tick = (seconds) => {
    const dtReal = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    if (dtReal > 0) {
      accumulator += dtReal;
      realTime += dtReal;
      frames++;
      fpsFrames++;
      fpsTime += dtReal;
      if (fpsTime >= FPS_WINDOW) {
        fps = fpsFrames / fpsTime;
        fpsFrames = 0;
        fpsTime = 0;
      }
    }

    let steps = 0;
    while (accumulator >= dt && steps < budget) {
      accumulator -= dt;
      steps++;
    }

    if (steps >= budget && accumulator >= dt) {
      // Over budget: drop the backlog but keep the sub-step remainder for smoothness.
      dropped += Math.floor(accumulator / dt);
      accumulator %= dt;
      if (!(accumulator < dt)) accumulator = 0; // guard against fp edge cases near dt
    }

    totalSteps += steps;
    elapsed += steps * dt;
    return steps;
  };

  /** Clear accumulator, counters and the FPS meter (used on restart). */
  const reset = () => {
    accumulator = 0;
    elapsed = 0;
    realTime = 0;
    frames = 0;
    totalSteps = 0;
    dropped = 0;
    fpsFrames = 0;
    fpsTime = 0;
    fps = 0;
    return api;
  };

  const api = {
    tick,
    reset,
    /** Fixed simulation slice, seconds per step. */
    get step() {
      return dt;
    },
    get dt() {
      return dt;
    },
    get maxSteps() {
      return budget;
    },
    /** Un-consumed real time waiting to become a step, in seconds. */
    get accumulator() {
      return accumulator;
    },
    /** Interpolation ratio in [0, 1) for the renderer. */
    get alpha() {
      return accumulator / dt;
    },
    /** Simulated time advanced so far (steps * step). */
    get elapsed() {
      return elapsed;
    },
    /** Real time fed into `tick`. */
    get realTime() {
      return realTime;
    },
    /** Number of `tick` calls (i.e. frames rendered). */
    get frames() {
      return frames;
    },
    /** Total fixed steps produced. */
    get steps() {
      return totalSteps;
    },
    /** Fixed steps thrown away because a frame ran over budget. */
    get dropped() {
      return dropped;
    },
    /** Smoothed frames per second. */
    get fps() {
      return fps;
    },
  };

  return api;
}

export default createClock;
