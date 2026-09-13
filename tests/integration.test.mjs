import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural integration contract for index.html.
//
// NOTE: do NOT try to check "does index.html call a method the factory returns" by regex-parsing
// the factory's `return { ... }` block - these modules contain many nested returns, so the parser
// silently reads the wrong one and invents missing methods that exist. That mistake cost a wasted
// agent run. Whether the page actually RENDERS is a runtime question: use tools/smoke.mjs.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('the frame loop actually steps the simulation and draws', () => {
62|  const html = read('index.html');
63|  assert.match(html, /requestAnimationFrame\s*\(\s*frame\s*\)/, 'the page must run a rAF loop');
64|  assert.match(html, /\bgame\.step\s*\(/, 'the loop must advance the simulation');
65|  assert.match(html, /\bscene\.draw\s*\(|\brender\s*\(/, 'the loop must draw the scene each frame');
66|  const declares = /actors\.push|declare|batch|\.push\s*\(/.test(html);
67|  assert.ok(declares, 'the loop must feed sprites to the renderer each frame');
68|});
69|
70|test('render batches are populated from live game state, not hardcoded', () => {
71|  const html = read('index.html');
72|  assert.match(html, /game\.bullets/, 'player/enemy bullets must come from game state');
73|  assert.match(html, /game\.enemies/, 'enemies must come from game state');
74|  assert.match(html, /game\.player/, 'the player must come from game state');
75|});
76|