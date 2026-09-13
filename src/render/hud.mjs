/**
 * src/render/hud.mjs — the machine fascia: binds GameState to Tailwind DOM.
 *
 * The simulation never knows this module exists. Once per rendered frame the
 * shell calls `hud.update(game.state, extras)` and, in the same tick,
 * `hud.drain(game.events)` so the HUD can react to things that happened between
 * two rendered frames (a powerup pickup, a boss phase change, an extend).
 *
 * Everything is Tailwind utility classes on plain DOM nodes so the HUD scales
 * with the CRT chrome in `index.html`; the only inline styles used are numeric
 * widths for the chain/boss/power bars, which are data, not design.
 *
 * Markup contract (all optional — missing nodes are created):
 *   <div id="hud">              preferred mount point, absolutely positioned
 *   <div id="hud-score">        score readout
 *   <div id="hud-lives">        life pips
 *   <div id="hud-bombs">        bomb pips
 *   <div id="hud-power">        power tier segments
 *   <div id="hud-chain">        chain counter
 *   <div id="hud-boss">         boss health bar (hidden while no boss lives)
 *
 * Node-only environments never reach this file (the purity rule keeps it out of
 * src/core and src/game), but `createHUD` still throws a clear error instead of
 * a `ReferenceError` if it is ever called without a document.
 */

/** Default chain window, matching BALANCE.chainTimeout in config.mjs. */
const DEFAULT_CHAIN_TIMEOUT = 120;
/** Upper bound of pip indicators; extra lives/bombs are summed into a "+n". */
const MAX_PIPS = 8;
/** Power tiers rendered in the bar (matches BALANCE.powerTiers). */
const MAX_TIERS = 4;

/* ------------------------------------------------------------------ helpers */

function fmtScore(value) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  return n.toString().padStart(9, '0');
}

