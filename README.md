# IBM SHMUP

> *"A vertical scrolling shooter for the IBM 5153 terminal — but running in your browser."*

**IBM SHMUP** is a retro-futuristic shoot-'em-up rendered in green-on-black ASCII/block graphics, styled after the IBM 5153 CRT monitor. Fly, dodge, and blast through waves of enemies with chiptune audio and a phosphor glow that burns into your retina.

---

## Features

### Current
- **8-directional movement** — Arrow keys / ZQSD / WASD
- **Rapid fire** — hold Space or Z
- **3 enemy types** — grunts, tanks, elites with HP bars
- **Wave system** — increasingly difficult formations
- **Power-ups** — collect P to upgrade firepower (max level 4)
- **Combo multiplier** — chain kills for bonus score
- **CRT aesthetic** — scanlines, phosphor glow, green monochrome palette
- **Web Audio blips** — square-wave chiptune sound effects
- **Session high score** — saved in localStorage

### Planned
- Boss fights with multi-phase attack patterns
- Weapon pickups (laser, spread, homing, shield)
- Ship selection with different ASCII designs
- DMG-01 mode (160×144, 4-shade green palette)
- True IBM 5153 boot screen intro
- Two-player mode (shared keyboard)
- Replay recorder / ghost playback
- Procedural soundtrack that scales with intensity
- Online leaderboard (VPS-hosted JSON)

---

## Controls

| Key | Action |
|---|---|
| Arrow keys / ZQSD / WASD | Move |
| Space / Z | Fire (hold for rapid) |
| P | Pause / Resume |
| Space / Enter | Start game / Restart |

---

## Roadmap

```
v0.1 ── Initial release (current) ── basic shmup, waves, CRT style
v0.2 ── Boss fights, weapon pickups, DMG-01 mode
v0.3 ── Ship select, boot screen, leaderboard
v0.4 ── Two-player, replay system, procedural soundtrack
```

---

## Running locally

```bash
# Clone
git clone https://github.com/pokidokiman/ibm-shmup
cd ibm-shmup

# Serve (any static file server works)
python3 -m http.server 8080

# Open http://localhost:8080
```

No build tools, no dependencies, no frameworks. Just a browser.

---

## Project structure

```
ibm-shmup/
├── index.html        # Game entry point (HTML + embedded JS)
├── src/              # Future JS modules (when we split it up)
├── assets/           # Future sprites / sound files / data
├── .gitignore
└── README.md
```

---

## Tech

- **Canvas 2D** — rendering with custom CRT filters
- **Web Audio API** — oscillator-based SFX, no samples
- **localStorage** — high score persistence
- **Zero dependencies** — no npm, no build step, no frameworks

---

## License

MIT — do whatever you want with it.
