import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static contract tests: render/audio layers import three and touch the DOM, so they cannot be
// imported in Node. Their contracts are checked structurally instead.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('the render layer builds on three and generates its own textures', () => {
  for (const f of ['src/render/three-scene.mjs', 'src/render/sprites.mjs', 'src/render/background.mjs', 'src/render/crt.mjs']) {
    assert.ok(existsSync(join(ROOT, f)), `${f} must exist`);
    const src = read(f);
    assert.match(src, /from\s+['"]three['"]/, `${f} must import three`);
    assert.ok(!/\b(https?:)?\/\/[^'"\s]+\.(png|jpg|jpeg|gif|wav|mp3)/i.test(src), `${f} must not fetch binary assets`);
  }
  const sprites = read('src/render/sprites.mjs');
  assert.match(sprites, /CanvasTexture|DataTexture/, 'sprites must be generated procedurally');
  assert.match(sprites, /export\s+(async\s+)?(function|const)\s+createAtlas/, 'createAtlas must be exported');
  const crt = read('src/render/crt.mjs');
  for (const token of ['uScan', 'uCurv', 'uTime', 'vignette']) {
    assert.ok(crt.toLowerCase().includes(token.toLowerCase()), `CRT shader must expose ${token}`);
  }
  const scene = read('src/render/three-scene.mjs');
  assert.match(scene, /WebGLRenderer/, 'must own a WebGLRenderer');
  assert.match(scene, /OrthographicCamera/, 'a shmup plays on an orthographic camera');
});

test('the HUD binds every gameplay readout', () => {
  const hud = read('src/render/hud.mjs');
  assert.match(hud, /export\s+(async\s+)?(function|const)\s+createHUD/);
  for (const id of ['score', 'lives', 'bombs', 'power', 'chain']) {
    assert.ok(hud.toLowerCase().includes(id), `HUD must render ${id}`);
  }
});

test('audio is procedural WebAudio with no samples', () => {
  const sfx = read('src/audio/sfx.mjs');
  assert.match(sfx, /AudioContext|webkitAudioContext/, 'sfx must use WebAudio');
  assert.match(sfx, /export\s+(async\s+)?(function|const)\s+createSfx/);
  for (const name of ['shot', 'hit', 'boom', 'pickup', 'bomb']) {
    assert.ok(sfx.includes(name), `sfx must expose ${name}`);
  }
  assert.ok(!/\.(mp3|wav|ogg)['"]/.test(sfx), 'no audio files may be referenced');
});

test('index.html is the whole bundle: tailwind, three importmap, canvas, module bootstrap', () => {
  const html = read('index.html');
  assert.match(html, /cdn\.tailwindcss\.com|tailwindcss@/i, 'Tailwind via CDN');
  assert.match(html, /type=["']importmap["']/i, 'importmap required for module three');
  assert.match(html, /"three"\s*:\s*"/i, 'importmap must map three');
  assert.match(html, /id=["']game-canvas["']/i, 'canvas#game-canvas required');
  assert.match(html, /src\/render\/three-scene\.mjs/, 'must boot the three scene');
  assert.match(html, /src\/render\/hud\.mjs/, 'must boot the HUD');
  assert.ok(!/\bTODO\b|\bFIXME\b|not implemented/i.test(html), 'no placeholders in the shipped page');
});
