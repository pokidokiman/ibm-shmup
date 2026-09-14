#!/usr/bin/env node
/**
 * Per-file gate: `node tools/check-file.mjs src/render/sprites.mjs [...]`
 * Parses each file and asserts it declares what its module contract promises.
 * Lets a task prove its own slice without needing the whole project finished.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length === 0) { console.error('usage: node tools/check-file.mjs <file.mjs> [...]'); process.exit(2); }

const REQUIRED_EXPORTS = {
  'src/core/clock.mjs': ['createClock'],
  'src/core/rng.mjs': ['createRng'],
  'src/core/vec2.mjs': ['add', 'sub', 'scale', 'len', 'norm', 'lerp', 'approach', 'angle', 'dist', 'fromAngle'],
  'src/core/input.mjs': ['createInput'],
  'src/core/pool.mjs': ['createPool'],
  'src/game/config.mjs': ['BALANCE', 'POWERUP_TABLE', 'STAGE_TABLE', 'ENEMY_TABLE'],
  'src/game/player.mjs': ['createPlayer'],
  'src/game/bullets.mjs': ['createBulletSystem'],
  'src/game/patterns.mjs': ['PATTERNS'],
  'src/game/enemies.mjs': ['createEnemy'],
  'src/game/waves.mjs': ['createStage'],
  'src/game/boss.mjs': ['createBoss'],
  'src/game/powerups.mjs': ['dropFor', 'applyPickup'],
  'src/game/scoring.mjs': ['addKill', 'addGraze'],
  'src/game/collision.mjs': ['circlesHit', 'createGrid'],
  'src/game/game.mjs': ['createGame'],
  'src/render/three-scene.mjs': ['createScene'],
  'src/render/sprites.mjs': ['createAtlas'],
  'src/render/background.mjs': ['createBackground'],
  'src/render/crt.mjs': ['createCRT'],
  'src/render/hud.mjs': ['createHUD'],
  'src/audio/sfx.mjs': ['createSfx'],
};

let fails = 0;
for (const a of args) {
  const file = a.split('\\').join('/').replace(/^\.\//, '');
  const abs = join(ROOT, file);
  if (!existsSync(abs)) { console.log(`  FAIL missing ${file}`); fails++; continue; }
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    console.log(`  ok   parses ${file}`);
  } catch (e) {
    console.log(`  FAIL syntax in ${file}: ${String(e.stderr || '').split('\n')[0].slice(0, 150)}`);
    fails++; continue;
  }
  const src = readFileSync(abs, 'utf8');
  if (/\bTODO\b|\bFIXME\b|not implemented/i.test(src)) { console.log(`  FAIL placeholder marker in ${file}`); fails++; }
  const want = REQUIRED_EXPORTS[file];
  if (want) {
    const missing = want.filter((n) => !new RegExp(`(export\\s+(async\\s+)?(function|const|let|class)\\s+${n}\\b)|(export\\s*\\{[^}]*\\b${n}\\b)`).test(src));
    if (missing.length) { console.log(`  FAIL ${file} does not export ${missing.join(', ')}`); fails++; }
    else console.log(`  ok   exports ${want.join(', ')}`);
  }
  if (file.startsWith('src/render/') || file.startsWith('src/audio/')) {
    if (!/\bfrom\s+['"]three['"]/.test(src) && file !== 'src/render/hud.mjs') { console.log(`  FAIL ${file} must build on three`); fails++; }
    if (/\b(https?:)?\/\/[^'"\s]+\.(png|jpg|jpeg|gif|mp3|wav|ogg|glb)/i.test(src)) { console.log(`  FAIL ${file} references a binary asset`); fails++; }
  }
  if (file.startsWith('src/core/') || file.startsWith('src/game/')) {
    if (/\bdocument\s*\.|\bwindow\s*\.|\bTHREE\./.test(src)) { console.log(`  FAIL ${file} must stay browser-free`); fails++; }
  }
}
console.log(fails === 0 ? 'PASS' : `FAIL — ${fails} problem(s)`);
process.exit(fails === 0 ? 0 : 1);
