class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.style = {}; this.dataset = {}; this._cls = new Set(); this.textContent = ''; this.id = ''; }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(' '); }
  get classList() {
    const s = this._cls;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      contains: (c) => s.has(c),
      toggle: (c, on) => { const want = on === undefined ? !s.has(c) : !!on; want ? s.add(c) : s.delete(c); return want; },
    };
  }
  append(...ns) { for (const n of ns) { n.parentNode = this; this.children.push(n); } }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; }
}

const body = new El('body');
globalThis.document = { createElement: (t) => new El(t), getElementById: () => null, body };

const { createHUD } = await import('./src/render/hud.mjs');
const hud = createHUD();
hud.update({ score: 1234567, lives: 3, bombs: 2, power: 3, chain: 14, chainTimer: 60, stage: 1, rank: 1.25, gameOver: false, bossActive: true });
console.log('score', hud.nodes.score.textContent, '| lives pips', hud.nodes.lives.children.length, '| chain', hud.nodes.chain.textContent, '| chainFill', hud.nodes.chainFill.style.width);
hud.setBoss({ active: true, hp: 400, maxHp: 1000, phase: 2, phases: 3, name: 'midboss' });
console.log('bossFill', hud.nodes.bossFill.style.width, '| boss hidden?', hud.nodes.boss.classList.contains('hidden'));
hud.drain([{ type: 'extend' }, { type: 'bossPhase', phase: 3, phases: 3, hp: 100, maxHp: 1000 }, { type: 'powerup', kind: 'life' }]);
console.log('message', hud.nodes.message.textContent, '| shown?', !hud.nodes.message.classList.contains('hidden'));
hud.update({ score: 9, lives: 0, bombs: 0, power: 1, chain: 0, chainTimer: 0, stage: 1, rank: 1, gameOver: true, bossActive: false });
console.log('gameover shown?', !hud.nodes.gameOver.classList.contains('hidden'), '| boss hidden again?', hud.nodes.boss.classList.contains('hidden'));
hud.reset();
hud.destroy();
console.log('HUD SMOKE OK');
