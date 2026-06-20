# IBM SHMUP → Godot 4 Port Plan

## Overview

Port the browser-based ASCII/CRT shmup to Godot 4 for a professional-grade desktop/HTML5 game. This is not a 1:1 port — it's a re-architecture leveraging Godot's native systems: scenes, signals, AnimationPlayer, TileMap, GPU particles, shaders, audio buses, and InputMap.

---

## 1. COMPLETE INVENTORY OF EXISTING GAME

### 1.1 File Structure

```
ibm-shmup/
├── index.html          # 588 lines — entire game (HTML+CSS+JS)
├── crt_mask_gen.html   # Standalone CRT bezel mask generator (utility)
├── crt-test.html       # Three.js WebGL CRT shader test (experimental)
├── README.md           # Project description, features, roadmap, controls
├── .gitignore          # OS/IDE/temp files
└── .git/               # Git repo ~70 commits, last commit 2026-06-18
```

### 1.2 Game Architecture (Current — Browser)

**Rendering:** Single `<canvas>` (1024×768), 2D context, all draw calls inline.

**Game States:** `'title'`, `'playing'`, `'paused'`, `'gameover'` — managed by `gs` string variable.

**Main Loop:** `loop()` → `up()` (update) → `render()` (draw) via `requestAnimationFrame`.

**Game Objects:** Plain JS objects in arrays (`buls`, `enems`, `ebuls`, `pups`, `parts`). No class hierarchy. Filtered each frame with `.filter()`.

**Glyph System:** 2D ASCII art defined as string arrays in `Glyphs` object. Rendered via `ctx.fillText()`.

**Background:** Scrolling starfield + cityscape silhouette. 80 star objects + 50 building objects. All drawn procedurally with `fillRect()`.

**Scrolling Background Parallax:**
- Stars: 3 layers (speed 0.3-1.2)
- City buildings: 0.3× scroll multiplier with window lights
- Ground strip: sine-wave grass

**Enemy System:**
- 3 types: `enemy1` (grunt, 1HP), `enemy2` (tank, 2HP), `enemy3` (elite, 4HP)
- 4 movement patterns: `'sin'`, `'zig'`, `'duik'` (dive), `'snell'` (fast)
- Wave system: count = 5 + floor(wave/2), type based on floor((wave-1)/2)
- Boss every 5 waves: multi-phase (enter → strafe → spread/aimed shots)

**Player:**
- 8-directional, 5px/frame speed
- 4 power-up levels (spread → angled → 4-way)
- 3 lives with invincibility frames (120 frames)
- Fire rate: max(3, 6 - pw) frames between shots

**Power-ups:** 12% drop chance on kill, level P (firepower upgrade)

**Combo System:** `cc` counter increments on rapid kills, 0.1× score multiplier per combo level. Decays after 120 frames (`ct`).

**Sound:** Web Audio API oscillator-based procedural SFX:
- `sfxShoot()` — 800Hz square, 80ms
- `sfxHit()` — 200Hz sawtooth, 150ms
- `sfxExplode()` — 100Hz sawtooth + 60Hz square
- `sfxPowerup()` — 600Hz → 900Hz two-step
- `sfxGameOver()` — descending 300→200→100Hz
- `sfxFloppySeek()` — procedurally generated floppy drive seek noise

**CRT/Cyberdeck Aesthetic:**
- Barrel distortion: SVG `feDisplacementMap` with procedurally generated sphere map
- Scanlines: CSS gradient overlay
- Vignette: CSS radial gradient overlay
- Glass reflection: CSS linear gradient overlay
- Phosphor glow: `ctx.shadowBlur` + `#33ff33` color
- Screen shake: random offset translation
- Raster tear effect: clipped horizontal band with scanline displacement
- Sync jitter: sub-pixel horizontal offset
- Boot sequence: typewriter text, memory test count-up, Matrix rain on title

**Input:** Raw `keydown`/`keyup` listeners, keyboard event codes (`ArrowLeft`, `KeyA`, etc.).

**Persistence:** `localStorage` for high score.

### 1.3 Metrics

