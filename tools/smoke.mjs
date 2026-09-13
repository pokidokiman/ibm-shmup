#!/usr/bin/env node
/**
 * Runtime gate: proves the game actually RENDERS, not just that it loads.
 *
 * Static checks cannot see a black playfield, so this boots index.html in headless Chrome,
 * takes a screenshot, decodes the PNG itself (no dependencies) and looks ONLY at the playfield
 * region - the HUD text and the CRT bezel are bright even when nothing is being drawn, so they
 * must be excluded or the gate would pass on a black screen.
 */
import { createServer } from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.smoke-shot.png');
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
               '.css': 'text/css', '.json': 'application/json' };

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9];
      if (depth !== 8 || (ctype !== 2 && ctype !== 6)) throw new Error(`unsupported PNG (depth ${depth}, type ${ctype})`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      const v = line[x];
      cur[x] = ft === 0 ? v : ft === 1 ? (v + a) & 255 : ft === 2 ? (v + b) & 255
        : ft === 3 ? (v + ((a + b) >> 1)) & 255
        : (v + (Math.abs(b - c) <= Math.abs(a - c) ? (Math.abs(a - b) <= Math.abs(a - c) ? a : b) : (Math.abs(a - b) <= Math.abs(b - c) ? a : c))) & 255;
    }
  }
  return { w, h, ch, px: out };
}

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  try {
    const buf = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const CHROMES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const chrome = CHROMES.find((c) => c && existsSync(c));

let fails = 0;
const check = (ok, okMsg, badMsg) => { console.log(ok ? '  ok   ' + okMsg : '  FAIL ' + badMsg); if (!ok) fails++; };

if (!chrome) {
  console.log('  FAIL no chrome/edge binary available for the runtime gate');
  server.close(); process.exit(1);
}

// Two separate spawns with their own profiles: combining --screenshot with --dump-dom makes this
// Chrome build hang, and a shared profile dir deadlocks against any leftover instance.
const profileDir = join(ROOT, '.smoke-profile');
const baseArgs = ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
                  '--user-data-dir=' + profileDir];
const shot = () => {
  try {
    execFileSync(chrome, [...baseArgs, '--window-size=1024,768', '--screenshot=' + TMP,
                          `http://127.0.0.1:${port}/index.html`],
                 { stdio: ['ignore', 'ignore', 'ignore'], timeout: 90000 });
    return true;
  } catch { return existsSync(TMP); }
};

let dom = '';
if (!shot()) {
  console.log('  FAIL headless chrome could not render the page');
  server.close(); process.exit(1);
}
try {
  dom = execFileSync(chrome, [...baseArgs, '--virtual-time-budget=900', '--dump-dom',
                             `http://127.0.0.1:${port}/index.html`],
                     { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000,
                       stdio: ['ignore', 'pipe', 'ignore'] });
} catch { dom = ''; console.log('  ..   DOM dump unavailable (soft check skipped)'); }
server.close();

if (dom) {
  check(/<canvas[^>]*id="game-canvas"/i.test(dom), 'canvas #game-canvas present', 'canvas #game-canvas missing');
  check(/data-engine="three\.js/i.test(dom), 'three.js renderer initialised', 'three.js renderer never initialised');
  const hudMissing = ['score', 'lives', 'bombs', 'power', 'chain'].filter((id) => !dom.includes(`id="${id}"`));
  check(hudMissing.length === 0, 'HUD ids present (score,lives,bombs,power,chain)', 'HUD ids missing: ' + hudMissing.join(','));
}

if (!existsSync(TMP)) {
  check(false, 'screenshot captured', 'no screenshot produced - nothing could be rendered');
} else {
  const png = await readFile(TMP);
  const { w, h, ch, px } = decodePNG(png);
  // playfield window: skip the bezel, the in-canvas HUD strip (top ~12%) and the bottom HUD band
  const x0 = Math.floor(w * 0.10), x1 = Math.floor(w * 0.90);
  const y0 = Math.floor(h * 0.16), y1 = Math.floor(h * 0.86);
  let bright = 0, samples = 0, maxLum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * ch;
      const lum = Math.max(px[i], px[i + 1], px[i + 2]);
      if (lum > maxLum) maxLum = lum;
      if (lum > 24) bright++;
      samples++;
    }
  }
  const frac = bright / samples;
  console.log(`  ..   playfield ${x1 - x0}x${y1 - y0} = ${samples} px, bright(>24) = ${bright} (${(frac * 100).toFixed(3)}%), max luminance ${maxLum}/255`);
  check(frac > 0.0005, `playfield renders content (${(frac * 100).toFixed(3)}% lit)`,
        `playfield is BLACK (${(frac * 100).toFixed(3)}% lit, max ${maxLum}/255) - nothing is being drawn`);
}

await unlink(TMP).catch(() => {});
console.log(fails === 0 ? '\nPASS - the game renders its playfield.' : `\nFAIL - ${fails} runtime problem(s)`);
process.exit(fails === 0 ? 0 : 1);
