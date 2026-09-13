// Temporary smoke test: prove src/render/sprites.mjs paints its atlas and builds
// a CanvasTexture without a browser. Deleted after the run.
import {
  createAtlas,
  createSpriteAtlas,
  paintAtlas,
  drawSprite,
  spriteUv,
  SPRITE_LAYOUT,
  SPRITE_COUNT,
  SPRITE_NAMES,
  PALETTE,
} from './src/render/sprites.mjs';

const noop = () => {};
const ctx = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      return noop;
    },
    set() {
      return true;
    },
  }
);

const canvas = { width: 0, height: 0, getContext: (kind) => (kind === '2d' ? ctx : null) };
const doc = { createElement: (tag) => (tag === 'canvas' ? canvas : null) };

const atlas = createAtlas({ doc });
console.log('ok:', atlas.ok);
console.log('canvas sized:', canvas.width, canvas.height);
console.log('texture is CanvasTexture:', atlas.texture?.isCanvasTexture === true);
console.log('uv(player):', JSON.stringify(atlas.uv('player')));
console.log('uv(explosion,2):', JSON.stringify(spriteUv('explosion', 2)));
console.log('unknown sprite uv:', JSON.stringify(atlas.uv('nope')));
console.log('displaySize(bossCore):', atlas.displaySize('bossCore'));
console.log('frameCount(explosion):', atlas.frameCount('explosion'));
console.log('has(spark):', atlas.has('spark'), 'has(nope):', atlas.has('nope'));
console.log('cells:', SPRITE_COUNT, 'names:', SPRITE_NAMES.length);
console.log('repaint:', atlas.repaint());
atlas.dispose();
console.log('after dispose ok:', atlas.ok);
console.log('default export check:', typeof createSpriteAtlas, typeof paintAtlas, typeof drawSprite);
console.log('palette keys:', Object.keys(PALETTE).length);
console.log('layout head:', JSON.stringify(SPRITE_LAYOUT.slice(0, 3)));

// UV bounds sanity: every frame must sit inside [0,1] and be 64px wide.
let bad = 0;
for (const e of SPRITE_LAYOUT) {
  const r = atlas.rect(e.name, e.frame);
  const uv = atlas.uv(e.name, e.frame);
  if (r.w !== 64 || r.h !== 64) bad++;
  if (!(uv.u0 >= 0 && uv.u1 <= 1 && uv.v0 >= 0 && uv.v1 <= 1)) bad++;
  if (!(uv.u1 > uv.u0 && uv.v1 > uv.v0)) bad++;
}
console.log('uv/rect violations:', bad);
