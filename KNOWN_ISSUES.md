# Known issues / open defects

## OPEN — sprite silhouettes read as "bitten" (a wedge/slice missing, consistently on the same side)

Reported repeatedly by the user and still visible to them as of commit `f1b55fc`. The agent could
not reproduce it in its own captures at the end, and reported it fixed three times on evidence that
was later shown to be unreliable. Treat this as UNRESOLVED.

### What has been RULED OUT (with evidence)

1. **Art clipping at the image border** — all 25 source PNGs audited for flat cuts; 0 sprites with a
   cut >= 3px after the v2 re-roll (`tools/art/make_sprite_set_v2.py` rejects a render whose bbox
   touches the frame and re-rolls it).
2. **Interior holes from the alpha key** — `alpha = 255 - min(r,g,b)` and any blanket white cutoff
   delete light pixels *inside* the sprite (cores, highlights). Fixed: the background is now the
   white region connected to the image border (flood fill), interior whites stay opaque
   (`tools/art/repost_sprites.py`).
3. **Atlas minification filter** — mip levels of an atlas average the whole sheet, so each cell
   blended with its transparent margins and its neighbours. Fixed: `minFilter = NearestFilter`,
   `generateMipmaps = false`, wrap clamped. Verified from the live page (`atlas.texture.minFilter`).
4. **The CRT post pass** — A/B'd with the uniforms neutralised (vignette/curvature/aberration/scan
   all zero); the artifact appeared in both halves, so it is not the post pass.
5. **Window size / device pixel ratio** — rendered at 1280x900, 1366x768, 1920x1080, 1920x1080@1.25
   and 2560x1440; the silhouette was the same at every scale.
6. **Simple-shape subjects** — the generator reliably mangles them: the round bullet came back a
   rounded square with a notch, fodder a blob with a bitten edge, the player shot an hourglass with
   V-notches. Those three now bypass the generated art entirely (`NO_ART` in `src/render/sprites.mjs`)
   and are drawn by the procedural painters.

### What is STILL SUSPECTED (untested, in priority order)

1. **The user's browser is running a cached build.** The atlas is built at boot, so a cached
   `index.html`/`sprites.mjs` keeps the old behaviour no matter what the files on disk say. First
   thing to check: open the page with a cache-busting query (`/index.html?x=1`), or DevTools →
   Network → Disable cache, then reload.
2. **A build the agent is not looking at.** The agent verified `http://127.0.0.1:8099/index.html`
   from `C:\Users\Jeffry\git\ibm-shmup`. If the user's window is a different server, port, copy of
   the repo, or a stale `file://` page, none of the fixes above apply to what they are looking at.
   Cheap check, in the browser console:
   ```js
   JSON.stringify({ src: [...document.scripts].map(s => s.src),
                    min: window.__shmup.scene.atlas.texture.minFilter,
                    mips: window.__shmup.scene.atlas.texture.generateMipmaps })
   ```
   `min: 1003` and `mips: false` means the current build is loaded.
3. **Something in the HUD/bezel DOM overlaying sprites** (a gradient or clipped element on the
   right side of the playfield). Not investigated.
4. **The composite/render path itself** — a sprite drawn with a UV inset or a rotated quad would cut
   it uniformly. Not investigated; `src/render/three-scene.mjs` `createSpriteBatch` writes u0/u1 and
   v0/v1 straight from `atlas.uv(name, frame)`.

### How to inspect at 1:1 (do this, do not trust a contact sheet)

The agent's vision pipeline downsizes large images, which averages exactly this kind of artifact
away — that is how the defect survived three "fix" rounds. Crop ONE cell/region and upscale it so
the final image stays under ~1000px, or measure pixels instead of looking:

```bash
# one atlas cell, 4x, holes/dashes visible
python -c "from PIL import Image; a=Image.open('shots/live_atlas.png'); a.crop((256,0,384,128)).resize((512,512),Image.NEAREST).save('cell_shot.png')"
```

Dump the live atlas (the engine's own texture, not the PNGs on disk):

```bash
uv run --no-project --python 3.12 --with websocket-client python C:/Users/Jeffry/atlas_dump.py
```

## Repo / branch state

- Repo: `C:\Users\Jeffry\git\ibm-shmup`, branch `rebuild/three-tailwind` (PR #3 open, `main` untouched).
- Game served at `http://127.0.0.1:8099/index.html` (static server, must be running).
- Art pipeline: `tools/art/make_sprite_set_v2.py` (generate, rejects clipped renders),
  `tools/art/repost_sprites.py` (border-connected alpha key).
- Verification tools: `tools/render_gate.py` (runtime gate: assets fetched, world drawn),
  `tools/aim_audit.mjs` (danmaku aimed-ness and bullet density).
- Danmaku was measured before/after the fixed-pattern rework: aimed-at-ship 68.9% -> 8.8%,
  peak bullets on screen 16 -> 68, survival standing still 16.3s -> 27.9s.