| Aspect | Value |
|--------|-------|
| Total JS lines | ~500 (embedded in HTML) |
| Game objects | 6 arrays (buls, enems, ebuls, pups, parts, stars) |
| Enemy types | 3 + boss |
| Power-up levels | 4 |
| Sound effects | 6 procedural oscillator functions |
| Visual effects | 6 (scanlines, vignette, glow, shake, tear, barrel) |
| Score persistence | localStorage |

### 1.4 What's NOT Currently Implemented (from README plans)
- Weapon pickups (laser, spread, homing, shield)
- Ship selection
- DMG-01 mode (160×144)
- Two-player mode
- Replay recorder
- Procedural soundtrack
- Online leaderboard

---

## 2. STRUCTURAL CHANGES FOR GODOT

### 2.1 Architecture Paradigm Shifts

| Browser/Canvas | Godot 4 | Why It Matters |
|---|---|---|
| HTML `<div>` layout + CSS | `Node2D` scene tree | Built-in spatial hierarchy, world-space coordinates |
| `ctx.fillText()` glyph rendering | `Label` + `RichTextLabel` nodes or Sprite2D with bitmap font | Proper font rendering, outline/shadow built-in |
| `ctx.fillRect()` procedural drawing | `Sprite2D` with textures, `Polygon2D`, or `ColorRect` | GPU-accelerated, no CPU redraw per frame |
| Canvas global `ctx` state machine | Per-node properties (modulate, position, scale) | No state leaks, composable transforms |
| `requestAnimationFrame` loop | `_process(delta)` / `_physics_process(delta)` | Fixed or variable timestep, delta-time aware |
| Plain JS objects & arrays | Scene instances (PackedScene) | Full lifecycle, signal connections, editor tooling |
| CSS overlay effects | `CanvasLayer` + `ColorRect` with shader | Post-processing in shader space, not DOM |
| Event listeners (`keydown`/`keyup`) | `InputMap` actions + `Input` singleton | Rebinding, gamepad support, action abstraction |
| Web Audio API oscillators | `AudioStreamGenerator` + `AudioStreamPlayer` | Procedural audio via GDScript, audio bus routing |
| `Math.random()` particles | `GPUParticles2D` (or `CPUParticles2D`) | GPU-computed, thousands of particles, sub-emitters |

### 2.2 Scene Tree Architecture (vs flat arrays)

Instead of:
```js
let enems = [{x, y, hp, ...}];
// iterate, draw, filter
```

You get:
```
World (Node2D)
├── Player (CharacterBody2D)         # physics-based, collision detection
├── BulletContainer (Node2D)         # holds bullet instances
│   ├── Bullet.tscn instances
├── EnemyContainer (Node2D)          # holds enemy instances
│   ├── Enemy.tscn instances (with AnimationPlayer for patterns)
│   └── Boss.tscn instance
├── PowerupContainer (Node2D)
├── FXContainer (Node2D)             # particles, explosions
├── Background (Parallax2D or TileMap)
├── HUD (CanvasLayer)                # score, lives, wave
│   ├── ScoreLabel (Label)
│   ├── LivesDisplay (HBoxContainer of TextureRect)
│   └── WaveLabel (Label)
├── CRT_Overlay (CanvasLayer)        # post-processing
│   └── ColorRect (shader_material)
└── BootScreen (CanvasLayer)         # boot sequence overlay
    └── BootText (RichTextLabel)
```

### 2.3 Signals vs Event Callbacks

| Pattern | Browser | Godot |
|---|---|---|
| Bullet hits enemy | Nested loops, manual bounds check | `Area2D` signal `area_entered` / `body_entered` |
| Enemy dies | Set `act=false`, filter | Emit `died` signal, queue_free() |
| Powerup collected | Manual distance check | `Area2D` overlap detection |
| Boss defeat → next wave | Manual state check | Signal `boss_destroyed` → wave manager |
| Game over | String state variable | Signal `player_died` with lives check |

### 2.4 Animation System

| Browser | Godot |
|---|---|
| Manual `sin()` + `frame` counter for enemy patterns | `AnimationPlayer` with `AnimationTree` for blend trees |
| Manual flash blink for invincibility | `AnimationPlayer` modulate animation |
| Manual screen shake via random translation | `Camera2D` with `AnimationPlayer` shake track |
| Typewriter boot text via setTimeout | `RichTextEffect` or `AnimationPlayer` per-character reveal |
| Matrix rain via requestAnimationFrame | `Shader` (visual shader or GLSL) |