function fmtCounter(value, width = 2) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  return n.toString().padStart(width, '0');
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function makeEl(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* --------------------------------------------------------------------- HUD */

/**
 * Build (or adopt) the HUD and return its binding API.
 *
 * @param {object} [options]
 * @param {Document} [options.document] explicit document (defaults to global)
 * @param {Element} [options.root] element to build the HUD inside
 * @param {Element} [options.host] alias for `root` (appended into)
 * @param {number} [options.chainTimeout=120] frames the chain window lasts
 * @param {number} [options.hiscore=0] initial high score
 * @returns {{
 *   root: Element,
 *   nodes: Record<string, Element>,
 *   update(state: object, extra?: object): any,
 *   drain(events: Array<object>): any,
 *   setBoss(info: object|null): any,
 *   flash(text: string, seconds?: number): any,
 *   setGameOver(on: boolean, score?: number): any,
 *   reset(): any,
 *   destroy(): void,
 * }}
 */
export function createHUD(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.createElement) {
    throw new Error('createHUD requires a document; the HUD is a DOM binding layer');
  }

  const chainTimeout = Number.isFinite(options.chainTimeout) && options.chainTimeout > 0
    ? options.chainTimeout
    : DEFAULT_CHAIN_TIMEOUT;

  let hiscore = Math.max(0, Math.floor(Number(options.hiscore) || 0));

  const host = options.root || options.host || doc.getElementById('hud') || doc.body;
  if (!host) throw new Error('createHUD found no mount point');

  /* ------------------------------------------------------------ scaffolding */

  const root = makeEl(
    doc,
    'div',
    'hud-root pointer-events-none absolute inset-0 z-20 select-none font-mono ' +
      'text-[11px] uppercase tracking-[0.18em] leading-tight text-[#7dff8a] ' +
      'drop-shadow-[0_0_6px_rgba(125,255,138,0.55)]',
  );
  root.id = 'hud-root';

  const topLeft = makeEl(doc, 'div', 'absolute left-4 top-3 space-y-1 text-left');
  const topRight = makeEl(doc, 'div', 'absolute right-4 top-3 space-y-1 text-right');
  const bottomLeft = makeEl(doc, 'div', 'absolute bottom-3 left-4 space-y-1.5 text-left');
  const bottomRight = makeEl(doc, 'div', 'absolute bottom-3 right-4 space-y-1.5 text-right');

  const line = (label) => makeEl(doc, 'div', 'flex items-baseline gap-2');
  const caption = (text) => makeEl(doc, 'span', 'text-[10px] text-[#2f8f4a]', text);
  const value = (id, text) => {
    const v = makeEl(doc, 'span', 'text-[#c9ffd2] tabular-nums', text);
    v.id = id;
    return v;
  };

  // SCORE
  const scoreLine = line();
  const scoreValue = value('hud-score', fmtScore(0));
  scoreLine.append(caption('score'), scoreValue);
  // HI-SCORE
  const hiLine = line();
  const hiValue = value('hud-hiscore', fmtScore(hiscore));
  hiLine.append(caption('hi'), hiValue);
  // CHAIN + window bar
  const chainLine = line();
  const chainValue = value('hud-chain', 'x0');
  chainLine.append(caption('chain'), chainValue);
  const chainTrack = makeEl(doc, 'div', 'mt-1 h-[3px] w-40 bg-[#10321c]');
  const chainFill = makeEl(doc, 'div', 'h-full w-0 bg-[#7dff8a] transition-[width] duration-75');
  chainTrack.append(chainFill);
  topLeft.append(scoreLine, hiLine, chainLine, chainTrack);

  // STAGE / RANK
  const stageLine = line();
  const stageValue = value('hud-stage', '1-1');
  stageLine.append(caption('stage'), stageValue);
  const rankLine = line();
  const rankValue = value('hud-rank', '1.00');
  rankLine.append(caption('rank'), rankValue);
  topRight.append(stageLine, rankLine);

  // LIVES / BOMBS pips
  const pipRow = (id, count, color, glow) => {
    const wrap = makeEl(doc, 'div', 'flex items-center gap-1.5');
    wrap.append(caption(id));
    const box = makeEl(doc, 'div', 'flex items-center gap-1');
    box.id = `hud-${id}`;
    const pips = [];
    for (let i = 0; i < MAX_PIPS; i++) {
      const pip = makeEl(doc, 'span', `inline-block h-2 w-2 ${color} ${glow}`);
      pip.dataset.pip = String(i);
      box.append(pip);
      pips.push(pip);
    }
    wrap.append(box);
    const extra = makeEl(doc, 'span', 'text-[10px] text-[#2f8f4a]', '');
    wrap.append(extra);
    return { wrap, box, pips, extra };
  };

  const lives = pipRow('lives', 3, 'bg-[#7dff8a]', 'shadow-[0_0_6px_rgba(125,255,138,0.8)]');
  const bombs = pipRow('bombs', 3, 'bg-[#7fe6ff]', 'shadow-[0_0_6px_rgba(127,230,255,0.8)]');
  bottomLeft.append(lives.wrap, bombs.wrap);

  // POWER tiers
  const powerWrap = makeEl(doc, 'div', 'flex items-center gap-1.5');
  powerWrap.append(caption('power'));
  const powerBox = makeEl(doc, 'div', 'flex items-end gap-0.5');
  powerBox.id = 'hud-power';
  const tiers = [];
  for (let i = 0; i < MAX_TIERS; i++) {
    const tier = makeEl(doc, 'span', 'inline-block w-2 bg-[#10321c]');
    tier.style.height = `${4 + i * 2}px`;
    powerBox.append(tier);
    tiers.push(tier);
  }
  const powerValue = value('hud-power-level', '1');
  powerWrap.append(powerBox, powerValue);
  bottomRight.append(powerWrap);

  // BOSS bar (hidden until a boss is on screen)
  const bossBar = makeEl(
    doc,
    'div',
    'absolute left-1/2 top-3 hidden w-[46%] -translate-x-1/2 text-center',
  );
  bossBar.id = 'hud-boss';
  const bossName = makeEl(doc, 'div', 'mb-1 text-[10px] tracking-[0.4em] text-[#ff9a3c]', 'warning');
  const bossTrack = makeEl(doc, 'div', 'h-[5px] w-full bg-[#3a1408]');
  const bossFill = makeEl(doc, 'div', 'h-full w-full bg-[#ff4d4d] shadow-[0_0_8px_rgba(255,77,77,0.9)]');
  bossTrack.append(bossFill);
  const bossMeta = makeEl(doc, 'div', 'mt-0.5 flex justify-between text-[9px] text-[#c46a12]');
  const bossPhase = makeEl(doc, 'span', '', 'phase 1/3');
  const bossHp = makeEl(doc, 'span', '', '');
  bossMeta.append(bossPhase, bossHp);
  bossBar.append(bossName, bossTrack, bossMeta);

  // Center message ("EXTEND!", "POWER UP", ...)
  const message = makeEl(
    doc,
    'div',
    'absolute left-1/2 top-[38%] hidden -translate-x-1/2 text-center text-[18px] ' +
      'tracking-[0.4em] text-[#fff7dd] drop-shadow-[0_0_10px_rgba(255,192,97,0.9)]',
  );
  message.id = 'hud-message';

  // Game over / continue prompt
  const gameOver = makeEl(
    doc,
    'div',
    'absolute inset-0 hidden flex-col items-center justify-center gap-2 ' +
      'bg-[rgba(1,4,1,0.72)] text-center',
  );
  gameOver.id = 'hud-gameover';
  const gameOverTitle = makeEl(doc, 'div', 'text-[28px] tracking-[0.6em] text-[#ff4d4d]', 'game over');
  const gameOverScore = makeEl(doc, 'div', 'text-[12px] tracking-[0.3em] text-[#7dff8a]', 'final 000000000');
  const gameOverHint = makeEl(doc, 'div', 'mt-2 text-[10px] tracking-[0.3em] text-[#2f8f4a]', 'press fire to retry');
  gameOver.append(gameOverTitle, gameOverScore, gameOverHint);

  root.append(topLeft, topRight, bottomLeft, bottomRight, bossBar, message, gameOver);
  host.append(root);

  /* ---------------------------------------------------------------- binding */

  let messageTimer = 0;
  let boss = null;
  let over = false;

  function paintPips(row, count) {
    const shown = Math.max(0, Math.min(MAX_PIPS, Math.floor(count) || 0));
    for (let i = 0; i < row.pips.length; i++) {
      row.pips[i].classList.toggle('opacity-20', i >= shown);
    }
    row.extra.textContent = count > MAX_PIPS ? `+${count - MAX_PIPS}` : '';
  }

  function paintTiers(power) {
    const level = Math.max(1, Math.min(MAX_TIERS, Math.floor(power) || 1));
    for (let i = 0; i < tiers.length; i++) {
      const lit = i < level;
      tiers[i].classList.toggle('bg-[#ffc061]', lit);
      tiers[i].classList.toggle('bg-[#10321c]', !lit);
    }
    powerValue.textContent = String(level);
  }

  function paintBoss() {
    if (!boss || !boss.active) {
      bossBar.classList.add('hidden');
      bossBar.classList.remove('flex');
      return;
    }
    bossBar.classList.remove('hidden');
    bossBar.classList.add('flex', 'flex-col');
    const max = Math.max(1, Number(boss.maxHp) || 1);
    const hp = Math.max(0, Number(boss.hp) || 0);
    bossFill.style.width = `${clamp01(hp / max) * 100}%`;
    bossName.textContent = boss.name || 'warning';
    const phase = Math.max(1, Math.floor(boss.phase) || 1);
    const phases = Math.max(phase, Math.floor(boss.phases) || 1);
    bossPhase.textContent = `phase ${phase}/${phases}`;
    bossHp.textContent = `${Math.ceil(hp)} / ${Math.ceil(max)}`;
  }

  function showGameOver(state) {
    over = true;
    const final = state && Number.isFinite(state.score) ? state.score : hiscore;
    gameOverScore.textContent = `final ${fmtScore(final)}`;
    gameOver.classList.remove('hidden');
    gameOver.classList.add('flex');
  }

  function hideGameOver() {
    over = false;
    gameOver.classList.add('hidden');
    gameOver.classList.remove('flex');
  }

  /** Show a centred transient message for `seconds` (default 1.2). */
  function flash(text, seconds = 1.2) {
    message.textContent = String(text);
    message.classList.remove('hidden');
    messageTimer = Math.max(0.1, Number(seconds) || 1.2);
    return api;
  }

  /**
   * Apply one frame of simulation state.
   *
   * @param {object} state `game.state` (score, lives, bombs, power, chain,
   *   chainTimer, stage, rank, gameOver, bossActive, ...)
   * @param {object} [extra] optional `{ boss, player, message }` overrides
   */
  function update(state, extra = {}) {
    const s = state || {};

    if (Number.isFinite(s.score) && s.score > hiscore) hiscore = Math.floor(s.score);
    scoreValue.textContent = fmtScore(s.score);
    hiValue.textContent = fmtScore(hiscore);

    const chain = Math.max(0, Math.floor(s.chain) || 0);
    chainValue.textContent = `x${chain}`;
    chainFill.style.width = `${clamp01((Number(s.chainTimer) || 0) / chainTimeout) * 100}%`;
    chainValue.classList.toggle('text-[#fff7dd]', chain >= 10);

    paintPips(lives, Number(s.lives) || 0);
    paintPips(bombs, Number(s.bombs) || 0);
    paintTiers(s.power);

    stageValue.textContent = String(s.stage ?? 1);
    rankValue.textContent = (Number.isFinite(s.rank) ? s.rank : 1).toFixed(2);

    if (extra.boss !== undefined) boss = extra.boss;
    else if (s.bossActive && !boss) boss = { active: true, hp: 1, maxHp: 1, phase: 1, phases: 1 };
    else if (!s.bossActive) boss = null;
    paintBoss();

    if (s.gameOver && !over) showGameOver(s);
    else if (!s.gameOver && over) hideGameOver();

    if (messageTimer > 0) {
      const dt = Number(extra.dt) || 1 / 60;
      messageTimer -= dt;
      if (messageTimer <= 0) message.classList.add('hidden');
    }
  }

  /**
   * React to simulation events drained from `game.events`. Unknown event types
   * are ignored so new gameplay features never break the HUD.
   */
  function drain(events) {
    if (!Array.isArray(events)) return;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      switch (ev.type) {
        case 'extend':
          flash('extend!');
          break;
        case 'powerup':
          flash(ev.kind === 'life' ? '1up' : ev.kind === 'bomb' ? 'bomb up' : 'power up');
          break;
        case 'bossPhase':
          flash(`phase ${ev.phase ?? ''}`.trim());
          if (ev.maxHp || ev.hp) {
            boss = { ...(boss || {}), active: true, phase: ev.phase, phases: ev.phases ?? boss?.phases, hp: ev.hp ?? boss?.hp, maxHp: ev.maxHp ?? boss?.maxHp };
          }
          break;
        case 'graze':
          break;
        default:
          break;
      }
    }
  }

  const api = {
    root,
    nodes: {
      score: scoreValue,
      hiscore: hiValue,
      chain: chainValue,
      chainFill,
      lives: lives.box,
      bombs: bombs.box,
      power: powerBox,
      boss: bossBar,
      bossFill,
      message,
      gameOver,
    },

    update,
    drain,

    /** Force the boss bar; pass `null` to hide it. */
    setBoss(info) {
      boss = info ? { ...info, active: info.active !== false } : null;
      paintBoss();
      return api;
    },

    /** Show a centred transient message for `seconds` (default 1.2). */
    flash,

    /** Toggle the game-over overlay explicitly. */
    setGameOver(on, score) {
      if (on) showGameOver({ score });
      else hideGameOver();
      return api;
    },

    /** Reset every readout to its boot value (new run / new stage). */
    reset() {
      update({
        score: 0,
        lives: 3,
        bombs: 3,
        power: 1,
        chain: 0,
        chainTimer: 0,
        stage: 1,
        rank: 1,
        gameOver: false,
        bossActive: false,
      });
      hiscore = 0;
      hiValue.textContent = fmtScore(0);
      message.classList.add('hidden');
      messageTimer = 0;
      return api;
    },

    /** Tear the HUD out of the document. */
    destroy() {
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };

  return api;
}

export default createHUD;
