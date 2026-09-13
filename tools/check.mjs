#!/usr/bin/env node
/**
 * Structural verifier for the ibm-shmup rebuild.
 * Exits 0 only when the bundle is complete, parseable, and architecturally pure.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(ROOT, p).split('\\').join('/');
const fails = [];
const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => { fails.push(m); console.log('  FAIL ' + m); };

const REQUIRED = [
  'index.html', 'README.md', 'docs/SPEC.md',
  'src/core/clock.mjs', 'src/core/rng.mjs', 'src/core/vec2.mjs', 'src/core/input.mjs', 'src/core/pool.mjs',
  'src/game/config.mjs', 'src/game/player.mjs', 'src/game/bullets.mjs', 'src/game/patterns.mjs',
  'src/game/enemies.mjs', 'src/game/waves.mjs', 'src/game/boss.mjs', 'src/game/powerups.mjs',
  'src/game/scoring.mjs', 'src/game/collision.mjs', 'src/game/game.mjs',
  'src/render/three-scene.mjs', 'src/render/sprites.mjs', 'src/render/background.mjs',
  'src/render/crt.mjs', 'src/render/hud.mjs', 'src/audio/sfx.mjs',
  'tests/core.test.mjs', 'tests/patterns.test.mjs', 'tests/game.test.mjs', 'tests/config.test.mjs',
];

for (const f of REQUIRED) (existsSync(join(ROOT, f)) ? ok : bad)('file ' + f);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

// every module must parse as ESM
for (const f of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tools')), ...walk(join(ROOT, 'tests'))]) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    ok('parses ' + rel(f));
  } catch (e) {
    bad('syntax error in ' + rel(f) + ': ' + String(e.stderr || '').split('\n').slice(0, 2).join(' ').slice(0, 180));
  }
}

// architecture purity: core + game are browser-free and three-free
const BANNED = [
  [/\bfrom\s+['"]three['"]/, 'imports three'],
  [/\bimport\s*\(\s*['"]three/, 'dynamic-imports three'],
  [/\bTHREE\./, 'uses THREE'],
  [/\bdocument\s*\./, 'touches document'],
  [/\bwindow\s*\./, 'touches window'],
  [/\brequestAnimationFrame\b/, 'schedules rAF'],
  [/\bsetTimeout\b|\bsetInterval\b/, 'uses timers'],
  [/\bWebGL|getContext\s*\(/, 'touches a graphics context'],
];
for (const d of ['src/core', 'src/game']) {
  for (const f of walk(join(ROOT, d))) {
    const src = readFileSync(f, 'utf8');
    for (const [re, why] of BANNED) if (re.test(src)) bad(`purity: ${rel(f)} ${why}`);
  }
}
ok('purity scan finished (src/core + src/game must be DOM/three free)');

// index.html contract
const htmlPath = join(ROOT, 'index.html');
if (existsSync(htmlPath)) {
  const html = readFileSync(htmlPath, 'utf8');
  const marks = [
    [/cdn\.tailwindcss\.com|tailwindcss@/i, 'Tailwind CDN'],
    [/<script[^>]+type=["']importmap["']/i, 'importmap'],
    [/"three"\s*:\s*"/i, 'three importmap entry'],
    [/id=["']game-canvas["']/i, '#game-canvas'],
    [/type=["']module["']/i, 'module script'],
    [/src\/render\/three-scene\.mjs/, 'boots three-scene'],
    [/src\/render\/hud\.mjs/, 'boots hud'],
  ];
  for (const [re, label] of marks) (re.test(html) ? ok : bad)('index.html has ' + label);
  if (/\bTODO\b|\bFIXME\b|not implemented/i.test(html)) bad('index.html contains a placeholder marker');
}

// no placeholders anywhere in src
for (const f of walk(join(ROOT, 'src'))) {
  const src = readFileSync(f, 'utf8');
  if (/\bTODO\b|\bFIXME\b|not implemented|\bstub\b/i.test(src)) bad('placeholder marker in ' + rel(f));
}
ok('placeholder scan finished');

// balance contract
try {
  const { BALANCE, POWERUP_TABLE, STAGE_TABLE } = await import(pathToFileURL(join(ROOT, 'src/game/config.mjs')).href);
  const near = (v, t, eps, label) => (typeof v === 'number' && Math.abs(v - t) <= eps ? ok : bad)(`BALANCE ${label} ~ ${t} (got ${v})`);
  near(BALANCE.player.speed, 4.2, 0.3, 'player.speed');
  near(BALANCE.player.focusSpeed, 1.9, 0.3, 'player.focusSpeed');
  if (BALANCE.player.hitR === 2) ok('BALANCE player.hitR === 2'); else bad(`BALANCE player.hitR must be 2 (got ${BALANCE.player.hitR})`);
  if (BALANCE.chainTimeout === 120) ok('BALANCE chainTimeout === 120'); else bad(`BALANCE chainTimeout must be 120 (got ${BALANCE.chainTimeout})`);
  if (BALANCE.extendScore === 2000000) ok('BALANCE extendScore === 2000000'); else bad(`BALANCE extendScore must be 2000000 (got ${BALANCE.extendScore})`);
  if (BALANCE.powerTiers === 4) ok('BALANCE powerTiers === 4'); else bad(`BALANCE powerTiers must be 4 (got ${BALANCE.powerTiers})`);
  if ((BALANCE.bossPhases ?? 0) >= 3) ok('BALANCE bossPhases >= 3'); else bad(`BALANCE bossPhases must be >= 3 (got ${BALANCE.bossPhases})`);
  if (Array.isArray(POWERUP_TABLE) && POWERUP_TABLE.length === 4) ok('POWERUP_TABLE has 4 tiers'); else bad('POWERUP_TABLE must list 4 tiers');
  if (Array.isArray(STAGE_TABLE) && STAGE_TABLE.length >= 3) ok('STAGE_TABLE has >= 3 stages'); else bad('STAGE_TABLE must list >= 3 stages');
  const s = STAGE_TABLE?.[0];
  if (s && s.midbossAt > 0.3 && s.midbossAt < 0.8) ok('stage 1 midboss at 30-80%'); else bad(`STAGE_TABLE[0].midbossAt should sit mid-stage (got ${s?.midbossAt})`);
} catch (e) {
  bad('cannot import src/game/config.mjs: ' + String(e.message).slice(0, 140));
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — ${fails.length} problem(s)`);
process.exit(fails.length === 0 ? 0 : 1);