### 2.5 TileMap vs Procedural Background

The current cityscape + starfield can be:
- **Option A (Parallax2D):** Cloudy starfield layers + city silhouette as repeating texture. Simplest, most performant.
- **Option B (TileMapLayer):** City buildings as tilemap for hand-placed levels. Overkill for a shmup.
- **Option C (Shader):** Entire scrolling background as a shader. Cool but harder to tweak.

**Recommendation:** `Parallax2D` for stars (3 layers of Sprite2D with `region_rect` and noise texture), plus a single `Sprite2D` for the city silhouette. Ground strip can be a shader on a `ColorRect`.

### 2.6 Input Handling

**Recommended InputMap Actions:**

| Action | Keys (default) | Godot InputEvent |
|---|---|---|
| `move_left` | A, Left, Q | `ui_left` pattern |
| `move_right` | D, Right | `ui_right` pattern |
| `move_up` | W, Up, Z | `ui_up` pattern |
| `move_down` | S, Down | `ui_down` pattern |
| `shoot` | Space, Z | `InputEventKey` |
| `pause` | P, Escape | `InputEventKey` |
| `confirm` | Space, Enter | `ui_accept` pattern |

Use `Input.get_axis("move_left", "move_right")` and `Input.get_axis("move_up", "move_down")` for analog-ready movement.

### 2.7 Audio Pipeline

Current Web Audio → Godot equivalent:

| Browser | Godot |
|---|---|
| `OscillatorNode` (square/sawtooth) | `AudioStreamGenerator` with GDScript filling buffer with square/sawtooth math |
| `GainNode` envelope | `AudioStreamPlayer` volume + `Tween` for amplitude envelope |
| `BiquadFilterNode` (floppy seek) | `AudioEffectFilter` on audio bus |
| `createBuffer` noise | `AudioStreamGenerator` writing random data |

**Recommended approach:** Pre-generate WAV samples on first run (or as import script) and play them via `AudioStreamPlayer2D`. This avoids buffer-fill latency and gives full audio bus control. The floppy seek can remain procedural via `AudioStreamGenerator` for the novelty.

**Better approach for professional grade:** Bake the 6 SFX as `.wav` files during import using a Godot editor plugin or pre-render them once in an external step, then use `AudioStreamPlayer2D` nodes with `max_polyphony` for bullet sounds.

### 2.8 Particle System

Current: Manually managed arrays of `{x, y, vx, vy, l, ml, col}` particles drawn as 4×4 squares.

Godot: `GPUParticles2D` with `ParticleProcessMaterial`.
- **Explosion:** Burst emission, 12-30 particles, lifetime 0.4s, initial velocity random, color ramp green→yellow→transparent
- **Hit spark:** Burst emission, 4-6 particles, lifetime 0.2s
- **Player hit:** Burst emission, 16-20 red particles
- **Sub-emitter:** Explosion can spawn smoke sub-particles

Create 3 `.tscn` scenes: `ExplosionFX.tscn`, `HitFX.tscn`, `PlayerHitFX.tscn` — instantiate and `one_shot` = true.

### 2.9 Shaders (CRT Overlay)

Instead of CSS + SVG barrel distortion:

**Fullscreen shader on CanvasLayer > ColorRect** with `shader_material` type `CanvasItem`:

```glsl
shader_type canvas_item;

uniform float barrel_power = 1.2;
uniform float scanline_intensity = 0.15;
uniform float vignette_intensity = 0.6;
uniform float phosphor_decay : hint_range(0.0, 1.0) = 0.85;

void fragment() {
    // Barrel distortion
    vec2 uv = UV * 2.0 - 1.0;
    float r = length(uv);
    vec2 curved = uv * (1.0 + barrel_power * r * r);
    vec2 sample_uv = curved * 0.5 + 0.5;

    // Edge clamp → black
    if (sample_uv.x < 0.0 || sample_uv.x > 1.0 || sample_uv.y < 0.0 || sample_uv.y > 1.0) {
        COLOR = vec4(0.0);
        return;
    }

    // Chromatic aberration (sub-pixel RGB offset)
    float r_offset = 0.002;
    float b_offset = -0.002;
    vec4 col;
    col.r = texture(TEXTURE, sample_uv + vec2(r_offset, 0.0)).r;
    col.g = texture(TEXTURE, sample_uv).g;
    col.b = texture(TEXTURE, sample_uv + vec2(b_offset, 0.0)).b;
    col.a = 1.0;

    // Scanlines
    float scanline = sin(sample_uv.y * 800.0) * scanline_intensity;
    col.rgb -= scanline;

    // Vignette
    float vignette = sample_uv.x * sample_uv.y * (1.0 - sample_uv.x) * (1.0 - sample_uv.y);
    vignette = pow(16.0 * vignette, 0.4);
    col.rgb *= mix(vec3(1.0), vignette, vignette_intensity);

    COLOR = col;
}
```

