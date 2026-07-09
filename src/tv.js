// TV gameboard (ADR-004). /tv creates a lobby → /tv/CODE. Shows QR to /play/CODE,
// the roster, and a HIGHLIGHT MENU the host drives with their phone D-Pad (a
// moving highlight over discrete options — not a pointer). Game launch + the
// active/intermission phases land in the next slice.
import QRCode from 'qrcode';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });
import { initFirebase } from './firebase.js';
import { createSession, logTransition } from './session.js';
import { watchPlayers } from './players.js';
import { consumeEvents } from './engine.js';
import { validatePool, validateCategory, ENVIRONMENTS, KOTH_THRESHOLDS } from './hostconfig.js';

const el = (id) => document.getElementById(id);
const db = initFirebase();
const parts = location.pathname.split('/').filter(Boolean);
const lobbyId = parts[1] ? parts[1].toUpperCase() : null;

let players = [];
let hostId = null;

/* ---- highlight menu state ---- */
const config = { pool: { classic: true, hard: false, guess: false }, category: null, pveMode: 'koth', kothN: 5 };
let stack = ['main'];
let focus = 0;

const pop = () => { if (stack.length > 1) { stack.pop(); focus = 0; } };
const togglePve = () => { config.pveMode = config.pveMode === 'koth' ? 'lms' : 'koth'; };
const cycleKoth = (d) => { const i = KOTH_THRESHOLDS.indexOf(config.kothN); config.kothN = KOTH_THRESHOLDS[Math.min(KOTH_THRESHOLDS.length - 1, Math.max(0, i + d))]; };

const screens = {
  main: () => [
    { label: '▸ Game Pool', enter: 'pool' },
    { label: `▸ Category${config.category ? ':  ' + config.category.toUpperCase() : ''}`, enter: 'category' },
    { label: '▶ START GAME', onSelect: startGame }
  ],
  pool: () => [
    { label: `Classic       [${config.pool.classic ? '✓' : ' '}]`, onSelect: () => (config.pool.classic = !config.pool.classic) },
    { label: `Hard Classic  [${config.pool.hard ? '✓' : ' '}]`, onSelect: () => (config.pool.hard = !config.pool.hard) },
    { label: `Guess Timer   [${config.pool.guess ? '✓' : ' '}]`, onSelect: () => (config.pool.guess = !config.pool.guess) },
    { label: '◂ Back', onSelect: pop }
  ],
  category: () => [
    { label: `PvE Arcade ▸${config.category === 'pve' ? '  ✓' : ''}`, onSelect: () => (config.category = 'pve'), enter: 'pve' },
    { label: `PvP Tournament${config.category === 'pvp' ? '  ✓' : ''}`, onSelect: () => (config.category = 'pvp') },
    { label: `Teams Tournament${config.category === 'teams' ? '  ✓' : ''}`, onSelect: () => (config.category = 'teams') },
    { label: '◂ Back', onSelect: pop }
  ],
  pve: () => [
    { label: `Mode:  ${config.pveMode === 'koth' ? 'King of the Hill' : 'Last Man Standing'}   ◀ ▶`, onLeft: togglePve, onRight: togglePve },
    { label: `KOTH:  First to ${config.kothN}   ◀ ▶`, onLeft: () => cycleKoth(-1), onRight: () => cycleKoth(1) },
    { label: '◂ Back', onSelect: pop }
  ]
};

function onNav(dir) {
  const items = screens[stack[stack.length - 1]]();
  if (dir === 'up') focus = (focus - 1 + items.length) % items.length;
  else if (dir === 'down') focus = (focus + 1) % items.length;
  else if (dir === 'left') items[focus].onLeft?.();
  else if (dir === 'right') items[focus].onRight?.();
  else if (dir === 'select') { const it = items[focus]; it.onSelect?.(); if (it.enter) { stack.push(it.enter); focus = 0; } }
  else if (dir === 'back') pop();
  render();
}

function startGame() {
  const pool = Object.entries(config.pool).filter(([, v]) => v).map(([k]) => k);
  const pc = players.filter((p) => p.connected !== false).length;
  const pv = validatePool(ENVIRONMENTS.PARTY, pool);
  if (!pv.ok) return msg(pv.reason);
  if (!config.category) return msg('Pick a category first.');
  const cv = validateCategory(config.category, pc);
  if (!cv.ok) return msg(cv.reason);
  const detail = config.category === 'pve' ? ` · ${config.pveMode === 'koth' ? 'KOTH first to ' + config.kothN : 'Last Man Standing'}` : '';
  msg(`✅ Ready: ${config.category.toUpperCase()} · pool [${pool.join(', ')}]${detail}. (Game launch is the next build.)`);
  logTransition('tv', 'setup', 'start-requested', `${config.category} pool=${pool.join('+')}`);
}

function msg(t) { el('tv-menu-msg').textContent = t; }

function render() {
  const menu = el('tv-menu');
  if (!hostId) { menu.hidden = true; return; }
  menu.hidden = false;
  const items = screens[stack[stack.length - 1]]();
  if (focus >= items.length) focus = items.length - 1;
  const list = el('tv-menu-list');
  list.innerHTML = '';
  items.forEach((it, i) => {
    const li = document.createElement('li');
    li.textContent = it.label;
    if (i === focus) li.classList.add('focused');
    list.appendChild(li);
  });
}

async function boot() {
  if (!lobbyId) { const { code } = await createSession(db); logTransition('tv', 'boot', 'created', `room ${code}`); location.replace(`/tv/${code}`); return; }
  el('room-code').textContent = lobbyId;
  const joinUrl = `${location.origin}/play/${lobbyId}`;
  el('join-url').textContent = joinUrl.replace(/^https?:\/\//, '');
  await QRCode.toCanvas(el('qr'), joinUrl, { width: 320, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0d0f14', light: '#ffffff' } });
  el('status').textContent = 'Waiting for players…';
  watchPlayers(db, lobbyId, (list) => {
    players = list;
    hostId = (list.find((p) => p.uid) || {}).playerId || null;
    const ul = el('player-list'); ul.innerHTML = '';
    list.forEach((p) => { const li = document.createElement('li'); li.textContent = (hostId === p.playerId ? '⭐ ' : '') + (p.connected === false ? `⚠ ${p.name}` : p.name); li.classList.toggle('offline', p.connected === false); ul.appendChild(li); });
    el('players-empty').hidden = list.length > 0;
    el('status').textContent = list.length ? `${list.length} in the lobby${hostId ? '' : ' — waiting for a signed-in host'}` : 'Waiting for players…';
    render();
  });
  consumeEvents(db, lobbyId, (ev) => { if (ev.type === 'nav' && ev.playerId === hostId && ev.dir) onNav(ev.dir); });
  logTransition('tv', 'boot', 'lobby', `room ${lobbyId}`);
}
boot();
