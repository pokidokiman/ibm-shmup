import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural integration contract for index.html.
//
// NOTE: do NOT try to prove "index.html calls a method the factory returns" by regex-parsing the
// factory's `return { ... }` block. These modules contain many nested returns, so such a parser
// silently reads the wrong one and reports methods as missing that exist. That mistake cost a
// wasted agent run chasing a phantom. Whether the page actually RENDERS is a runtime question and
// belongs to tools/smoke.mjs, which boots the page in headless Chrome.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('the frame loop steps the simulation and draws every frame', () => {
  const html = read('index.html');
  assert.match(html, /requestAnimationFrame\s*\(\s*frame\s*\)/, 'the page must run a rAF loop');
  assert.match(html, /\bgame\.step\s*\(/, 'the loop must advance the simulation');
  assert.match(html, /\bscene\.draw\s*\(/, 'the loop must draw the scene every frame');
  assert.match(html, /\bscene\.setProgress\s*\(/, 'the loop must feed stage progress to the renderer');
  assert.match(html, /\bhud\.update\s*\(/, 'the loop must refresh the HUD');
});

test('render batches are populated from live game state, not hardcoded', () => {
  const html = read('index.html');
  assert.match(html, /game\.bullets/, 'player/enemy bullets must come from game state');
  assert.match(html, /game\.enemies/, 'enemies must come from game state');
  assert.match(html, /game\.player/, 'the player must come from game state');
  assert.ok(!/\bTODO\b|\bFIXME\b|not implemented/i.test(html), 'no placeholders in the shipped page');
});