### 2.10 Export Settings

**Desktop (Windows/Linux/Mac):**
- Resolution: 1024×768 (4:3 native), stretch mode `canvas_items`, aspect `keep`
- Texture compression: S3TC/BC (lossless for pixel art)
- Threads: enabled

**Web (HTML5):**
- Export template: Godot 4.x Web
- Enable `ServiceWorker` for offline PWA
- Enable threading (SharedArrayBuffer) for performance
- Audio driver: `AudioWorklet` (modern browsers)
- Canvas resize mode: `project`
- Focus loss: `pause` (browser tab switching)
- Enable `virtual_keyboard` false (desktop keyboard game)

**Common:**
- Window size: 1024×768 minimum, resizable
- vsync: adaptive
- FPS limit: 60
- Pixel snap: enabled (for crisp ASCII glyphs)

---

## 3. CONCRETE STEP-BY-STEP PORT PLAN

### Phase 0: Scaffold (1 session)

```
ibm-shmup-godot/
├── project.godot
├── default_bus_layout.tres
├── icon.svg
├── assets/
│   ├── fonts/
│   │   └── IBM_VGA_8x16.ttf      # Bitmap font matching Courier New monospaced
│   │   └── IBM_VGA_8x16.import
│   ├── textures/
│   │   ├── star_1.png              # Small star sprites
│   │   ├── star_2.png
│   │   └── city_silhouette.webp   # Cityscape layer
│   ├── audio/
│   │   ├── sfx_shoot.wav
│   │   ├── sfx_hit.wav
│   │   ├── sfx_explode.wav
│   │   ├── sfx_powerup.wav
│   │   ├── sfx_gameover.wav
│   │   └── sfx_floppy_seek.wav
│   └── glyphs/                     # Pre-rendered glyph textures
│       ├── player_glyph.png
│       ├── enemy1_glyph.png
│       ├── enemy2_glyph.png
│       ├── enemy3_glyph.png
│       ├── boss_glyph.png
│       ├── powerup_glyph.png
│       ├── bullet_player.png
│       └── bullet_enemy1.png
├── scenes/
│   ├── Main.tscn                   # Root scene
│   ├── Player/
│   │   ├── Player.tscn
│   │   └── Player.gd
│   ├── Enemies/
│   │   ├── Enemy.tscn
│   │   ├── Enemy.gd
│   │   ├── EnemyTypes.gd           # Static data: 3 types
│   │   ├── Boss.tscn
│   │   └── Boss.gd
│   ├── Bullets/
│   │   ├── Bullet.tscn
│   │   ├── Bullet.gd
│   │   ├── EnemyBullet.tscn
│   │   └── EnemyBullet.gd
│   ├── Powerup.tscn
│   ├── Background.tscn
│   ├── HUD.tscn
│   ├── BootScreen.tscn
│   ├── CRTOverlay.tscn
│   └── Effects/
│       ├── ExplosionFX.tscn
│       ├── HitFX.tscn
│       └── PlayerHitFX.tscn
├── scripts/
│   ├── GameManager.gd              # Global game state, signals, score
│   ├── WaveManager.gd             # Wave spawning logic
│   ├── AudioManager.gd            # Centralized audio playback
│   ├── LevelData.gd               # Wave definitions, enemy compositions
│   └── SignalBus.gd               # Global signals (autoload)
├── shaders/
│   ├── crt_overlay.gdshader
│   ├── matrix_rain.gdshader       # Matrix rain for title screen
│   └── ground_scroll.gdshader     # Animated ground strip
└── README.md
```

### Phase 1: Core Framework (Session 1-2)

