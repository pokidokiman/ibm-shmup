# ibm-shmup REBUILD — Three.js + Tailwind, Cave/dodonpachi-class vertical shmup

Rebuild from scratch. The old `index.html` (588-line single-file canvas game) is reference only for
aesthetic intent (CRT monitor chrome, warm phosphor look). It is NOT to be patched.

## Non-negotiables

- **Tailwind CSS** for all UI/HUD chrome, loaded via CDN in `index.html`.
- **Three.js** for all rendering, loaded via importmap in `index.html` (no bundler, no npm deps).
- **Single bundle, zero binary assets.** Every sprite, texture, sound and glyph is generated
  procedurally at runtime (canvas 2D → THREE.CanvasTexture, WebAudio oscillators/noise).
- **Lightning-fast play.** Fixed-timestep simulation, 60 Hz display, sub-frame input sampling.
- **Skill matters.** Tight hitbox (2px), focus mode, graze, chain/combo scoring, rank scaling.
- **No placeholders.** No `TODO`, no stubbed functions, no `not implemented`.

## Module layout (all files `.mjs` — required so `node --check` validates ESM)

```
index.html                 Tailwind + importmap + canvas + CRT chrome + bootstrap
src/core/clock.mjs         fixed-timestep accumulator, frame budget, FPS meter
src/core/rng.mjs           seeded PRNG (mulberry32) + range/int/pick/chance
src/core/vec2.mjs          plain {x,y} math: add/sub/scale/len/norm/lerp/approach/angle
src/core/input.mjs         keyboard+pointer -> logical actions, edge detection, focus/fire/bomb
src/core/pool.mjs          generic object pool (no allocation during play)
src/game/config.mjs        BALANCE: every tunable constant + POWERUP_TABLE + STAGE_TABLE
src/game/player.mjs        pos, speed, focus slow-mode, lives, bombs, invuln, fire cadence
src/game/bullets.mjs       pooled player/enemy bullets, lasers, update+retire
src/game/patterns.mjs      danmaku generators: aimed spread ring spiral sweep homing arc
src/game/enemies.mjs       archetypes (grunt, popcorn, turret, midboss) + movement scripts
src/game/waves.mjs         stage timeline -> deterministic spawn schedule
src/game/boss.mjs          multi-phase boss: hp gates, attack cycles, timeout, death sequence
src/game/powerups.mjs      drop table, pickup types, auto-collect, power tiers 1..4
src/game/scoring.mjs       score, chain, graze, extend awards, rank
src/game/collision.mjs     circle-circle, player hitbox, graze band, uniform-grid broadphase
src/game/game.mjs          GameState: wires systems, step(dt), event queue. NO DOM, NO three.
src/render/three-scene.mjs renderer, ortho camera, post chain, resize
src/render/sprites.mjs     procedural texture atlas (ships, bullets, enemies, FX) -> CanvasTexture
src/render/background.mjs  parallax starfield + stage backdrop, scrolls with stage progress
src/render/crt.mjs         CRT ShaderMaterial: scanlines, curvature, aberration, vignette, glow
src/render/hud.mjs         binds GameState -> Tailwind DOM (score, lives, bombs, power, chain, boss bar)
src/audio/sfx.mjs          WebAudio procedural SFX (shot, hit, boom, pickup, bomb)
tests/*.test.mjs           node --test contracts (see below)
tools/check.mjs            static/structural verifier
```

## Hard architecture rule

`src/core/*` and `src/game/*` are **pure**: no DOM, no `three`, no `window`/`document`, no timers.
They must import cleanly in plain Node. All rendering lives in `src/render/*`; all audio in
`src/audio/*`. This is what makes the simulation testable without a browser, and `tools/check.mjs`
enforces it.

## Interfaces the tests pin (do not rename)

- `createGame({ seed, stage })` -> `game` with:
  - `game.state` = `{ score, lives, bombs, power, chain, chainTimer, frame, time, stage,
    rank, gameOver, bossActive }` (all numbers/booleans)
  - `game.player` = `{ x, y, hitR, speed, fireCooldown, invuln, focus }`
  - `game.input` = action state object (`up/down/left/right/fire/bomb/focus` booleans)
  - `game.step(dt)` — advances the simulation; must be safe to call thousands of times
  - `game.events` — array drained by the renderer: `{type, ...}` where type is one of
    `shot|enemyHit|enemyKilled|playerHit|powerup|bomb|bossPhase|extend|graze`
  - `game.spawnEnemy(kind, x, y, opts)`, `game.spawnBoss(stage)`
- `createPool(size, factory)` -> `{ acquire(), release(o), active, capacity }`; `active` holds live
  objects only; acquire past capacity returns `null` (never allocates, never throws).
- `PATTERNS.<name>(origin, opts)` -> array of bullet specs `{ x, y, vx, vy, r, kind, speed }`.
  Required names: `aimed`, `spread`, `ring`, `spiralStep`, `sweep`, `arc`.
- `circlesHit(ax, ay, ar, bx, by, br)` -> boolean. `createGrid(cell)` -> `{ insert(o), query(x, y, r) }`.
- `createBoss(cfg)` -> `{ phases, phase, hp, maxHp, active, update(dt, ctx), damage(n) }`;
  advancing `damage()` past an hp gate must advance `phase` and emit a `bossPhase` event via ctx.
- `addKill(state, enemy)`, `addGraze(state)`, `addExtend(state)` in scoring; chain increments on
  kill, resets on `config.CHAIN_TIMEOUT` elapsed.
- `dropFor(enemy, rng)` in powerups -> `null` or `{ kind: 'power'|'life'|'bomb'|'score', x, y }`.

## Acceptance criteria (what "done" means)

1. `node tools/check.mjs` exits 0: files present, every `src/**/*.mjs` parses, purity rule holds,
   `index.html` carries Tailwind CDN + three importmap + `#game-canvas` + module script, no TODOs.
2. `node --test tests/*.test.mjs` exits 0: all contracts above.
   (NOTE: the bare directory form `node --test tests/` fails on this Node build with
   "Cannot find module ...\tests" - always use the glob.)
3. Balance targets in `config.mjs`: player speed ~4.2 px/frame normal, ~1.9 focused; player hitbox
   radius 2; bullet speeds 3.0–9.5 px/frame; boss phase count >= 3 per stage; power tiers 1..4;
   chain timeout 120 frames; extend every 2,000,000 points.
4. Non-stop action: a stage timeline that spawns continuously, midboss at ~55%, boss at 100%.
5. Deterministic: same `seed` + same input trace -> identical score (tests assert this twice).

## Reference (aesthetic intent only — read, do not copy)

`index.html` (old), `crt-test.html`, `crt_mask_gen.html`: warm CRT chrome, monitor bezel, scanlines,
vignette, glass reflection, 4:3 letterboxed playfield.
