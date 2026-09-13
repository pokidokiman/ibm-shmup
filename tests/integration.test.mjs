import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cross-file integration contract. The static per-file tests can pass while the page silently
// draws nothing, because the bootstrap calls methods on objects whose real API differs. This test
// compares what index.html CALLS against what each factory actually RETURNS.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Keys of every object literal returned by `export function <name>` in a module. */
function returnedKeys(src, factoryName) {
  const start = src.search(new RegExp(`export\\s+(async\\s+)?function\\s+${factoryName}\\b`));
  if (start === -1) return null;
  const body = src.slice(start);
  const keys = new Set();
  for (const m of body.matchAll(/return\s*\{([\s\S]*?)\n\s*\}/g)) {
    for (const line of m[1].split('\n')) {
      const k = line.match(/^\s*([A-Za-z_$][\w$]*)\s*[,:(]/);
      if (k) keys.add(k[1]);
      const s = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
      if (s) keys.add(s[1]);
    }
    const inline = m[1].match(/\{([^{}]*)\}/);
    if (inline) for (const part of inline[1].split(',')) {
      const k = part.trim().match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (k) keys.add(k[1]);
    }
  }
  return keys;
}

test('index.html only calls scene/hud/game methods that actually exist', () => {
  const html = read('index.html');
  const sceneSrc = read('src/render/three-scene.mjs');
  const hudSrc = read('src/render/hud.mjs');
  const gameSrc = read('src/game/game.mjs');

  const called = (varName) => {
    const out = new Set();
    for (const m of html.matchAll(new RegExp(`\\b${varName}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))) out.add(m[1]);
    return out;
  };

  const cases = [
    ['scene', called('scene'), returnedKeys(sceneSrc, 'createScene')],
    ['hud', called('hud'), returnedKeys(hudSrc, 'createHUD')],
    ['game', called('game'), returnedKeys(gameSrc, 'createGame')],
  ];

  for (const [name, calls, api] of cases) {
    assert.ok(calls.size > 0, `index.html never calls anything on ${name}()`);
    assert.ok(api && api.size > 0, `could not read the object returned by create${name[0].toUpperCase()}${name.slice(1)}`);
    const missing = [...calls].filter((c) => !api.has(c));
    assert.deepEqual(missing, [], `index.html calls ${name}.${missing.join('(), ' + name + '.')}() but that factory does not return it (returns: ${[...api].join(', ')})`);
  }
});

test('the frame loop actually steps the simulation and draws', () => {
  const html = read('index.html');
  assert.match(html, /requestAnimationFrame\s*\(\s*frame\s*\)/, 'the page must run a rAF loop');
  assert.match(html, /\bgame\.step\s*\(/, 'the loop must advance the simulation');
  assert.match(html, /\bscene\.draw\s*\(|\brender\s*\(/, 'the loop must draw the scene each frame');
  const declares = /actors\.push|declare|batch|\.push\s*\(/.test(html);
  assert.ok(declares, 'the loop must feed sprites to the renderer each frame');
});

test('render batches are populated from live game state, not hardcoded', () => {
  const html = read('index.html');
  assert.match(html, /game\.bullets/, 'player/enemy bullets must come from game state');
  assert.match(html, /game\.enemies/, 'enemies must come from game state');
  assert.match(html, /game\.player/, 'the player must come from game state');
});