1. **Create project** in Godot 4.4+ → 1024×768, 2D
2. **InputMap setup** — 8 actions (move_left/right/up/down, shoot, pause, confirm, restart)
3. **SignalBus autoload** — Global signals:
   - `score_changed(amount: int)`
   - `lives_changed(remaining: int)`
   - `wave_changed(wave: int)`
   - `game_over()`
   - `boss_spawned()`
   - `boss_destroyed()`
   - `powerup_collected(type: String)`
4. **AudioManager autoload** — Singleton with `sfx_shoot()`, `sfx_hit()`, etc. Preloads all audio streams.
5. **GameManager autoload** — score, high_score, lives, game state machine (TITLE, PLAYING, PAUSED, GAME_OVER)

### Phase 2: Rendering Infrastructure (Session 2-3)

6. **Bitmap font** — Source a monospaced terminal font (PxPlus IBM VGA 8x16, or `Iosevka Term`). Set as project default.
7. **Glyph → Texture atlas** — Render each ASCII glyph array to sprite textures using `BitmapFont` or pre-rendered PNGs with region rects.
   - Alternative: Use `Label` nodes with monospace font and custom materials for glow.
8. **Set up Main scene** — Root `Node2D` → Background, Player, containers, HUD, BootScreen, CRTOverlay
9. **ParallaxBackground** — 3 star layers with scrolling speeds, one city layer

### Phase 3: Player & Input (Session 3)

10. **Player scene** — `CharacterBody2D` with `CollisionShape2D`
11. **Player script:**
    - `_input(event)` or `_process(delta)` → read Input actions → `velocity` → `move_and_slide()`
    - Clamp to camera bounds
    - Fire: `Input.is_action_pressed("shoot")` → instantiate Bullet.tscn
    - Invincibility: timer + modulate blink via AnimationPlayer
12. **Bullet scene** — `Area2D` with `CollisionShape2D`, linear velocity
    - Signal `body_entered` → damage enemy, queue_free()

### Phase 4: Enemies & Wave System (Session 3-4)

13. **Enemy scene** — `CharacterBody2D` or `RigidBody2D` with `CollisionShape2D`
14. **Enemy types** — `EnemyTypes.gd` static dictionary (same data as `eTypes`)
15. **Enemy movement patterns** — Use `AnimationPlayer` with position tracks OR `Tween` for:
    - `sin`: sine-wave horizontal oscillation
    - `zig`: fast zigzag
    - `duik`: slow then fast dive
    - `snell`: straight fast descent
16. **WaveManager** — Autoload or node:
    - Timer-based spawn groups
    - Wave index → pick enemy composition, count, speed multiplier
    - Every 5th wave → spawn Boss instead
17. **Boss scene** — Larger `CharacterBody2D` with multi-phase `AnimationTree`
    - Phase 1: Enter screen (0-2s)
    - Phase 2: Strafe + spread shot
    - Phase 3: Aimed shots
    - Phase 4: Enrage at <30% HP

### Phase 5: Collision & Combat (Session 4)

18. **Layer/mask setup:**
    | Layer | Members |
    |---|---|
    | 1 (Player) | Player |
    | 2 (PlayerBullets) | Player bullets |
    | 3 (Enemies) | Enemies, Boss |
    | 4 (EnemyBullets) | Enemy bullets |
    | 5 (Powerups) | Powerup pickups |

19. **Hit detection:**
    - Bullet `area_entered` Enemy → damage, spawn HitFX
    - EnemyBullet `body_entered` Player → damage player
    - Enemy `body_entered` Player → damage player
    - Player `area_entered` Powerup → collect

20. **Combo system:** Score multiplier for kills within 2s of each other.

### Phase 6: Particles & Visual FX (Session 4-5)

21. **ExplosionFX.tscn** — GPUParticles2D, burst emission, green/yellow gradient, 0.4s lifetime
22. **HitFX.tscn** — GPUParticles2D, 4 particles, green, 0.15s
23. **PlayerHitFX.tscn** — GPUParticles2D, red, 0.3s
24. **Screen shake** — `Camera2D` with `offset` animated via `AnimationPlayer` or `Tween`

### Phase 7: CRT Post-Processing (Session 5)

25. **CRTOverlay.tscn** — `CanvasLayer` > `ColorRect` (full viewport) with `crt_overlay.gdshader`
26. **Shader features:**
    - Barrel distortion
    - Chromatic aberration
    - Scanlines (adaptive to viewport height)
    - Vignette
    - Phosphor glow (bloom-like)
27. **Raster tear effect** — Animated horizontal clip region with scanline distortion via second shader param

### Phase 8: Boot Screen & Title (Session 5-6)

28. **BootScreen scene** — `CanvasLayer` with:
    - `RichTextLabel` with typewriter effect (or `Label` with `visible_characters` animation)
    - Memory test: Timer with progress bar + label
    - Matrix rain: `matrix_rain.gdshader` on a `ColorRect`
29. **Title screen** — SHMUP title with IBM model text, pulsing "PRESS SPACE" via AnimationPlayer
30. **Game state flow:** Boot → Title → Playing → GameOver → Title

### Phase 9: Audio (Session 6)

31. **Pre-generate WAVs** using external script (Python or Node) from oscillator parameters
    OR
32. **ProceduralAudio.gd** — `AudioStreamGenerator` plugin that generates square/sawtooth waves at runtime
33. **Audio bus setup:**
    - Master bus: limiter
    - SFX bus: highpass filter
    - Floppy bus: bandpass filter (for the seek sound)
34. **Spatial audio:** `AudioStreamPlayer2D` with max distance 1024px

### Phase 10: Polish & Professional Features (Session 6-8)

35. **Bitmap font with glow** — Built-in `LabelSettings.outline_size` + `shadow_color` for phosphor glow, no manual glow draw calls
36. **Animated power-up** — `AnimatedSprite2D` pulsing "P" with rotation via AnimationPlayer
37. **Boss HP bar** — `TextureProgressBar` in HUD, only visible during boss fights
38. **Combo display** — `Label` that scales up with `Tween` on combo increments
39. **High score persistence** — `ConfigFile` saved to `user://highscore.cfg`
40. **Keyboard/gamepad mapping** — Expose InputMap rebinding in settings
41. **Pause menu** — `CanvasLayer` with `ColorRect` dim + label, `process_mode = ALWAYS`

### Phase 11: Export & Release (Session 8)

42. **Export presets:**
    - Windows (.exe, 1024×768, vsync adaptive)
    - Linux (.x86_64)
    - Web (HTML5 + WASM + ServiceWorker)
43. **Texture compression:** Lossless for glyph textures, lossy for background
44. **Optimization:**
    - Bullet pooling (pre-allocate 50 bullets, recycle)
    - Enemy pooling (pre-allocate 20 enemies)
    - Use `AABB` culling for off-screen enemies
    - Set `VisibilityNotifier2D` on all game objects
45. **Test on target platforms** — WSL2 user → Windows build primary, web build secondary

---

## 4. KEY GODOT BEST PRACTICES FOR THIS PORT

### Scene Composition
- **Each game entity is a .tscn file** with a dedicated script. No monolithic flat arrays.
- **Use .tscn instancing** instead of manual object creation.
- **Node groups** (`"enemies"`, `"bullets"`, `"powerups"`) for group operations instead of tracking arrays.

### Physics & Collision
- `Area2D` for bullets (no physics response needed, just detection)
- `CharacterBody2D` for player (needs `move_and_slide()`)
- `RigidBody2D` optional for enemies (or keep CharacterBody2D for simpler control)

### Delta Time
- Current game is frame-rate dependent (no delta). Godot's `_process(delta)` makes it frame-independent. Multiply all speeds by `delta`.

### Memory Management
- Use `queue_free()` instead of `.filter()` — Godot handles lifecycle.
- Object pooling for bullets (50-100 pre-instantiated, recycled with `set_process(true/false)`).

### Autoloads vs Scenes
| Responsibility | Pattern |
|---|---|
| Game state machine | Autoload (GameManager) |
| Audio playback | Autoload (AudioManager) |
| Wave spawning | Scene node (WaveManager under World) |
| HUD | Scene with CanvasLayer |
| CRT overlay | Scene with CanvasLayer |

### Resolution & Scaling
- Base resolution: 1024×768
- Stretch mode: `canvas_items`, aspect: `keep`
- GUI anchors: all HUD elements anchor to viewport edges
- CRT shader samples at full viewport resolution, no scaling artifacts

---

## 5. TIMELINE ESTIMATE

| Phase | Sessions | Hours | Deliverable |
|---|---|---|---|
| 0. Scaffold | 1 | 2 | Empty Godot project, asset structure, font |
| 1. Core Framework | 2 | 4 | Input, signals, autoloads, game state |
| 2. Rendering | 2 | 3 | Background, Parallax, Main scene layout |
| 3. Player + Input | 1 | 3 | Player movement, shooting, bullets |
| 4. Enemies + Waves | 2 | 5 | Enemy types, patterns, WaveManager, Boss |
| 5. Collision + Combat | 1 | 3 | Layer masks, damage, combos, powerups |
| 6. Particles + FX | 2 | 3 | GPUParticles2D, screen shake |
| 7. CRT Shader | 1 | 3 | Post-processing overlay shader |
| 8. Boot + Title | 2 | 4 | Boot sequence, title screen, Matrix rain |
| 9. Audio | 1 | 3 | WAV generation, audio bus, procedural |
| 10. Polish | 3 | 6 | Animations, settings, pause menu, HP bar |
| 11. Export | 2 | 3 | Export presets, optimization, testing |
| **Total** | **20** | **42** | |

---

## 6. MIGRATION MAPPING (every browser → Godot equivalent)

| Browser (index.html) | Godot 4 Destination | Notes |
|---|---|---|
| `const W=1024, H=768` | `project.godot` → Display → Window | Base resolution |
| `ctx.fillText()` | `Label` nodes + bitmap font | Or sprite glyph textures |
| `Glyphs` object | `TextureAtlas` or `Font` glyphs | Pre-render or use Label |
| `up()` game logic | `GameManager._process(delta)` | Game state dispatch |
| `render()` drawing | Scene tree rendering | No manual draw |
| `keys` object | `InputMap` + `Input.get_action_strength()` | Actions |
| `mkPl/reset` | `Player.tscn` reset method | Instance from scene |
| `mkBul` | `Bullet.tscn` instance + pool | `Area2D` |
| `mkEn` with pat | `Enemy.tscn` + `AnimationPlayer` | Pattern-driven animation |
| `mkBoss` | `Boss.tscn` | Multi-phase AnimationTree |
| `mkParts` | `GPUParticles2D` burst | GPU compute |
| `blip()` | `AudioStreamGenerator` or WAV | Pre-generated or procedural |
| `sfxFloppySeek()` | `AudioStreamGenerator` | Procedural noise |
| `boot()` | `BootScreen.tscn` with Timer | Typewriter via visible_characters |
| `startMatrixRain()` | `matrix_rain.gdshader` | GLSL shader on ColorRect |
| CRT barrel SVG | `crt_overlay.gdshader` | Full GLSL post-processing |
| Screen shake | `Camera2D` offset → Tween | Built-in Camera2D |
| Raster tear | Shader uniform + animated clip | Scroll offset modulation |
| `localStorage` | `ConfigFile` → `user://` | Godot file system |
| `requestAnimationFrame` | `_process(delta)` | Engine-managed loop |
| Audio Context resume | Audio bus auto-init | Godot handles this |

---

## 7. PROFESSIONAL-GRADE UPGRADES (beyond 1:1)

1. **Scalable resolution** — Godot stretch modes handle 720p, 1080p, 4K cleanly. No manual canvas scaling.
2. **Gamepad support** — Free via InputMap. Add Xbox/PS layout detection.
3. **Accessibility** — Color blind mode (shader LUT swap), adjustable scanline intensity, screen shake toggle.
4. **Settings menu** — Volume sliders, fullscreen toggle, CRT effect intensity, key rebinding.
5. **Tween-based easing** — Smooth transitions instead of frame-count math.
6. **AnimationTree** — State machine for boss phases instead of if-else tower.
7. **Proper pause** — `get_tree().paused = true` with process_mode ALWAYS on menu.
8. **Scene transitions** — Fade-to-black between game states via ColorRect + AnimationPlayer.
9. **Error-resistant audio** — Audio bus volume control, mute on focus loss.
10. **Progressive enhancement** — Desktop = full CRT shader, Web = lighter variant for performance.
11. **Build pipeline** — GitHub Actions → auto-export to Windows + Web on tag.
12. **Itch.io / Steam-ready** — Proper icon, splash screen, window management.
